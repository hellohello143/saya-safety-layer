// Session-key issuance + revocation via CDP Spend Permissions.
// This is the on-chain heart of the trust boundary — see TRUST_BOUNDARY.md.
//
// Verified against SpendPermissionManager.sol v1.0.0 (deployed
// 0xf85210B21cC50302F477BA56686d2019dC9b67Ad) + @coinbase/cdp-sdk@1.51.2.
// Full analysis + citations: docs/research/CDP_X402_RESEARCH.md §4, §5, §8.
//
// TRUST BOUNDARY (what the contract actually enforces on-chain):
//   expiresAt         -> permission.end        ENFORCED (spend() reverts once now>=end).
//   maxAmountTotal    -> permission.allowance   ENFORCED because we use the
//                                               SINGLE-WINDOW config below (period =
//                                               end-start => one non-resetting window,
//                                               so allowance behaves as a lifetime cap).
//   maxAmountPerTx    -> (none)                 SOFT ONLY. No per-tx field. FLAG.
//   allowedRecipients -> (none)                 SOFT ONLY. spend() hardcodes payee to
//                                               spender; no recipient arg. FLAG LOUDLY.

import { getCdpClient } from './client.js';
import { getTreasury, getSpender } from './smartAccount.js';
import { loadEnv } from '../config/env.js';
import { readOnchainStatus, fetchPermissionByHash } from './onchain.js';

/** Raised when an on-chain user operation does not complete successfully. */
export class OnchainError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
    // True when the hop-1 pull MAY have landed on-chain (an ambiguous broadcast
    // failure), so the caller must treat the cap as consumed and NOT release the
    // reserve — resubmitting would risk a double-pull.
    readonly possiblyConsumed = false,
  ) {
    super(message);
    this.name = 'OnchainError';
  }
}

export interface IssueSessionKeyParams {
  smartAccountAddress: string;
  spenderAddress: string;
  maxAmountTotal: bigint; // base units -> permission.allowance (ON-CHAIN, single window)
  expiresAt: number; // unix seconds -> permission.end (ON-CHAIN)
  allowedRecipients: string[]; // SOFT enforced; [] => higher_risk
  salt: bigint; // deterministic per session (from session UUID) to recover the hash
}

export interface IssuedSessionKey {
  permissionHash: string;
  createTxHash: string;
  higherRisk: boolean;
}

/**
 * Mint a scoped on-chain session key (Spend Permission) for an agent, using the
 * single-window config so the total cap is enforced on-chain.
 */
export async function issueSessionKey(params: IssueSessionKeyParams): Promise<IssuedSessionKey> {
  const cdp = getCdpClient();
  const env = loadEnv();
  const treasury = await getTreasury();

  const nowSec = Math.floor(Date.now() / 1000);
  if (params.expiresAt <= nowSec) {
    throw new Error(`expiresAt (${params.expiresAt}) must be in the future (now=${nowSec})`);
  }

  // SINGLE-WINDOW: one non-resetting period spanning [start, end). period = end-start
  // makes `allowance` a genuine lifetime cap the contract enforces (§10.2 Strategy B).
  const start = new Date(nowSec * 1000);
  const end = new Date(params.expiresAt * 1000);
  const period = params.expiresAt - nowSec;

  const spendPermission = {
    account: params.smartAccountAddress as `0x${string}`,
    spender: params.spenderAddress as `0x${string}`,
    token: 'usdc' as const, // SDK resolves 'usdc' to the canonical USDC for env.NETWORK (Base Sepolia 0x036C… / Base mainnet 0x8335…)
    allowance: params.maxAmountTotal,
    period,
    start,
    end,
    salt: params.salt,
  };

  const { userOpHash } = await cdp.evm.createSpendPermission({
    network: env.NETWORK,
    spendPermission,
  });

  const result = await treasury.waitForUserOperation({ userOpHash });
  if (!('transactionHash' in result)) {
    throw new OnchainError('createSpendPermission user op did not complete', result);
  }
  const createTxHash = result.transactionHash;

  // Recover the on-chain permissionHash by matching our unique salt in the list.
  // The indexed list can lag the just-confirmed create tx, so retry with backoff
  // (mirrors useSessionKey) rather than failing — and leaving an untracked but
  // live on-chain permission — on a transient miss.
  type PermList = Awaited<ReturnType<typeof cdp.evm.listSpendPermissions>>;
  let match: PermList['spendPermissions'][number] | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const list: PermList = await cdp.evm.listSpendPermissions({
      address: params.smartAccountAddress as `0x${string}`,
    });
    match = list.spendPermissions.find((p) => p.permission.salt === params.salt);
    if (match) break;
    if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  if (!match) {
    throw new OnchainError('created permission not found in listSpendPermissions after retries (indexer lag or salt mismatch)');
  }

  return {
    permissionHash: match.permissionHash,
    createTxHash,
    higherRisk: params.allowedRecipients.length === 0,
  };
}

/**
 * Consume the permission on-chain: the spender pulls `value` (base units) from
 * the treasury smart account to itself. Gasless via the CDP paymaster. This is
 * hop 1 of a payment; hop 2 (paying the merchant) is handled in src/x402.
 * Returns only after the user op confirms.
 */
