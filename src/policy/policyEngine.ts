// Policy engine (the SOFT layer). Validates a parsed x402 payment intent against
// a session's policy BEFORE signing, returning a structured decision with a
// machine-readable reason code (spec §2.3). Fail-fast for clean errors; the
// on-chain permission remains the backstop for expiry + total cap.
//
// Reminder (TRUST_BOUNDARY.md): per-tx and recipient checks here are SOFT — the
// contract does not enforce them. This function is their only enforcement point.

import type { RejectionReason } from './reasonCodes.js';
import type { SessionRow } from '../db/schema.js';

export interface PaymentIntent {
  sessionId: string;
  agentId: string;
  targetUrl: string;
  amount: bigint; // base units
  recipient: string; // x402 payTo
  asset: string; // token address the seller wants
  network: string; // e.g. 'base-sepolia'
}

export type PolicyDecision =
  | { ok: true; riskFlags: string[] }
  | { ok: false; reason: RejectionReason; riskFlags: string[] };

// Address equality that respects each chain's rules. EVM hex addresses are
// case-insensitive (EIP-55 checksum is just capitalization), so compare
// lowercased. Solana base58 addresses are CASE-SENSITIVE — two strings differing
// only in case are DIFFERENT pubkeys — so they must match exactly. Getting this
// wrong would silently weaken the recipient allowlist on Solana (its only
// enforcement point). Treat "both sides 0x-hex" as EVM; everything else exact.
const eqAddr = (a: string, b: string) => {
  const bothHex = a.startsWith('0x') && b.startsWith('0x');
  return bothHex ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/**
 * Validate an intent against a session. `expectedNetwork` is the session's own
 * chain id (EVM *or* Solana — e.g. 'base', 'solana-devnet'); an intent whose
 * requirement targets a different chain is rejected WRONG_NETWORK. Pure +
 * synchronous, and must handle both hex (EVM) and base58 (Solana) addresses.
 * The authoritative total-cap check is reserveSpend() (race-free); the check
 * here is a fast preliminary that returns the same reason code.
 */
export function evaluatePolicy(
  session: SessionRow,
  intent: PaymentIntent,
  expectedNetwork: string,
): PolicyDecision {
  const riskFlags: string[] = [];
  if (session.higherRisk) riskFlags.push('no_allowlist_session');

  // 0. amount sanity — a zero (or, defensively, negative) seller amount must never
  //    be treated as an approved spend. selectRequirement already rejects
  //    malformed/negative amounts; this catches an explicit "0".
  if (intent.amount <= 0n) return { ok: false, reason: 'INVALID_AMOUNT', riskFlags };

  // 1. session status
  if (session.status === 'revoked') return { ok: false, reason: 'SESSION_REVOKED', riskFlags };
  if (session.status === 'suspended') return { ok: false, reason: 'SESSION_SUSPENDED', riskFlags };
  if (session.status === 'expired') return { ok: false, reason: 'SESSION_EXPIRED', riskFlags };
  if (session.status !== 'active') return { ok: false, reason: 'SESSION_SUSPENDED', riskFlags };

  // 2. expiry (time-based, independent of stored status)
  if (Math.floor(Date.now() / 1000) >= session.expiresAt) {
    return { ok: false, reason: 'SESSION_EXPIRED', riskFlags };
  }

  // 3. network
  if (intent.network !== expectedNetwork) {
    return { ok: false, reason: 'WRONG_NETWORK', riskFlags };
  }

  // 4. asset (seller must want the session's token — USDC)
  if (!eqAddr(intent.asset, session.tokenAddress)) {
    return { ok: false, reason: 'WRONG_ASSET', riskFlags };
  }

  // 5. per-tx cap (SOFT — no on-chain field)
  if (intent.amount > BigInt(session.maxAmountPerTx)) {
    return { ok: false, reason: 'EXCEEDS_PER_TX_LIMIT', riskFlags };
  }

  // 6. total cap (preliminary; reserveSpend is authoritative + race-free)
  if (BigInt(session.cumulativeSpent) + intent.amount > BigInt(session.maxAmountTotal)) {
    return { ok: false, reason: 'EXCEEDS_TOTAL_LIMIT', riskFlags };
  }

  // 7. recipient allowlist (SOFT — no on-chain field). Empty list => allow but
  //    the higher_risk flag (added above) travels with the approval.
  if (session.allowedRecipients.length > 0) {
    const allowed = session.allowedRecipients.some((a) => eqAddr(a, intent.recipient));
    if (!allowed) return { ok: false, reason: 'RECIPIENT_NOT_ALLOWED', riskFlags };
  }

  return { ok: true, riskFlags };
}
