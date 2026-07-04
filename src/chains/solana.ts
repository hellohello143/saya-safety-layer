// Solana chain adapter — wraps src/solana/session (SPL Token delegation).
//
// ⚠️ expiresAt is SOFT-ONLY on Solana (expiryEnforcedOnChain: false). The on-chain
// cap (delegated_amount) + revocation (Revoke) are real; expiry is enforced only
// by the policy layer refusing to sign after it. Flagged everywhere.

import { SOLANA_NETWORKS, type SolanaNetworkId } from '../config/network.js';
import { baseUnitsToUsdc } from '../money/usdc.js';
import {
  issueSolanaSessionKey,
  revokeSolanaSessionKey,
  readSolanaOnchainStatus,
  executeSolanaPayment,
  buildSolanaPaymentHeader,
} from '../solana/session.js';
import type { SessionRow } from '../db/schema.js';
import {
  PaymentError,
  type ChainAdapter,
  type IssueSessionParams,
  type IssuedSession,
  type OnchainSessionStatus,
  type PaymentExecRequest,
  type PaymentExecResult,
} from './types.js';

// base58, 32–44 chars (no 0, O, I, l). Format check only.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function makeSolanaAdapter(network: SolanaNetworkId): ChainAdapter {
  const cfg = SOLANA_NETWORKS[network];
  return {
    family: 'solana',
    network,

    validateAddress: (addr) => BASE58_ADDRESS.test(addr),

    async issueSessionKey(p: IssueSessionParams): Promise<IssuedSession> {
      const issued = await issueSolanaSessionKey(p.maxAmountTotal);
      return {
        smartAccountAddress: issued.treasuryAddress, // Solana treasury owner
        spenderAddress: issued.spenderAddress, // the delegate
        tokenAddress: issued.mint, // USDC mint
        tokenAccount: issued.tokenAccount, // the ATA the delegate spends from
        permissionHash: issued.approveSignature, // Approve signature = the on-chain ref
        createTxHash: issued.approveSignature,
        higherRisk: p.allowedRecipients.length === 0,
      };
    },

    async executePayment(session: SessionRow, req: PaymentExecRequest): Promise<PaymentExecResult> {
      if (!session.tokenAccount) throw new PaymentError('solana session has no token account', false, 'ONCHAIN_REJECTED');
      // SINGLE-HOP: the delegate transfers treasury -> merchant directly (capped
      // on-chain by delegated_amount). A failure means nothing was spent -> release.
      try {
        const { signature } = await executeSolanaPayment(session.tokenAccount, req.recipient, req.amount);
        const paymentHeader = buildSolanaPaymentHeader({
          from: session.tokenAccount,
          to: req.recipient,
          value: req.amount,
          mint: req.asset,
          signature,
        });
        return { settlementTxHash: signature, paymentHeader };
      } catch (err) {
        throw new PaymentError(`solana transfer failed: ${(err as Error).message}`, false, 'ONCHAIN_REJECTED');
      }
    },

    async revokeSessionKeyOnchain(session: SessionRow) {
      if (!session.tokenAccount) throw new Error('solana session has no token account to revoke');
      const revokeTxHash = await revokeSolanaSessionKey(session.tokenAccount);
      return { revokeTxHash };
    },

    async readOnchainStatus(session: SessionRow): Promise<OnchainSessionStatus> {
      if (!session.tokenAccount) {
        return { found: false, live: false, isRevoked: false, remainingAllowance: null, expiryEnforcedOnChain: false };
      }
      const s = await readSolanaOnchainStatus(session.tokenAccount, session.spenderAddress);
      return {
        found: s.found,
        live: s.live,
        // On Solana "revoked" = delegate cleared (no delegate, or not our spender).
        isRevoked: s.found && (s.delegate === null || s.delegate !== session.spenderAddress),
        remainingAllowance: s.found ? baseUnitsToUsdc(s.delegatedAmount) : null,
        expiryEnforcedOnChain: false, // 🔴 SOFT-ONLY on Solana
        raw: { delegate: s.delegate, delegatedAmount: s.delegatedAmount.toString() },
      };
    },

    explorerTxUrl: (hash) => cfg.explorerTxUrl(hash),
  };
}
