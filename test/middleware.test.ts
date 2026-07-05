import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks so vi.mock factories (hoisted above imports) can reference them,
// and tests can control return values per-case.
const h = vi.hoisted(() => {
  class OnchainError extends Error {}
  return {
    OnchainError,
    useSessionKey: vi.fn(),
    transferUsdcToMerchant: vi.fn(),
    revokeSessionKeyOnchain: vi.fn(async () => ({ revokeTxHash: '0xrevoke' })),
    getSpender: vi.fn(async () => ({ address: '0xspender' })),
    settlePayment: vi.fn(),
  };
});

vi.mock('../src/cdp/spendPermissions.js', () => ({
  useSessionKey: h.useSessionKey,
  transferUsdcToMerchant: h.transferUsdcToMerchant,
  revokeSessionKeyOnchain: h.revokeSessionKeyOnchain,
  OnchainError: h.OnchainError,
}));
vi.mock('../src/cdp/smartAccount.js', () => ({
  getSpender: h.getSpender,
  getTreasury: vi.fn(async () => ({ address: '0xtreasury' })),
}));
vi.mock('../src/x402/settlement.js', () => ({
  settlePayment: h.settlePayment,
}));

import { getDb } from '../src/db/client.js';
import { payForResource } from '../src/x402/middleware.js';
import { SessionRepository } from '../src/db/repositories/sessionRepository.js';
import { queryAudit } from '../src/audit/auditLog.js';
import { usdcToBaseUnits } from '../src/money/usdc.js';
import type { NewSessionRow } from '../src/db/schema.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT = '0x1111111111111111111111111111111111111111';
const PRICE = '10000'; // 0.01 USDC base units
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
  accepts: [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: PRICE,
      resource: 'http://seller/resource',
      payTo: MERCHANT,
      asset: USDC,
    },
  ],
};

function session(over: Partial<NewSessionRow> = {}) {
  return repo.create({
    id: 's1',
    agentId: 'agent-1',
    status: 'active',
    smartAccountAddress: '0xaa',
    spenderAddress: '0xspender',
    tokenAddress: USDC,
    permissionHash: '0xh',
    maxAmountPerTx: usdcToBaseUnits('0.05').toString(),
    maxAmountTotal: usdcToBaseUnits('1.00').toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    allowedRecipients: [MERCHANT],
    higherRisk: false,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: '0xc',
    revokeTxHash: null,
    ...over,
  });
}

beforeEach(() => {
  getDb().exec('DELETE FROM sessions; DELETE FROM audit_log;');
  h.useSessionKey.mockReset().mockResolvedValue({ txHash: '0xhop1' });
  h.settlePayment.mockReset().mockResolvedValue({ paymentHeader: 'hdr', settlementTxHash: '0xhop2' });
  h.getSpender.mockReset().mockResolvedValue({ address: '0xspender' });
  global.fetch = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const paid = init?.headers && (init.headers['X-PAYMENT'] ?? init.headers['x-payment']);
    return paid ? mockResponse(200, { ok: true, resource: 'premium-data-42' }) : mockResponse(402, challenge);
  }) as unknown as typeof fetch;
});

describe('payForResource (full orchestration, CDP + network mocked)', () => {
  it('within limits: pulls (hop 1), settles (hop 2), returns approved + settlement tx, logs one audit row', async () => {
    await session();
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });

    expect(r.status).toBe('approved');
    expect(r.txHash).toBe('0xhop2'); // the merchant-payment tx
    expect(h.useSessionKey).toHaveBeenCalledWith('0xaa', '0xh', usdcToBaseUnits('0.01'));
    expect(h.settlePayment).toHaveBeenCalledOnce();

    const audit = await queryAudit({ sessionId: 's1' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.decision).toBe('approved');
    expect(audit[0]!.txHash).toBe('0xhop2');
    // reserve consumed exactly the price
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe(PRICE);
  });

  it('unknown session: rejected SESSION_NOT_FOUND, no on-chain calls, still logs', async () => {
    const r = await payForResource({ sessionId: 'nope', targetUrl: 'http://seller/resource' });
    expect(r).toMatchObject({ status: 'rejected_policy', reason: 'SESSION_NOT_FOUND' });
    expect(h.useSessionKey).not.toHaveBeenCalled();
    expect(await queryAudit({})).toHaveLength(1);
  });

  it('over per-tx limit: rejected before signing, no on-chain calls, reserve untouched', async () => {
    await session({ maxAmountPerTx: usdcToBaseUnits('0.005').toString() });
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });

    expect(r).toMatchObject({ status: 'rejected_policy', reason: 'EXCEEDS_PER_TX_LIMIT' });
    expect(h.useSessionKey).not.toHaveBeenCalled();
    expect(h.settlePayment).not.toHaveBeenCalled();
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe('0');
    expect((await queryAudit({ sessionId: 's1' }))[0]!.decision).toBe('rejected_policy');
  });

  it('recipient not allowed: rejected RECIPIENT_NOT_ALLOWED', async () => {
    await session({ allowedRecipients: ['0x9999999999999999999999999999999999999999'] });
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });
    expect(r).toMatchObject({ status: 'rejected_policy', reason: 'RECIPIENT_NOT_ALLOWED' });
  });

  it('hop-1 on-chain failure: rejected_onchain, reserve RELEASED (cap not consumed)', async () => {
    await session();
    h.useSessionKey.mockRejectedValueOnce(new h.OnchainError('spend reverted'));
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });

    expect(r).toMatchObject({ status: 'rejected_onchain', reason: 'ONCHAIN_REJECTED' });
    expect(h.settlePayment).not.toHaveBeenCalled();
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe('0'); // released
    expect((await queryAudit({ sessionId: 's1' }))[0]!.decision).toBe('rejected_onchain');
  });

  it('hop-2 settlement failure: rejected_onchain + settlement_failed, reserve NOT released (hop-1 spent)', async () => {
    await session();
    h.settlePayment.mockRejectedValueOnce(new h.OnchainError('transfer failed'));
    const r = await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' });

    expect(r.status).toBe('rejected_onchain');
    expect(r.riskFlags).toContain('settlement_failed');
    expect((await repo.getById('s1'))?.cumulativeSpent).toBe(PRICE); // NOT released
  });

  it('allows a loopback target on testnet (the local mock seller) but always blocks cloud metadata', async () => {
    await session();
    // Loopback is where the local mock seller runs — must NOT be rejected as invalid on testnet.
    const ok = await payForResource({ sessionId: 's1', targetUrl: 'http://127.0.0.1:4021/resource' });
    expect(ok.reason).not.toBe('INVALID_TARGET_URL');
    expect(ok.status).toBe('approved');
    // The cloud metadata endpoint is blocked on every network (credential-exfil vector).
    const blocked = await payForResource({ sessionId: 's1', targetUrl: 'http://169.254.169.254/latest/meta-data/' });
    expect(blocked).toMatchObject({ status: 'rejected_policy', reason: 'INVALID_TARGET_URL' });
    expect(h.useSessionKey).toHaveBeenCalledTimes(1); // only the loopback payment reached on-chain
  });

  it('audit-never-skipped: every terminal path logs exactly one row', async () => {
    await session();
    await payForResource({ sessionId: 's1', targetUrl: 'http://seller/resource' }); // approved
    await payForResource({ sessionId: 'nope', targetUrl: 'http://seller/resource' }); // not found
    expect(await queryAudit({})).toHaveLength(2);
  });
});
