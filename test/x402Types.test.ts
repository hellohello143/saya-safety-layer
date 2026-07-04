import { describe, it, expect } from 'vitest';
import { selectRequirement, type Http402Body } from '../src/x402/types.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT = '0x1111111111111111111111111111111111111111';

function body(maxAmountRequired: string, network = 'base-sepolia', scheme = 'exact'): Http402Body {
  return {
    x402Version: 1,
    accepts: [
      { scheme, network, maxAmountRequired, resource: 'r', payTo: MERCHANT, asset: USDC } as any,
    ],
  };
}

describe('selectRequirement (402 parsing, malformed-amount hardening)', () => {
  it('selects a well-formed exact requirement and parses the amount as bigint', () => {
    const r = selectRequirement(body('10000'), 'base-sepolia');
    expect(r).not.toBeNull();
    expect(r!.amount).toBe(10_000n);
    expect(r!.recipient).toBe(MERCHANT);
    expect(r!.asset).toBe(USDC);
  });

  it('rejects malformed/negative/empty/decimal/hex amounts (returns null, never throws)', () => {
    for (const bad of ['-5', '', '1.5', '0x10', ' 5', '1_000', 'abc']) {
      expect(selectRequirement(body(bad), 'base-sepolia')).toBeNull();
    }
  });

  it('allows "0" through (policy engine rejects it as INVALID_AMOUNT)', () => {
    expect(selectRequirement(body('0'), 'base-sepolia')?.amount).toBe(0n);
  });

  it('returns null when there is no exact-scheme option', () => {
    expect(selectRequirement(body('10000', 'base-sepolia', 'upto'), 'base-sepolia')).toBeNull();
    expect(selectRequirement({ x402Version: 1, accepts: [] }, 'base-sepolia')).toBeNull();
  });

  it('prefers the requirement matching the expected network', () => {
    const b: Http402Body = {
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'base', maxAmountRequired: '1', resource: 'r', payTo: MERCHANT, asset: USDC } as any,
        { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '2', resource: 'r', payTo: MERCHANT, asset: USDC } as any,
      ],
    };
    expect(selectRequirement(b, 'base-sepolia')!.amount).toBe(2n);
  });
});
