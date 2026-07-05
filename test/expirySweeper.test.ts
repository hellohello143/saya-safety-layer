import { describe, it, expect, beforeEach, vi } from 'vitest';

// Enable Solana before any import triggers loadEnv, and mock the on-chain module
// so the sweeper exercises the DB + adapter orchestration without real RPC.
const h = vi.hoisted(() => {
  process.env.SOLANA_NETWORK = 'solana-devnet';
  return { revokeSolanaSessionKey: vi.fn(async () => 'revoke-sig-123') };
});
vi.mock('../src/solana/session.js', () => ({
  revokeSolanaSessionKey: h.revokeSolanaSessionKey,
  issueSolanaSessionKey: vi.fn(),
  readSolanaOnchainStatus: vi.fn(),
  executeSolanaPayment: vi.fn(),
  buildSolanaPaymentHeader: vi.fn(),
  getSolanaTreasury: vi.fn(),
  getSolanaSpender: vi.fn(),
  usdcAtaOf: vi.fn(),
  fundSolana: vi.fn(),
  verifySolanaSettlement: vi.fn(),
  SolanaOnchainError: class extends Error {},
}));

import { getDb } from '../src/db/client.js';
import { sweepExpiredSolanaSessions } from '../src/solana/expirySweeper.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import type { NewSessionRow } from '../src/db/schema.js';

const repo = new SessionRepository();
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  getDb().exec('DELETE FROM sessions;');
  h.revokeSolanaSessionKey.mockClear();
});

function solSession(over: Partial<NewSessionRow> = {}) {
  return repo.create({
    id: 's1',
    agentId: 'sol-agent',
    status: 'active',
    network: 'solana-devnet',
    smartAccountAddress: 'TREASURYowner',
    spenderAddress: 'DELEGATEaddr',
    tokenAddress: 'MINT',
    tokenAccount: 'TREASURY_ATA',
    permissionHash: 'approveSig',
    maxAmountPerTx: '1',
    maxAmountTotal: '1000000',
    expiresAt: now() - 10, // expired by default
    allowedRecipients: [],
    higherRisk: true,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: 'approveSig',
    revokeTxHash: null,
    ...over,
  });
}

describe('Solana expiry sweeper (enforces expiry on-chain)', () => {
  it('revokes an expired active Solana session on-chain and marks it expired', async () => {
    await solSession();
    const n = await sweepExpiredSolanaSessions();
    expect(n).toBe(1);
    // delegate cleared on-chain via the session's token account
    expect(h.revokeSolanaSessionKey).toHaveBeenCalledWith('TREASURY_ATA', 'DELEGATEaddr');
    const s = await repo.getById('s1');
    expect(s?.status).toBe('expired');
    expect(s?.revokeTxHash).toBe('revoke-sig-123');
  });

  it('leaves an unexpired Solana session untouched', async () => {
    await solSession({ expiresAt: now() + 3600 });
    const n = await sweepExpiredSolanaSessions();
    expect(n).toBe(0);
    expect(h.revokeSolanaSessionKey).not.toHaveBeenCalled();
    expect((await repo.getById('s1'))?.status).toBe('active');
  });

  it('ignores expired EVM sessions — their expiry is enforced on-chain by the contract', async () => {
    await solSession({ network: 'base-sepolia', tokenAccount: null, expiresAt: now() - 10 });
    const n = await sweepExpiredSolanaSessions();
    expect(n).toBe(0);
    expect(h.revokeSolanaSessionKey).not.toHaveBeenCalled();
  });

  it('does not re-touch an already-expired session', async () => {
    await solSession({ status: 'expired' });
    const n = await sweepExpiredSolanaSessions();
    expect(n).toBe(0);
    expect(h.revokeSolanaSessionKey).not.toHaveBeenCalled();
  });
});
