// Chain adapter interface. The safety layer routes per-session by chain: EVM
// (CDP Spend Permissions) and Solana (SPL Token delegation). Each adapter hides
// the chain-specific issuance/revocation/read behind one shape so the routes,
// circuit breaker, and (later) payment flow stay chain-agnostic.

import type { SessionRow } from '../db/schema.js';
import type { RejectionReason } from '../policy/reasonCodes.js';

export interface IssueSessionParams {
  sessionId: string;
  agentId: string;
  maxAmountPerTx: bigint; // base units — SOFT everywhere
  maxAmountTotal: bigint; // base units — ON-CHAIN (EVM single-window allowance / Solana delegated_amount)
  expiresAt: number; // unix seconds — ON-CHAIN on EVM, SOFT-ONLY on Solana
  allowedRecipients: string[]; // SOFT everywhere
}

export interface IssuedSession {
  smartAccountAddress: string; // EVM smart account / Solana treasury owner
  spenderAddress: string; // EVM spender / Solana delegate
  tokenAddress: string; // EVM USDC address / Solana USDC mint
  tokenAccount: string | null; // Solana token account (ATA) the delegate spends from; null for EVM
  permissionHash: string; // EVM permission hash / Solana Approve signature (the on-chain ref)
  createTxHash: string;
  higherRisk: boolean; // empty allowlist
}

export interface OnchainSessionStatus {
  found: boolean;
  live: boolean; // can spend right now (valid + within window where applicable)
  isRevoked: boolean;
  remainingAllowance: string | null; // base units still spendable on-chain, if readable
  expiryEnforcedOnChain: boolean; // true on EVM; FALSE on Solana (soft-only) — drives risk flags
  raw?: Record<string, unknown>;
}

export interface PaymentExecRequest {
  amount: bigint; // base units
  recipient: string; // merchant payTo (EVM address / Solana wallet)
  asset: string; // USDC address / mint
}

export interface PaymentExecResult {
  settlementTxHash: string; // the on-chain settlement (EVM hop-2 transfer / Solana transfer)
  paymentHeader: string; // X-PAYMENT header for the seller to verify on-chain
}

/**
 * Thrown by executePayment. `capConsumed` tells the middleware whether the
 * on-chain spend already happened (EVM hop-1 succeeded but hop-2 failed) — if so
 * the reserve must NOT be released. Single-hop chains throw with capConsumed=false.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly capConsumed: boolean,
    readonly reason: RejectionReason = 'ONCHAIN_REJECTED',
    readonly riskFlags: string[] = [],
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface ChainAdapter {
  readonly family: 'evm' | 'solana';
  readonly network: string;
  /** True if `addr` is a well-formed address on this chain. */
  validateAddress(addr: string): boolean;
  /** Mint/create the on-chain session key. Resolves treasury/spender internally. */
  issueSessionKey(p: IssueSessionParams): Promise<IssuedSession>;
  /**
   * Execute the on-chain payment to the merchant and return the settlement proof
   * + X-PAYMENT header. Throws PaymentError on failure (with capConsumed).
   */
  executePayment(session: SessionRow, req: PaymentExecRequest): Promise<PaymentExecResult>;
  /** REAL on-chain revocation. Returns only after it confirms. */
  revokeSessionKeyOnchain(session: SessionRow): Promise<{ revokeTxHash: string }>;
  /** Authoritative on-chain status read. */
  readOnchainStatus(session: SessionRow): Promise<OnchainSessionStatus>;
  explorerTxUrl(hash: string): string;
}
