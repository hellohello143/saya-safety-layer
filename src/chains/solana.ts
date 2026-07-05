// Solana chain adapter — wraps src/solana/session (SPL Token delegation).
//
// IMPORTANT: SPL delegation has no protocol time bound, so expiresAt is not
// enforced by the token program (expiryEnforcedOnChain stays false). The on-chain
// cap (delegated_amount) + revocation (Revoke) ARE native. Expiry is enforced by
// the policy layer refusing to sign AND a scheduled on-chain Revoke at expiry
// (src/solana/expirySweeper.ts) — backend-driven, not protocol-intrinsic. Flagged everywhere.

import { address } from '@solana/kit';
import { SOLANA_NETWORKS, type SolanaNetworkId } from '../config/network.js';
import { baseUnitsToUsdc } from '../money/usdc.js';
import {
  issueSolanaSessionKey,
  revokeSolanaSessionKey,
  readSolanaOnchainStatus,
  executeSolanaPayment,
  buildSolanaPaymentHeader,
  SolanaOnchainError,
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

// base58, 32–44 chars (no 0, O, I, l) — a cheap first filter. The definitive
// check is address() below, which also asserts the string decodes to 32 bytes
// (a length-only regex accepts strings that decode to the wrong size).
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function makeSolanaAdapter(network: SolanaNetworkId): ChainAdapter {
  const cfg = SOLANA_NETWORKS[network];
  return {
    family: 'solana',
    network,

    validateAddress: (addr) => {
      if (!BASE58_ADDRESS.test(addr)) return false;
      try {
        address(addr); // asserts base58 AND a 32-byte decode
        return true;
      } catch {
        return false;
      }
    },

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
      // on-chain by delegated_amount). A clean failure means nothing was spent ->
      // release the reserve. But an AMBIGUOUS failure (transfer may have landed)
      // marks the cap consumed so we don't release and risk a double-pay on retry.
      try {
        const { signature } = await executeSolanaPayment(
          session.tokenAccount,
          req.recipient,
          req.amount,
          session.spenderAddress,
        );
        const paymentHeader = buildSolanaPaymentHeader({
          from: session.tokenAccount,
          to: req.recipient,
          value: req.amount,
          mint: req.asset,
          signature,
        });
        return { settlementTxHash: signature, paymentHeader };
      } catch (err) {
        const capConsumed = err instanceof SolanaOnchainError && err.capMaybeConsumed;
        throw new PaymentError(
          `solana transfer failed: ${(err as Error).message}`,
          capConsumed,
          'ONCHAIN_REJECTED',
          capConsumed ? ['settlement_uncertain'] : [],
        );
      }
    },

    async revokeSessionKeyOnchain(session: SessionRow) {
      if (!session.tokenAccount) throw new Error('solana session has no token account to revoke');
      const revokeTxHash = await revokeSolanaSessionKey(session.tokenAccount, session.spenderAddress);
      return { revokeTxHash };
    },

    async readOnchainStatus(session: SessionRow): Promise<OnchainSessionStatus> {
      if (!session.tokenAccount) {
        return { found: false, live: false, isRevoked: false, remainingAllowance: null, expiryEnforcedOnChain: false };
      }
      const s = await readSolanaOnchainStatus(session.tokenAccount, session.spenderAddress);
      // The delegate being cleared is AMBIGUOUS on Solana: it happens both on
      // Revoke AND when a session legitimately spends its full cap (the program
      // auto-clears the delegate at delegated_amount 0). Use the DB's cumulative
      // spend to tell "exhausted" from "revoked" so the status read isn't
      // misleading in an audit context.
      const delegateCleared = s.found && (s.delegate === null || s.delegate !== session.spenderAddress);
      const exhausted = delegateCleared && BigInt(session.cumulativeSpent) >= BigInt(session.maxAmountTotal);
      return {
        found: s.found,
        live: s.live,
        isRevoked: delegateCleared && !exhausted,
        remainingAllowance: s.found ? baseUnitsToUsdc(s.delegatedAmount) : null,
        expiryEnforcedOnChain: false, // SOFT-ONLY on Solana
        raw: {
          delegate: s.delegate,
          delegatedAmount: s.delegatedAmount.toString(),
          delegateCleared,
          exhausted,
        },
      };
    },

    explorerTxUrl: (hash) => cfg.explorerTxUrl(hash),
  };
}
