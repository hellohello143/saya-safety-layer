// x402 payment middleware (spec §2). Given a payment intent (session id + target
// URL) it:
//   1. requests the target URL,
//   2. on HTTP 402, parses x402 payment requirements,
//   3. validates against the session policy BEFORE signing (fail fast, structured),
//   4. if valid: reserves the amount (race-free), pulls capped funds to the spender
//      on-chain (hop 1), settles the merchant leg + retries with the payment proof
//      (hop 2), and returns the resource,
//   5. logs EVERY attempt to the audit log — no path skips logging.
//
// Fund flow (TRUST_BOUNDARY.md): CDP spend() delivers to the SPENDER, not the
// merchant payTo, so payment is two hops. The permission never pays merchants
// directly.

import { SessionRepository } from '../db/repositories/sessionRepository.js';
import { evaluatePolicy, type PaymentIntent } from '../policy/policyEngine.js';
import { checkBreaker, tripBreaker, beginInFlight, endInFlight } from '../policy/circuitBreaker.js';
import { recordIntent } from '../audit/auditLog.js';
import { adapterFor } from '../chains/index.js';
import { PaymentError } from '../chains/types.js';
import { loadEnv } from '../config/env.js';
import { selectRequirement, type Http402Body, type SelectedRequirement } from './types.js';
import type { RejectionReason } from '../policy/reasonCodes.js';

const sessionRepo = new SessionRepository();

// Raw on-chain error messages (from viem/CDP/Solana) can embed RPC endpoint URLs
// and internal addresses. Only surface them to the (untrusted-by-design) caller
// when the whole deployment is testnet; on mainnet they are logged server-side
// and redacted from the response.
const _env = loadEnv();
const EXPOSE_DETAIL = _env.IS_TESTNET && (!_env.SOLANA_ENABLED || _env.SOLANA_IS_TESTNET);

