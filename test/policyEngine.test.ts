import { describe, it, expect } from 'vitest';
import { evaluatePolicy, type PaymentIntent } from '../src/policy/policyEngine.js';
import { usdcToBaseUnits } from '../src/money/usdc.js';
import type { SessionRow } from '../src/db/schema.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const NET = 'base-sepolia';
const now = () => Math.floor(Date.now() / 1000);

function mkSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1',
    agentId: 'a1',
    status: 'active',
    smartAccountAddress: '0xaa',
    spenderAddress: '0xbb',
    tokenAddress: USDC,
    permissionHash: '0xhash',
    maxAmountPerTx: usdcToBaseUnits('0.05').toString(),
    maxAmountTotal: usdcToBaseUnits('1.00').toString(),
    expiresAt: now() + 3600,
    allowedRecipients: [MERCHANT],
    higherRisk: false,
    flaggedForReview: false,
    cumulativeSpent: '0',
    createTxHash: '0xc',
    revokeTxHash: null,
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

function mkIntent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    sessionId: 's1',
    agentId: 'a1',
    targetUrl: 'http://seller/resource',
    amount: usdcToBaseUnits('0.02'),
    recipient: MERCHANT,
    asset: USDC,
    network: NET,
    ...over,
  };
}

const reasonOf = (d: ReturnType<typeof evaluatePolicy>) => (d.ok ? null : d.reason);

describe('policy engine (soft layer, reason codes)', () => {
  it('approves a valid intent with no risk flags', () => {
    const d = evaluatePolicy(mkSession(), mkIntent(), NET);
    expect(d.ok).toBe(true);
    expect(d.riskFlags).toEqual([]);
  });

  it('flags no-allowlist sessions as higher_risk but still approves', () => {
    const d = evaluatePolicy(mkSession({ allowedRecipients: [], higherRisk: true }), mkIntent({ recipient: OTHER }), NET);
    expect(d.ok).toBe(true);
    expect(d.riskFlags).toContain('no_allowlist_session');
  });

  it('rejects zero / negative amounts with INVALID_AMOUNT', () => {
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ amount: 0n }), NET))).toBe('INVALID_AMOUNT');
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ amount: -1n }), NET))).toBe('INVALID_AMOUNT');
  });

  it('maps session status to the right reason', () => {
    expect(reasonOf(evaluatePolicy(mkSession({ status: 'revoked' }), mkIntent(), NET))).toBe('SESSION_REVOKED');
    expect(reasonOf(evaluatePolicy(mkSession({ status: 'suspended' }), mkIntent(), NET))).toBe('SESSION_SUSPENDED');
    expect(reasonOf(evaluatePolicy(mkSession({ status: 'expired' }), mkIntent(), NET))).toBe('SESSION_EXPIRED');
  });

  it('rejects an intent past expiresAt even if status is active', () => {
    expect(reasonOf(evaluatePolicy(mkSession({ expiresAt: now() - 5 }), mkIntent(), NET))).toBe('SESSION_EXPIRED');
  });

  it('enforces network and asset', () => {
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ network: 'base' }), NET))).toBe('WRONG_NETWORK');
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ asset: OTHER }), NET))).toBe('WRONG_ASSET');
  });

  it('enforces the per-tx cap (soft)', () => {
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ amount: usdcToBaseUnits('0.10') }), NET))).toBe('EXCEEDS_PER_TX_LIMIT');
  });

  it('enforces the total cap preliminarily', () => {
    const s = mkSession({ cumulativeSpent: usdcToBaseUnits('0.99').toString() });
    expect(reasonOf(evaluatePolicy(s, mkIntent(), NET))).toBe('EXCEEDS_TOTAL_LIMIT');
  });

  it('enforces the recipient allowlist (soft), case-insensitively', () => {
    expect(reasonOf(evaluatePolicy(mkSession(), mkIntent({ recipient: OTHER }), NET))).toBe('RECIPIENT_NOT_ALLOWED');
    // same address, different case -> allowed
    const d = evaluatePolicy(mkSession(), mkIntent({ recipient: MERCHANT.toUpperCase().replace('0X', '0x') }), NET);
    expect(d.ok).toBe(true);
  });
});
