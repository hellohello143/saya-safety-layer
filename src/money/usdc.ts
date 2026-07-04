// Money helpers. HARD RULE (spec): USDC has 6 decimals; all amounts are handled
// as integer base units (bigint) internally. Only format to a decimal string at
// API/UI edges. NEVER use floating point for money.

import { parseUnits, formatUnits } from 'viem';

export const USDC_DECIMALS = 6;

/** "0.01" (decimal USDC) -> 10000n (base units). Throws on malformed input. */
export function usdcToBaseUnits(decimal: string): bigint {
  // Strict on its own — callers also validate at the boundary, but a money
  // primitive must never silently coerce garbage into a value.
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`invalid USDC amount: ${JSON.stringify(decimal)}`);
  }
  return parseUnits(decimal, USDC_DECIMALS);
}

/** 10000n (base units) -> "0.01" (decimal USDC string), for API/UI edges only. */
export function baseUnitsToUsdc(base: bigint): string {
  return formatUnits(base, USDC_DECIMALS);
}
