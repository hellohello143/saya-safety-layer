import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db/client.js';
import { AuditRepository } from '../src/db/repositories/auditRepository.js';

const repo = new AuditRepository();
beforeEach(() => getDb().exec('DELETE FROM sessions; DELETE FROM audit_log;'));

const now = () => Math.floor(Date.now() / 1000);
let n = 0;
function rec(over: Record<string, unknown> = {}) {
  return repo.record({
    id: 'x' + n++,
    sessionId: 's1',
    agentId: 'a1',
    timestamp: now(),
    decision: 'approved',
    ...over,
  } as any);
}

describe('AuditRepository (node:sqlite)', () => {
  it('record + getById round-trips risk flags and status', async () => {
    await rec({ id: 'r1', riskFlags: ['no_allowlist_session'], onchainStatus: 'confirmed', txHash: '0xtx' });
    const got = await repo.getById('r1');
    expect(got?.riskFlags).toEqual(['no_allowlist_session']);
    expect(got?.onchainStatus).toBe('confirmed');
    expect(got?.txHash).toBe('0xtx');
  });

  it('query filters by agent, decision, and time range', async () => {
    await rec({ agentId: 'a1', decision: 'approved' });
    await rec({ agentId: 'a1', decision: 'rejected_policy', reasonCode: 'EXCEEDS_PER_TX_LIMIT' });
    await rec({ agentId: 'a2', decision: 'approved' });
    expect((await repo.query({ agentId: 'a1' })).length).toBe(2);
    expect((await repo.query({ decision: 'rejected_policy' })).length).toBe(1);
    expect((await repo.query({ from: now() - 5, to: now() + 5 })).length).toBe(3);
    expect((await repo.query({ from: now() + 100 })).length).toBe(0);
  });

  it('updateOnchainStatus updates status + txHash', async () => {
    await rec({ id: 'r1', onchainStatus: 'pending' });
    await repo.updateOnchainStatus('r1', 'confirmed', '0xabc');
    const g = await repo.getById('r1');
    expect(g?.onchainStatus).toBe('confirmed');
    expect(g?.txHash).toBe('0xabc');
  });

  it('countAttemptsSince counts rows in the window (circuit-breaker basis)', async () => {
    for (let i = 0; i < 7; i++) await rec({ sessionId: 'sX' });
    expect(repo.countAttemptsSince('sX', now() - 60)).toBe(7);
    expect(repo.countAttemptsSince('sX', now() + 100)).toBe(0);
    expect(repo.countAttemptsSince('other', now() - 60)).toBe(0);
  });
});
