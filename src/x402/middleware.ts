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
import { checkBreaker, tripBreaker } from '../policy/circuitBreaker.js';
import { recordIntent } from '../audit/auditLog.js';
import { adapterFor } from '../chains/index.js';
import { PaymentError } from '../chains/types.js';
import { selectRequirement, type Http402Body, type SelectedRequirement } from './types.js';
import type { RejectionReason } from '../policy/reasonCodes.js';

const sessionRepo = new SessionRepository();

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

  // Always log exactly one audit row per terminal path (spec §2.5).
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

  // 1. Request the target.
  let res: Response;
  try {
    res = await fetch(req.targetUrl, { method: req.method ?? 'GET' });
  } catch {
    return finish({ status: 'rejected_onchain', reason: 'ONCHAIN_ERROR', riskFlags: baseRisk });
  }

  // No payment required -> return the resource, no spend.
  if (res.status !== 402) {
    const resource = await readBody(res);
    return finish({ status: 'approved', resource, riskFlags: baseRisk });
  }

  // 2. Parse the 402 payment requirements. selectRequirement is hardened against
  //    malformed amounts; the try/catch is defense-in-depth so a malicious seller
  //    can never make an attempt escape the audit log with an unstructured 500.
  const body = (await readBody(res)) as Http402Body | null;
  let requirement: SelectedRequirement | null = null;
  try {
    // Select the requirement for THIS session's chain (the seller lists one per network).
    requirement = body ? selectRequirement(body, session.network) : null;
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
    if (err instanceof PaymentError) {
      if (!err.capConsumed) sessionRepo.releaseSpend(session.id, intent.amount);
      return finish(
        { status: 'rejected_onchain', reason: err.reason, detail: err.message, riskFlags: [...decision.riskFlags, ...err.riskFlags] },
        auditFields,
      );
    }
    sessionRepo.releaseSpend(session.id, intent.amount);
    return finish(
      { status: 'rejected_onchain', reason: 'ONCHAIN_ERROR', detail: (err as Error).message, riskFlags: decision.riskFlags },
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
    delivered = paid.status === 200; // seller confirmed the on-chain payment
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
