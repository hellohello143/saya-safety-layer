import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the on-chain revoke so tripBreaker exercises the DB + orchestration only.
vi.mock('../src/cdp/spendPermissions.js', () => ({
  revokeSessionKeyOnchain: vi.fn(async () => ({ revokeTxHash: '0xrevoke' })),
}));

import { getDb } from '../src/db/client.js';
import { checkBreaker, tripBreaker, beginInFlight, endInFlight } from '../src/policy/circuitBreaker.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import { recordIntent } from '../src/audit/auditLog.js';
import { revokeSessionKeyOnchain } from '../src/cdp/spendPermissions.js';
import type { NewSessionRow } from '../src/db/schema.js';

const repo = new SessionRepository();
beforeEach(() => getDb().exec('DELETE FROM sessions; DELETE FROM audit_log; DELETE FROM breaker_inflight;'));

async function attempts(sessionId: string, n: number) {
  for (let i = 0; i < n; i++) await recordIntent({ sessionId, agentId: 'a', decision: 'approved' });
}
function session(over: Partial<NewSessionRow> = {}) {
  return repo.create({
    id: 's1',
    agentId: 'a',
    status: 'active',
    smartAccountAddress: '0xaa',
    spenderAddress: '0xbb',
    tokenAddress: '0xU',
    permissionHash: '0xh',
    maxAmountPerTx: '1',
    maxAmountTotal: '1000000',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    allowedRecipients: [],
    higherRisk: true,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: null,
    revokeTxHash: null,
    ...over,
  });
}

describe('circuit breaker (rolling window over audit attempts)', () => {
  it('does not trip below the attempt threshold', async () => {
    await attempts('s1', 9);
    expect(checkBreaker('s1').tripped).toBe(false);
  });

  it('trips once prior attempts in the window reach the max (default 10)', async () => {
    await attempts('s1', 10);
    const r = checkBreaker('s1');
    expect(r.tripped).toBe(true);
    expect(r.attemptsInWindow).toBe(10);
  });

  it('counts in-flight attempts (not yet committed to the audit log) toward the trip', async () => {
    await attempts('s1', 8); // 8 committed
    expect(checkBreaker('s1').tripped).toBe(false);
    // Two concurrent attempts pass the check but haven't written their rows yet.
    const a = beginInFlight('s1');
    const b = beginInFlight('s1');
    const r = checkBreaker('s1');
    expect(r.attemptsInWindow).toBe(10); // 8 committed + 2 in-flight
    expect(r.tripped).toBe(true);
    // Releasing them (their rows would have committed instead) drops the live count.
    endInFlight(a);
    endInFlight(b);
    expect(checkBreaker('s1').attemptsInWindow).toBe(8);
  });

  it('tripBreaker suspends, revokes on-chain, and flags for review', async () => {
    await session();
    const { revokeTxHash } = await tripBreaker('s1');
    expect(revokeSessionKeyOnchain).toHaveBeenCalledWith('0xaa', '0xh');
    expect(revokeTxHash).toBe('0xrevoke');
    const s = await repo.getById('s1');
    expect(s?.status).toBe('revoked');
    expect(s?.flaggedForReview).toBe(true);
    expect(s?.revokeTxHash).toBe('0xrevoke');
  });
});
