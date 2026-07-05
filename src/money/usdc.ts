// Money helpers. HARD RULE (spec): USDC has 6 decimals; all amounts are handled
// as integer base units (bigint) internally. Only format to a decimal string at
// API/UI edges. NEVER use floating point for money.

import { parseUnits, formatUnits } from 'viem';

export const USDC_DECIMALS = 6;

// Digits, optionally a fraction of AT MOST USDC_DECIMALS places. Capping the
// fraction matters: viem's parseUnits SILENTLY ROUNDS excess precision
// (parseUnits('0.0000005', 6) === 1n), which would violate this primitive's
// contract of never coercing an out-of-range value.
const AMOUNT_RE = new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`);

/** "0.01" (decimal USDC) -> 10000n (base units). Throws on malformed or over-precise input. */
export function usdcToBaseUnits(decimal: string): bigint {
  // Strict on its own — callers also validate at the boundary, but a money
  // primitive must never silently coerce garbage (or excess precision) into a value.
  if (!AMOUNT_RE.test(decimal)) {
    throw new Error(`invalid USDC amount: ${JSON.stringify(decimal)}`);
  }
  return parseUnits(decimal, USDC_DECIMALS);
}

/** 10000n (base units) -> "0.01" (decimal USDC string), for API/UI edges only. */
export function baseUnitsToUsdc(base: bigint): string {
  return formatUnits(base, USDC_DECIMALS);
}