export async function useSessionKey(
  smartAccountAddress: string,
  permissionHash: string,
  value: bigint,
): Promise<{ txHash: string }> {
  const env = loadEnv();
  const spender = await getSpender();

  const permission = await fetchPermissionByHash(smartAccountAddress, permissionHash);
  if (!permission) {
    throw new OnchainError('permission not found on-chain for useSpendPermission');
  }

  // Baseline the on-chain period spend so a retry can tell whether a FAILED attempt
  // actually pulled funds (an ambiguous broadcast failure). null = couldn't read;
  // we then fall back to the original retry behavior.
  let spentBefore: bigint | null = null;
  try {
    const s0 = await readOnchainStatus(smartAccountAddress, permissionHash);
    if (s0.spentThisPeriod !== null) spentBefore = BigInt(s0.spentThisPeriod);
  } catch {
    spentBefore = null;
  }

  // Retry ONLY the submission call. A freshly-issued permission or a not-yet-
  // deployed spender can make the first useSpendPermission simulation revert on
  // Base Sepolia before state propagates. That case is pre-broadcast and safe to
  // retry — but an ambiguous failure could occur AFTER the op was broadcast, so
  // before each retry we check whether on-chain spend advanced; if it did, a prior
  // attempt landed and we must NOT resubmit (double-pull).
  const maxAttempts = 4;
  let spend: Awaited<ReturnType<typeof spender.useSpendPermission>> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      spend = await spender.useSpendPermission({ spendPermission: permission, value, network: env.NETWORK });
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[useSessionKey] submit attempt ${attempt}/${maxAttempts} failed: ${(err as Error).message}`);
      if (attempt >= maxAttempts) break;
      if (spentBefore !== null) {
        try {
          const now = await readOnchainStatus(smartAccountAddress, permissionHash);
          if (now.spentThisPeriod !== null && BigInt(now.spentThisPeriod) >= spentBefore + value) {
            throw new OnchainError(
              'hop-1 outcome uncertain: a prior attempt appears to have pulled funds on-chain; not resubmitting',
              lastErr,
              /* possiblyConsumed */ true,
            );
          }
        } catch (checkErr) {
          if (checkErr instanceof OnchainError && checkErr.possiblyConsumed) throw checkErr;
        }
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  if (!spend) {
    throw new OnchainError(
      `useSpendPermission submission failed after ${maxAttempts} attempts: ${(lastErr as Error)?.message}`,
      lastErr,
    );
  }

  // We hold a userOpHash: the op WAS broadcast. If the wait itself fails, the op
  // may still land, so treat that as possibly-consumed (retain the reserve). A
  // completed-but-reverted op (no transactionHash) rolled back — cap NOT consumed.
  let receipt: Awaited<ReturnType<typeof spender.waitForUserOperation>>;
  try {
    receipt = await spender.waitForUserOperation({ userOpHash: spend.userOpHash });
  } catch (err) {
    throw new OnchainError(
      `hop-1 wait failed after broadcast (outcome uncertain): ${(err as Error).message}`,
      err,
      /* possiblyConsumed */ true,
    );
  }
  if (!('transactionHash' in receipt)) {
    throw new OnchainError('useSpendPermission user op did not complete', receipt);
  }
  return { txHash: receipt.transactionHash };
}

/**
 * Hop 2 of a payment: the spender pays the merchant with a REAL on-chain USDC
 * transfer, gasless via the CDP paymaster. Returns the settlement tx hash the
 * seller verifies on-chain. This is separate from the Spend Permission — the
 * permission only governs hop 1 (treasury -> spender); this moves the received
 * funds on to the merchant's payTo.
 */
export async function transferUsdcToMerchant(
  to: string,
  amount: bigint,
): Promise<{ txHash: string }> {
  const env = loadEnv();
  const spender = await getSpender();
  const op = await spender.transfer({
    to: to as `0x${string}`,
    amount,
    token: 'usdc',
    network: env.NETWORK,
  });
  const receipt = await spender.waitForUserOperation({ userOpHash: op.userOpHash });
  if (!('transactionHash' in receipt)) {
    throw new OnchainError('merchant USDC transfer user op did not complete', receipt);
  }
  return { txHash: receipt.transactionHash };
}

/**
 * REAL on-chain revocation. Returns only after the revoke user op confirms;
 * callers must update DB status ONLY after this resolves (spec §3).
 */
export async function revokeSessionKeyOnchain(
  smartAccountAddress: string,
  permissionHash: string,
): Promise<{ revokeTxHash: string }> {
  const cdp = getCdpClient();
  const env = loadEnv();
  const treasury = await getTreasury();

  const { userOpHash } = await cdp.evm.revokeSpendPermission({
    address: smartAccountAddress as `0x${string}`,
    permissionHash: permissionHash as `0x${string}`,
    network: env.NETWORK,
  });

  const result = await treasury.waitForUserOperation({ userOpHash });
  if (!('transactionHash' in result)) {
    throw new OnchainError('revokeSpendPermission user op did not complete', result);
  }
  return { revokeTxHash: result.transactionHash };
}

/** Authoritative on-chain check: is this session key live (valid AND in window)? */
export async function isSessionKeyLiveOnchain(
  smartAccountAddress: string,
  permissionHash: string,
): Promise<boolean> {
  const status = await readOnchainStatus(smartAccountAddress, permissionHash);
  return status.live;
}
