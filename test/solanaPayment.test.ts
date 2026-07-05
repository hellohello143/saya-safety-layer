import { describe, it, expect, beforeEach, vi } from 'vitest';

// Enable Solana for this file BEFORE any import triggers loadEnv (vi.hoisted runs
// before imports; setup.ts sets it 'off' globally, and several modules cache env
// at import time via module-level repo construction).
const h = vi.hoisted(() => {
  process.env.SOLANA_NETWORK = 'solana-devnet';
  return {
    executeSolanaPayment: vi.fn(),
    buildSolanaPaymentHeader: vi.fn(() => 'solhdr'),
  };
});

// Mock the Solana on-chain module (the adapter calls into it). Stub the rest so
// the import graph resolves.
vi.mock('../src/solana/session.js', () => ({
  executeSolanaPayment: h.executeSolanaPayment,
  buildSolanaPaymentHeader: h.buildSolanaPaymentHeader,
  issueSolanaSessionKey: vi.fn(),
  revokeSolanaSessionKey: vi.fn(),
  readSolanaOnchainStatus: vi.fn(),
  getSolanaTreasury: vi.fn(),
  getSolanaSpender: vi.fn(),
  usdcAtaOf: vi.fn(),
  fundSolana: vi.fn(),
  verifySolanaSettlement: vi.fn(),
  SolanaOnchainError: class extends Error {},
}));

import { getDb } from '../src/db/client.js';
import { payForResource } from '../src/x402/middleware.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import { queryAudit } from '../src/audit/auditLog.js';
import { usdcToBaseUnits } from '../src/money/usdc.js';
import type { NewSessionRow } from '../src/db/schema.js';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MERCHANT = '3KzDtddx4i53FBkvCzuDmRbaMozTZoJBb1TToWhz3JfE';
const TREASURY_ATA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const repo = new SessionRepository();

function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
const challenge = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', network: 'solana-devnet', maxAmountRequired: '10000', resource: 'r', payTo: MERCHANT, asset: MINT }],
};

function solSession(over: Partial<NewSessionRow> = {}) {
  return repo.create({
    id: 's1',
    agentId: 'sol-agent',
    status: 'active',
    network: 'solana-devnet',
    smartAccountAddress: 'TREASURYowner',
    spenderAddress: 'DELEGATEaddr',
    tokenAddress: MINT,
    tokenAccount: TREASURY_ATA,
    permissionHash: 'approveSig',
    maxAmountPerTx: usdcToBaseUnits('0.05').toString(),
    maxAmountTotal: usdcToBaseUnits('1.00').toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    allowedRecipients: [], // empty => higher_risk; any recipient allowed
    higherRisk: true,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: 'approveSig',
    revokeTxHash: null,
    ...over,
  });
}

beforeEach(() => {
  getDb().exec('DELETE FROM sessions; DELETE FROM audit_log;');
  h.executeSolanaPayment.mockReset().mockResolvedValue({ signature: 'solsig123' });
  h.buildSolanaPaymentHeader.mockReset().mockReturnValue('solhdr');
  global.fetch = vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) =>
    init?.headers?.['X-PAYMENT'] ? mockResponse(200, { ok: true, resource: 'x' }) : mockResponse(402, challenge),
  ) as unknown as typeof fetch;
});

describe('Solana payment routing (single-hop)', () => {
  it('routes a solana session to a single-hop transfer and approves with the signature', async () => {
    await solSession();
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });
    expect(r.status).toBe('approved');
    expect(r.txHash).toBe('solsig123');
    // delegate transfers from the treasury ATA to the merchant for the price;
    // the delegate address is passed so a retry can detect a landed prior attempt.
    expect(h.executeSolanaPayment).toHaveBeenCalledWith(TREASURY_ATA, MERCHANT, usdcToBaseUnits('0.01'), 'DELEGATEaddr');
    const audit = await queryAudit({ sessionId: 's1' });
    expect(audit[0]!.network).toBe('solana-devnet');
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe('10000');
  });

  it('on transfer failure: rejected_onchain and the reserve is RELEASED (single-hop, nothing spent)', async () => {
    await solSession();
    h.executeSolanaPayment.mockRejectedValueOnce(new Error('blockhash expired'));
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });
    expect(r.status).toBe('rejected_onchain');
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe('0'); // released
  });

  it('over per-tx limit: rejected before signing, no on-chain call', async () => {
    await solSession({ maxAmountPerTx: usdcToBaseUnits('0.005').toString() });
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });
    expect(r).toMatchObject({ status: 'rejected_policy', reason: 'EXCEEDS_PER_TX_LIMIT' });
    expect(h.executeSolanaPayment).not.toHaveBeenCalled();
  });
});