/**
 * SSRF guard. The target URL is caller-supplied and its response body can be
 * returned verbatim (the no-payment path), so it must be a PUBLIC http(s) URL —
 * never an internal/loopback/link-local host (e.g. cloud metadata at 169.254.169.254).
 * Host matching is on literals only (no DNS resolution): sync, and it keeps the
 * mocked-fetch tests (bare hostnames) working.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 ULA/link-local
  return false;
}

function isSafeTargetUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isBlockedHost(u.hostname);
}

export interface PayRequest {
  sessionId: string;
  targetUrl: string;
  method?: string;
}

export interface PayResult {
  status: 'approved' | 'rejected_policy' | 'rejected_onchain';
  reason?: RejectionReason;
  detail?: string; // underlying on-chain error message (for debugging)
  txHash?: string;
  resource?: unknown;
  riskFlags?: string[];
  attemptsInWindow?: number;
}

async function readBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  try {
    return ct.includes('application/json') ? await res.json() : await res.text();
  } catch {
    return null;
  }
}

/** Attempt to pay for and fetch an x402-protected resource under a session's policy. */
export async function payForResource(req: PayRequest): Promise<PayResult> {
  const session = await sessionRepo.getById(req.sessionId);
  const baseRisk = session?.higherRisk ? ['no_allowlist_session'] : [];
  let inFlightHeld = false;

  // Always log exactly one audit row per terminal path (spec §2.5). The in-flight
  // release happens AFTER the row commits so the breaker's live count never dips
  // below the true concurrent load.
  const finish = async (
    result: PayResult,
    fields: { amount?: bigint; recipient?: string } = {},
  ): Promise<PayResult> => {
    await recordIntent({
      sessionId: session?.id,
      agentId: session?.agentId ?? req.sessionId,
      network: session?.network,
      targetUrl: req.targetUrl,
      requestedAmount: fields.amount,
      recipient: fields.recipient,
      decision: result.status,
      reasonCode: result.reason,
      riskFlags: result.riskFlags,
      txHash: result.txHash,
      onchainStatus: result.txHash ? 'confirmed' : undefined,
    });
    if (inFlightHeld && session) {
      endInFlight(session.id);
      inFlightHeld = false;
    }
    return result;
  };

  if (!session) {
    return finish({ status: 'rejected_policy', reason: 'SESSION_NOT_FOUND' });
  }

  // Circuit breaker: count prior attempts in the window BEFORE logging this one.
  const breaker = checkBreaker(session.id);
  if (breaker.tripped) {
    let tripRisk = baseRisk;
    try {
      await tripBreaker(session.id); // suspend + REAL on-chain revoke + flag
    } catch {
      // On-chain revoke failed. tripBreaker suspends + flags BEFORE attempting the
      // revoke, so spend is already halted; we must still log the trip. Surface the
      // revoke failure as a risk flag rather than letting the throw skip the audit.
      tripRisk = [...baseRisk, 'onchain_revoke_failed'];
    }
    return finish({
      status: 'rejected_policy',
      reason: 'RATE_LIMIT_TRIPPED',
      riskFlags: tripRisk,
      attemptsInWindow: breaker.attemptsInWindow,
    });
  }
  // Passed the breaker: count this attempt as in-flight until its audit row commits.
  beginInFlight(session.id);
  inFlightHeld = true;

  // Liveness + SSRF guard BEFORE any outbound request. Only an active, unexpired
  // session may drive a fetch (the no-payment path returns the body verbatim, so a
  // non-active session must not reach it), and the target must be a public http(s)
  // URL. Policy re-checks status authoritatively on the 402 path; this closes the
  // no-payment path too.
  if (session.status !== 'active' || Math.floor(Date.now() / 1000) >= session.expiresAt) {
    const reason: RejectionReason =
      session.status === 'revoked'
        ? 'SESSION_REVOKED'
        : session.status === 'suspended'
          ? 'SESSION_SUSPENDED'
          : 'SESSION_EXPIRED';
    return finish({ status: 'rejected_policy', reason, riskFlags: baseRisk });
  }
  if (!isSafeTargetUrl(req.targetUrl)) {
    return finish({ status: 'rejected_policy', reason: 'INVALID_TARGET_URL', riskFlags: baseRisk });
  }

  // 1. Request the target.
  let res: Response;
  try {
    res = await fetch(req.targetUrl, { method: req.method ?? 'GET' });
  } catch {
    // Seller unreachable (DNS/connect/TLS) — no chain interaction happened, so this
    // is NOT an on-chain error; keep the on-chain-failure signal in the audit clean.
    return finish({ status: 'rejected_onchain', reason: 'TARGET_UNREACHABLE', riskFlags: baseRisk });
  }

  // No payment required -> return the resource, no spend. A non-2xx (500/403/404)
  // is still surfaced but flagged so it isn't mistaken for a delivered resource.
  if (res.status !== 402) {
    const resource = await readBody(res);
    const flags = res.ok ? baseRisk : [...baseRisk, 'target_error_status'];
    return finish({ status: 'approved', resource, riskFlags: flags });
  }

  // 2. Parse the 402 payment requirements. selectRequirement is hardened against
  //    malformed amounts; the try/catch is defense-in-depth so a malicious seller
  //    can never make an attempt escape the audit log with an unstructured 500.
  const body = (await readBody(res)) as Http402Body | null;
  let requirement: SelectedRequirement | null = null;
  try {
    // Select the requirement for THIS session's chain AND token (the seller may
    // list several options; prefer the one we can actually pay).
    requirement = body ? selectRequirement(body, session.network, session.tokenAddress) : null;
  } catch {
    requirement = null;
  }
  if (!requirement) {
    return finish({ status: 'rejected_policy', reason: 'NO_PAYMENT_REQUIREMENTS', riskFlags: baseRisk });
  }

  const intent: PaymentIntent = {
    sessionId: session.id,
    agentId: session.agentId,
    targetUrl: req.targetUrl,
    amount: requirement.amount,
    recipient: requirement.recipient,
    asset: requirement.asset,
    network: requirement.network,
  };
  const auditFields = { amount: intent.amount, recipient: intent.recipient };

  // 3. Policy (soft) — validate before signing (expected network = the session's chain).
  const decision = evaluatePolicy(session, intent, session.network);
  if (!decision.ok) {
    return finish({ status: 'rejected_policy', reason: decision.reason, riskFlags: decision.riskFlags }, auditFields);
  }

  // 4. Reserve the amount (race-free) against the total cap.
  const reserved = sessionRepo.reserveSpend(session.id, intent.amount);
  if (!reserved.ok) {
    const reason: RejectionReason =
      reserved.reason === 'EXCEEDS_TOTAL_LIMIT' ? 'EXCEEDS_TOTAL_LIMIT' : 'SESSION_SUSPENDED';
    return finish({ status: 'rejected_policy', reason, riskFlags: decision.riskFlags }, auditFields);
  }

  // 5. On-chain payment via the chain adapter (EVM two-hop / Solana single-hop).
  //    PaymentError.capConsumed tells us whether to release the reserve.
  let settlement: { settlementTxHash: string; paymentHeader: string };
  try {
    settlement = await adapterFor(session.network).executePayment(session, {
      amount: intent.amount,
      recipient: intent.recipient,
      asset: intent.asset,
    });
  } catch (err) {
    const message = (err as Error).message;
    // Log the raw cause server-side regardless; only return it to the caller on testnet.
    console.error(`[pay] on-chain failure for session ${session.id}: ${message}`);
    const detail = EXPOSE_DETAIL ? message : undefined;
    if (err instanceof PaymentError) {
      if (!err.capConsumed) sessionRepo.releaseSpend(session.id, intent.amount);
      return finish(
        { status: 'rejected_onchain', reason: err.reason, detail, riskFlags: [...decision.riskFlags, ...err.riskFlags] },
        auditFields,
      );
    }
    sessionRepo.releaseSpend(session.id, intent.amount);
    return finish(
      { status: 'rejected_onchain', reason: 'ONCHAIN_ERROR', detail, riskFlags: decision.riskFlags },
      auditFields,
    );
  }

  // 6. Retry with the X-PAYMENT proof so the seller verifies the settlement on-chain.
  let resource: unknown = null;
  let delivered = true;
  try {
    const paid = await fetch(req.targetUrl, {
      method: req.method ?? 'GET',
      headers: { 'X-PAYMENT': settlement.paymentHeader },
    });
    resource = await readBody(paid);
    delivered = paid.ok; // any 2xx = seller served the resource after confirming payment
  } catch {
    delivered = false; // resource fetch failed after settlement; funds already paid
  }

  // The merchant WAS paid on-chain (settlementTxHash). Record it as the audit tx.
  const riskFlags = delivered ? decision.riskFlags : [...decision.riskFlags, 'resource_not_delivered'];
  return finish(
    { status: 'approved', txHash: settlement.settlementTxHash, resource, riskFlags },
    auditFields,
  );
}
