// x402 payment-requirement types + selection (draft, from verified raw shapes).
//
// Research found TWO live generations (docs/research/CDP_X402_RESEARCH.md §6):
//   v1 (unscoped x402@1.2.0): 402 body { x402Version:1, accepts: PaymentRequirements[] },
//      header X-PAYMENT, human network strings ('base-sepolia'), field maxAmountRequired.
//   v2 (scoped @x402/*@2.17.0): header PAYMENT-SIGNATURE, CAIP-2 ids, field 'amount'.
// We implement the v1 shapes directly (no x402 npm dep) so the generation churn
// doesn't block us; the mock seller matches. Real facilitator settlement is a
// documented seam (see settlement.ts).

// v1-shaped requirement (the shape the seller returns in `accepts`).
export interface PaymentRequirementsV1 {
  scheme: string; // 'exact'
  network: string; // 'base-sepolia'
  maxAmountRequired: string; // atomic/base units, as string
  resource: string; // URL
  description?: string;
  mimeType?: string;
  payTo: string; // recipient address (merchant)
  maxTimeoutSeconds?: number;
  asset: string; // ERC-20 (USDC) address
  extra?: Record<string, unknown>; // e.g. { name:'USDC', version:'2' }
}

export interface Http402Body {
  x402Version: number;
  accepts: PaymentRequirementsV1[];
  error?: string;
}

// Normalized selection our middleware works with.
export interface SelectedRequirement {
  scheme: string;
  network: string;
  amount: bigint; // base units
  recipient: string; // payTo
  asset: string;
  resource: string;
}

/**
 * Pick a payment option from a 402 body. The `accepts` array is a MENU of
 * alternatives, so prefer, in order: an exact-scheme option on the expected
 * network AND asset, then any on the expected network, then any usable option —
 * so that a seller offering e.g. both DAI and USDC on our chain doesn't get the
 * wrong one picked and rejected. Returns null if none look like an exact-scheme
 * option. Network/asset mismatches (when NO compliant option exists) are NOT
 * masked here — the policy engine still returns the precise WRONG_ASSET /
 * WRONG_NETWORK reason code.
 */
const INTEGER_STRING = /^[0-9]+$/;

// Same chain-aware rule as the policy engine: EVM hex is case-insensitive,
// Solana base58 is case-sensitive.
const sameAsset = (a: string, b: string) =>
  a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;

export function selectRequirement(
  body: Http402Body,
  expectedNetwork: string,
  expectedAsset?: string,
): SelectedRequirement | null {
  // A usable option must be exact-scheme AND carry a well-formed integer base-unit
  // amount. This filters out malformed/negative/empty/decimal/hex amounts from a
  // malicious or buggy seller BEFORE we BigInt() them (which would otherwise throw
  // and escape the payment flow, skipping the audit log). A network mismatch is
  // NOT filtered here — it surfaces as WRONG_NETWORK in the policy engine.
  const usable = (body.accepts ?? []).filter(
    (r) => r.scheme === 'exact' && typeof r.maxAmountRequired === 'string' && INTEGER_STRING.test(r.maxAmountRequired),
  );
  if (usable.length === 0) return null;
  const onNetwork = usable.filter((r) => r.network === expectedNetwork);
  const pool = onNetwork.length > 0 ? onNetwork : usable;
  const chosen = (expectedAsset && pool.find((r) => sameAsset(r.asset, expectedAsset))) || pool[0]!;
  return {
    scheme: chosen.scheme,
    network: chosen.network,
    amount: BigInt(chosen.maxAmountRequired), // safe: matched INTEGER_STRING
    recipient: chosen.payTo,
    asset: chosen.asset,
    resource: chosen.resource,
  };
}

// The X-PAYMENT header payload (base64-encoded JSON). It carries the REAL hop-2
// settlement: an on-chain USDC transfer from the spender to the merchant payTo,
// which the seller verifies on-chain (see settlement.ts + mock-seller/server.ts).
export interface PaymentPayloadV1 {
  x402Version: number;
  scheme: string;
  network: string;
  settlement: 'onchain';
  payload: {
    from: string; // spender (payer)
    to: string; // merchant payTo
    value: string; // base units
    asset: string; // USDC
    settlementTxHash: string; // the real spender -> merchant USDC transfer (hop 2)
  };
}
