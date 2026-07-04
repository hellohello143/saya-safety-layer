// x402 merchant-payment leg (hop 2) — REAL on-chain settlement.
//
// After hop 1 (useSpendPermission pulled the capped funds to the spender), we
// settle the payment to the merchant with a REAL on-chain USDC transfer from the
// spender to the merchant's payTo (gasless via the CDP paymaster), then attach an
// X-PAYMENT header carrying the settlement tx hash so the seller can VERIFY it
// on-chain before returning the resource.
//
// This is not the x402 facilitator protocol (no /verify + /settle); it's a real
// direct transfer with an on-chain proof (the chosen "keep it gasless" design).
// The x402 HTTP shape (402 challenge + X-PAYMENT header) is preserved.

import { transferUsdcToMerchant } from '../cdp/spendPermissions.js';
import type { PaymentPayloadV1, SelectedRequirement } from './types.js';

export interface SettlementResult {
  paymentHeader: string; // value for the X-PAYMENT request header (base64 JSON)
  settlementTxHash: string; // the real spender -> merchant USDC transfer
}

/** Pay the merchant on-chain and build the X-PAYMENT proof header. */
export async function settlePayment(
  req: SelectedRequirement,
  payerAddress: string,
): Promise<SettlementResult> {
  // REAL on-chain transfer of `amount` USDC from the spender to the merchant.
  const { txHash } = await transferUsdcToMerchant(req.recipient, req.amount);

  const payload: PaymentPayloadV1 = {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    settlement: 'onchain',
    payload: {
      from: payerAddress,
      to: req.recipient,
      value: req.amount.toString(),
      asset: req.asset,
      settlementTxHash: txHash,
    },
  };
  const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return { paymentHeader: header, settlementTxHash: txHash };
}
