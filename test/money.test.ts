import { describe, it, expect } from 'vitest';
import { usdcToBaseUnits, baseUnitsToUsdc, USDC_DECIMALS } from '../src/money/usdc.js';

describe('usdc money helpers (6 decimals, integer base units, no floats)', () => {
  it('USDC has 6 decimals', () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it('converts decimal USDC -> base units', () => {
    expect(usdcToBaseUnits('0.01')).toBe(10_000n);
    expect(usdcToBaseUnits('1')).toBe(1_000_000n);
    expect(usdcToBaseUnits('1.5')).toBe(1_500_000n);
    expect(usdcToBaseUnits('0.000001')).toBe(1n); // smallest unit
  });

  it('converts base units -> decimal USDC', () => {
    expect(baseUnitsToUsdc(10_000n)).toBe('0.01');
    expect(baseUnitsToUsdc(1_000_000n)).toBe('1');
    expect(baseUnitsToUsdc(0n)).toBe('0');
  });

  it('round-trips valid amounts without precision loss', () => {
    const cases: [string, bigint][] = [
      ['0.01', 10_000n],
      ['0.123456', 123_456n],
      ['999.999999', 999_999_999n],
      ['1000000', 1_000_000_000_000n],
    ];
    for (const [decimal, base] of cases) {
      expect(usdcToBaseUnits(decimal)).toBe(base);
      expect(baseUnitsToUsdc(base)).toBe(decimal);
    }
  });

  it('returns bigint (never a float)', () => {
    expect(typeof usdcToBaseUnits('0.01')).toBe('bigint');
  });

  it('throws on non-numeric input', () => {
    expect(() => usdcToBaseUnits('abc')).toThrow();
    expect(() => usdcToBaseUnits('')).toThrow();
  });

  it('throws on excess precision instead of silently rounding', () => {
    // viem's parseUnits would round these; the primitive must reject them.
    expect(() => usdcToBaseUnits('0.0000005')).toThrow(); // 7 dp
    expect(() => usdcToBaseUnits('1.9999995')).toThrow();
    expect(() => usdcToBaseUnits('0.1234567')).toThrow();
    // exactly 6 dp is still fine
    expect(usdcToBaseUnits('0.123456')).toBe(123_456n);
  });
});
