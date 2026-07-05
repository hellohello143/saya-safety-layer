// Solana expiry enforcement.
//
// SPL token delegation has NO on-chain time bound, so `expiresAt` on Solana is
// otherwise only soft-enforced (the backend refuses to sign after expiry). That
// leaves a live on-chain delegation, with its full remaining allowance, until
// something revokes it — a gap if this backend is bypassed or down.
//
// This sweeper closes that gap: it periodically issues a REAL on-chain Revoke for
// every active Solana session past its expiry, so the delegate is cleared
// on-chain at expiry regardless of the backend. Running it on boot also catches
// sessions that expired while the process was down. (EVM needs none of this —
// `SpendPermission.end` is enforced by the contract on every spend.)
//
// Single-process design: this uses an in-process timer. Running multiple
// instances would issue redundant (idempotent) revokes; see the README
// "Deployment & scaling" section.

import { SessionRepository } from '../db/repositories/sessionRepository.js';
import { isSolanaNetwork } from '../config/network.js';
import { adapterFor } from '../chains/index.js';

const repo = new SessionRepository();

export const EXPIRY_SWEEP_SECONDS = 30;

/**
 * Revoke every active Solana session that is past its expiry, on-chain. Returns
 * the number revoked. Failures are logged and left active for the next sweep.
 */
export async function sweepExpiredSolanaSessions(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const active = await repo.list({ status: 'active' });
  const due = active.filter((s) => isSolanaNetwork(s.network) && s.expiresAt <= now && s.tokenAccount);
  let revoked = 0;
  for (const s of due) {
    try {
      const { revokeTxHash } = await adapterFor(s.network).revokeSessionKeyOnchain(s);
      await repo.updateStatus(s.id, 'expired', { revokeTxHash });
      revoked++;
      console.log(`[expiry] Solana session ${s.id} expired — revoked on-chain (tx ${revokeTxHash})`);
    } catch (err) {
      // Leave it active; the next sweep retries. The policy layer still refuses to
      // sign for it in the meantime, so no expired session can spend.
      console.error(`[expiry] failed to revoke expired Solana session ${s.id}: ${(err as Error).message}`);
    }
  }
  return revoked;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

async function safeSweep(): Promise<void> {
  if (sweeping) return; // a revoke can take ~18s to confirm; never overlap sweeps
  sweeping = true;
  try {
    await sweepExpiredSolanaSessions();
  } catch (err) {
    console.error(`[expiry] sweep failed: ${(err as Error).message}`);
  } finally {
    sweeping = false;
  }
}

/** Start the periodic expiry sweep (idempotent). Sweeps once now, then every EXPIRY_SWEEP_SECONDS. */
export function startExpirySweeper(): void {
  if (timer) return;
  void safeSweep(); // immediate: catch sessions that expired while the process was down
  timer = setInterval(() => void safeSweep(), EXPIRY_SWEEP_SECONDS * 1000);
  if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive for this alone
}

/** Stop the sweeper (for tests / graceful shutdown). */
export function stopExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
