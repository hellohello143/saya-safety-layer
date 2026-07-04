// EVM chain adapter — a thin, behavior-preserving wrapper over the existing,
// tested CDP Spend Permission code (src/cdp/*). No EVM logic changes here.

import { isAddress } from 'viem';
import { EVM_NETWORKS, type EvmNetworkId } from '../config/network.js';
import { getTreasury, getSpender } from '../cdp/smartAccount.js';
import { issueSessionKey, revokeSessionKeyOnchain, useSessionKey, OnchainError } from '../cdp/spendPermissions.js';
import { settlePayment } from '../x402/settlement.js';
import { readOnchainStatus } from '../cdp/onchain.js';
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

export function makeEvmAdapter(network: EvmNetworkId): ChainAdapter {
  const cfg = EVM_NETWORKS[network];
  return {
    family: 'evm',
    network,

    validateAddress: (addr) => isAddress(addr, { strict: false }),

    async issueSessionKey(p: IssueSessionParams): Promise<IssuedSession> {
      const treasury = await getTreasury();
      const spender = await getSpender();
      // Deterministic 128-bit salt from the session UUID (recover the hash later).
      const salt = BigInt('0x' + p.sessionId.replace(/-/g, ''));
      const issued = await issueSessionKey({
        smartAccountAddress: treasury.address,
        spenderAddress: spender.address,
        maxAmountTotal: p.maxAmountTotal,
        expiresAt: p.expiresAt,
        allowedRecipients: p.allowedRecipients,
        salt,
      });
      return {
        smartAccountAddress: treasury.address,
        spenderAddress: spender.address,
        tokenAddress: cfg.usdcAddress,
        tokenAccount: null,
        permissionHash: issued.permissionHash,
        createTxHash: issued.createTxHash,
        higherRisk: issued.higherRisk,
      };
    },

    async executePayment(session: SessionRow, req: PaymentExecRequest): Promise<PaymentExecResult> {
      if (!session.permissionHash) throw new PaymentError('session has no permission hash', false, 'ONCHAIN_REJECTED');
      const spender = await getSpender();
      // hop 1: pull the capped funds to the spender (on-chain, capped).
      try {
        await useSessionKey(session.smartAccountAddress, session.permissionHash, req.amount);
      } catch (err) {
        const reason = err instanceof OnchainError ? 'ONCHAIN_REJECTED' : 'ONCHAIN_ERROR';
        throw new PaymentError(`hop-1 pull failed: ${(err as Error).message}`, false, reason);
      }
      // hop 2: pay the merchant + build the proof header. Cap already consumed.
      try {
        const s = await settlePayment(
          { scheme: 'exact', network, amount: req.amount, recipient: req.recipient, asset: req.asset, resource: '' },
          spender.address,
        );
        return { settlementTxHash: s.settlementTxHash, paymentHeader: s.paymentHeader };
      } catch (err) {
        throw new PaymentError(`settlement failed: ${(err as Error).message}`, true, 'ONCHAIN_ERROR', ['settlement_failed']);
      }
    },

    async revokeSessionKeyOnchain(session: SessionRow) {
      if (!session.permissionHash) throw new Error('session has no permission hash');
      return revokeSessionKeyOnchain(session.smartAccountAddress, session.permissionHash);
    },

    async readOnchainStatus(session: SessionRow): Promise<OnchainSessionStatus> {
      if (!session.permissionHash) {
        return { found: false, live: false, isRevoked: false, remainingAllowance: null, expiryEnforcedOnChain: true };
      }
      const s = await readOnchainStatus(session.smartAccountAddress, session.permissionHash);
      return {
        found: s.found,
        live: s.live,
        isRevoked: s.isRevoked,
        remainingAllowance: s.remainingAllowance,
        expiryEnforcedOnChain: true, // EVM: `end` is enforced on-chain
        raw: { ...s },
      };
    },

    explorerTxUrl: (hash) => cfg.explorerTxUrl(hash),
  };
}
