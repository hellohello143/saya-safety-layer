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
  attemptsInWindow: number; // prior attempts already recorded in the window
}

/**
 * Report whether recording another attempt should trip the breaker. Call this
 * BEFORE logging the current intent: it counts prior intents in the window, and
 * if that count already meets the max, this (the max+1'th) attempt trips it.
 */
export function checkBreaker(sessionId: string): TripResult {
  const env = loadEnv();
  const since = Math.floor(Date.now() / 1000) - env.CIRCUIT_BREAKER_WINDOW_SECONDS;
  const prior = auditRepo.countAttemptsSince(sessionId, since);
  return { tripped: prior >= env.CIRCUIT_BREAKER_MAX_ATTEMPTS, attemptsInWindow: prior };
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

  // 1 + 3: suspend and flag immediately.
  await sessionRepo.updateStatus(sessionId, 'suspended', { flaggedForReview: true });

  // 2: real on-chain revocation via the session's chain adapter (EVM revoke() or
  //    Solana Revoke). Flip to revoked only after it confirms.
  const hasOnchainRef = session.permissionHash || session.tokenAccount;
  if (hasOnchainRef && session.status !== 'revoked') {
    const { revokeTxHash } = await adapterFor(session.network).revokeSessionKeyOnchain(session);
    await sessionRepo.updateStatus(sessionId, 'revoked', { revokeTxHash, flaggedForReview: true });
    return { revokeTxHash };
  }
  return {};
}
