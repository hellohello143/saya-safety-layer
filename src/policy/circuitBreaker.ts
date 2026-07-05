// Circuit breaker. Counts ALL payment ATTEMPTS (not just successes) per session
// in a rolling window (default 10 / 60s, configurable via env). Attempts are
// counted from the audit_log, which records every intent, so the count survives
// restarts and can't drift from what actually happened. On trip:
//   1. auto-suspend the session,
//   2. REVOKE the session key on-chain (real revocation, not a DB flag),
//   3. mark flagged_for_review.
// Spec §3.

import { loadEnv } from '../config/env.js';
import { AuditRepository } from '../db/repositories/auditRepository.js';
import { SessionRepository } from '../db/repositories/sessionRepository.js';
import { adapterFor } from '../chains/index.js';

const auditRepo = new AuditRepository();
const sessionRepo = new SessionRepository();

export interface TripResult {
  tripped: boolean;
  attemptsInWindow: number; // prior committed attempts + in-flight ones
}

// In-process count of attempts that have passed the breaker check but not yet
// written their audit row. The audit row is the durable count, but it is written
// only at the END of a payment (after a multi-second on-chain leg), so a burst of
// concurrent requests would all read the same low committed count and slip past.
// Counting in-flight attempts closes that window. (Single-process design.)
const inFlight = new Map<string, number>();

export function beginInFlight(sessionId: string): void {
  inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
}

export function endInFlight(sessionId: string): void {
  const n = (inFlight.get(sessionId) ?? 0) - 1;
  if (n > 0) inFlight.set(sessionId, n);
  else inFlight.delete(sessionId);
}

/**
 * Report whether recording another attempt should trip the breaker. Call this
 * BEFORE logging the current intent: it counts prior intents in the window (both
 * committed to the audit log and currently in flight), and if that count already
 * meets the max, this (the max+1'th) attempt trips it.
 */
export function checkBreaker(sessionId: string): TripResult {
  const env = loadEnv();
  const since = Math.floor(Date.now() / 1000) - env.CIRCUIT_BREAKER_WINDOW_SECONDS;
  const active = auditRepo.countAttemptsSince(sessionId, since) + (inFlight.get(sessionId) ?? 0);
  return { tripped: active >= env.CIRCUIT_BREAKER_MAX_ATTEMPTS, attemptsInWindow: active };
}

/**
 * Execute the trip actions: suspend + flag immediately (stop further spend fast),
 * then perform REAL on-chain revocation and record the revoke tx hash. Idempotent
 * enough for repeated trips (revoke of an already-revoked permission is a no-op
 * on-chain). Returns the revoke tx hash if revocation ran.
 */
export async function tripBreaker(sessionId: string): Promise<{ revokeTxHash?: string }> {
  const session = await sessionRepo.getById(sessionId);
  if (!session) return {};

  // Already revoked by a prior trip: the hard limit is enforced on-chain. Do NOT
  // downgrade the status back to 'suspended' (that would misrepresent an
  // on-chain-revoked session) or re-submit a redundant, gas-costing revoke — just
  // make sure it stays flagged for review.
  if (session.status === 'revoked') {
    if (!session.flaggedForReview) {
      await sessionRepo.updateStatus(sessionId, 'revoked', { flaggedForReview: true });
    }
    return {};
  }

  // 1 + 3: suspend and flag immediately (halt further spend fast).
  await sessionRepo.updateStatus(sessionId, 'suspended', { flaggedForReview: true });

  // 2: real on-chain revocation via the session's chain adapter (EVM revoke() or
  //    Solana Revoke). Flip to revoked only after it confirms.
  const hasOnchainRef = session.permissionHash || session.tokenAccount;
  if (hasOnchainRef) {
    const { revokeTxHash } = await adapterFor(session.network).revokeSessionKeyOnchain(session);
    await sessionRepo.updateStatus(sessionId, 'revoked', { revokeTxHash, flaggedForReview: true });
    return { revokeTxHash };
  }
  return {};
}
