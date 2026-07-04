import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db/client.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import { usdcToBaseUnits } from '../src/money/usdc.js';
import type { NewSessionRow } from '../src/db/schema.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function newRow(over: Partial<NewSessionRow> = {}): NewSessionRow {
  return {
    id: 's' + Math.random().toString(36).slice(2),
    agentId: 'a',
    status: 'active',
    smartAccountAddress: '0xaa',
    spenderAddress: '0xbb',
    tokenAddress: USDC,
    permissionHash: '0xh',
    maxAmountPerTx: usdcToBaseUnits('0.05').toString(),
    maxAmountTotal: usdcToBaseUnits('1.00').toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    allowedRecipients: ['0xM'],
    higherRisk: false,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: '0xc',
    revokeTxHash: null,
    ...over,
  };
}

const repo = new SessionRepository();
beforeEach(() => getDb().exec('DELETE FROM sessions; DELETE FROM audit_log;'));

describe('SessionRepository (node:sqlite)', () => {
  it('create + getById round-trips typed fields (json array, booleans, money)', async () => {
    await repo.create(newRow({ id: 's1', allowedRecipients: ['0xM1', '0xM2'], higherRisk: true }));
    const got = await repo.getById('s1');
    expect(got?.allowedRecipients).toEqual(['0xM1', '0xM2']);
    expect(got?.higherRisk).toBe(true);
    expect(got?.maxAmountTotal).toBe(usdcToBaseUnits('1.00').toString());
    expect(typeof got?.expiresAt).toBe('number');
  });

  it('list filters by agent and status', async () => {
    await repo.create(newRow({ id: 's1', agentId: 'x', status: 'active' }));
    await repo.create(newRow({ id: 's2', agentId: 'x', status: 'revoked' }));
    await repo.create(newRow({ id: 's3', agentId: 'y', status: 'active' }));
    expect((await repo.list({ agentId: 'x' })).length).toBe(2);
    expect((await repo.list({ status: 'active' })).length).toBe(2);
    expect((await repo.list({ agentId: 'x', status: 'active' })).length).toBe(1);
  });

  it('updateStatus sets status + revokeTxHash + flag', async () => {
    await repo.create(newRow({ id: 's1' }));
    await repo.updateStatus('s1', 'revoked', { revokeTxHash: '0xr', flaggedForReview: true });
    const g = await repo.getById('s1');
    expect(g?.status).toBe('revoked');
    expect(g?.revokeTxHash).toBe('0xr');
    expect(g?.flaggedForReview).toBe(true);
  });

  it('reserveSpend is race-free against the total cap', async () => {
    await repo.create(newRow({ id: 's1', maxAmountTotal: usdcToBaseUnits('1.00').toString() }));
    expect(repo.reserveSpend('s1', usdcToBaseUnits('0.6'))).toEqual({ ok: true });
    expect(repo.reserveSpend('s1', usdcToBaseUnits('0.6'))).toEqual({ ok: false, reason: 'EXCEEDS_TOTAL_LIMIT' });
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe(usdcToBaseUnits('0.6').toString());
  });

  it('reserveSpend rejects inactive sessions and missing sessions', async () => {
    await repo.create(newRow({ id: 's1', status: 'suspended' }));
    expect(repo.reserveSpend('s1', 1n)).toEqual({ ok: false, reason: 'SESSION_NOT_ACTIVE' });
    expect(repo.reserveSpend('nope', 1n)).toEqual({ ok: false, reason: 'SESSION_NOT_FOUND' });
  });

  it('releaseSpend compensates a prior reserve', async () => {
    await repo.create(newRow({ id: 's1' }));
    repo.reserveSpend('s1', usdcToBaseUnits('0.5'));
    repo.releaseSpend('s1', usdcToBaseUnits('0.2'));
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe(usdcToBaseUnits('0.3').toString());
  });
});
