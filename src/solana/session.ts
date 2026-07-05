// Solana session key = SPL Token delegation. Verified against the token program
// source (github.com/solana-program/token processor.rs) + @coinbase/cdp-sdk@1.51.2
// solana API. See docs/plans/CHECKPOINT_S1_SOLANA.md.
//
// TRUST BOUNDARY (Solana):
//   maxAmountTotal    -> ApproveChecked delegated_amount. ON-CHAIN: the token
//                        program rejects any delegated transfer beyond it,
//                        decrements per transfer, auto-clears the delegate at 0.
//                        We Approve ONCE with the full total (re-Approve would
//                        OVERWRITE), giving a genuine on-chain lifetime cap.
//   expiresAt         -> NONE. SOFT-ONLY. SPL delegation has no time bound and
//                        no Token-2022 extension adds one. Enforced off-chain
//                        (policy refuse-after-expiry) — flagged loudly everywhere.
//   maxAmountPerTx    -> SOFT (unchanged).
//   allowedRecipients -> SOFT (unchanged). Payments are SINGLE-HOP: the delegate
//                        transfers treasury->merchant directly (no intermediate custody).
//   revocation        -> Revoke instruction (owner-only). REAL on-chain.
//
// FIRST-CUT MODEL (option b): one treasury token account, ONE active Solana
// session at a time (a new Approve overwrites the prior delegate). Per-session
// token accounts (option a) are the documented concurrency upgrade.
//
// Fees: NOT gasless. The treasury (Approve/Revoke fee payer + owner signer) needs
// SOL. CDP fee sponsorship is enterprise-preview; devnet SOL comes from the faucet.

import {
  address,
  pipe,
  createSolanaRpc,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  type Instruction,
} from '@solana/kit';
import {
  getApproveCheckedInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  findAssociatedTokenPda,
  fetchToken,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { getCdpClient } from '../cdp/client.js';
import { loadEnv } from '../config/env.js';
import { SOLANA_NETWORKS, type SolanaNetworkId } from '../config/network.js';

export class SolanaOnchainError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
    // True when a transfer MAY have already landed on-chain (an ambiguous
    // broadcast failure), so the caller must treat the cap as consumed and NOT
    // release the reserve — the alternative would be a double-payment.
    readonly capMaybeConsumed = false,
  ) {
    super(message);
    this.name = 'SolanaOnchainError';
  }
}

// Heuristic: did this error mean "the token account genuinely doesn't exist" (a
// real not-found) rather than "we couldn't read it" (RPC outage/timeout)? Only
// the former is safe to report as found:false; the latter must propagate.
function isAccountNotFound(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /not\s*found|does not exist|could not be found|no account/i.test(msg);
}

function solNetId(): SolanaNetworkId {
  const env = loadEnv();
  if (!env.SOLANA_ENABLED || !env.SOLANA_NETWORK) {
    throw new SolanaOnchainError('Solana is not enabled (set SOLANA_NETWORK=solana-devnet|solana)');
  }
  return env.SOLANA_NETWORK;
}
function solCfg() {
  return SOLANA_NETWORKS[solNetId()];
}
function rpc() {
  return createSolanaRpc(loadEnv().SOLANA_RPC_URL as string);
}

type SolanaAccount = Awaited<ReturnType<ReturnType<typeof getCdpClient>['solana']['getOrCreateAccount']>>;
let treasuryCache: SolanaAccount | null = null;
let spenderCache: SolanaAccount | null = null;

export async function getSolanaTreasury(): Promise<SolanaAccount> {
  if (treasuryCache) return treasuryCache;
  const cdp = getCdpClient();
  const env = loadEnv();
  treasuryCache = await cdp.solana.getOrCreateAccount({ name: env.CDP_SOLANA_TREASURY_ACCOUNT_NAME });
  return treasuryCache;
}
export async function getSolanaSpender(): Promise<SolanaAccount> {
  if (spenderCache) return spenderCache;
  const cdp = getCdpClient();
  const env = loadEnv();
  spenderCache = await cdp.solana.getOrCreateAccount({ name: env.CDP_SOLANA_SPENDER_ACCOUNT_NAME });
  return spenderCache;
}

/** The USDC associated token account for any owner wallet. */
export async function usdcAtaOf(ownerAddress: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(ownerAddress),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: address(solCfg().usdcMint),
  });
  return ata;
}

/**
 * Build, sign (via CDP), and broadcast a tx where `account` is fee payer + signer.
 * Returns the signature AND the blockhash's lastValidBlockHeight so callers can
 * confirm the outcome and know exactly when the tx can no longer land.
 */
async function submit(
  account: SolanaAccount,
  instructions: Instruction[],
): Promise<{ signature: string; lastValidBlockHeight: bigint }> {
  const {
    value: { blockhash, lastValidBlockHeight },
  } = await rpc().getLatestBlockhash().send();
  const txMsg = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(account.address), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const transaction = getBase64EncodedWireTransaction(compileTransaction(txMsg));
  const res = await account.sendTransaction({ network: solCfg().cdpNetwork, transaction });
  return { signature: res.transactionSignature, lastValidBlockHeight: BigInt(lastValidBlockHeight) };
}

/**
 * Poll a broadcast signature to a terminal outcome. Returns 'confirmed' (landed
 * OK) or 'failed' (landed with an error). Throws SolanaOnchainError only once the
 * tx can NEVER land — i.e. its blockhash has expired (current height >
 * lastValidBlockHeight) and it never appeared — so we never falsely fail a tx
 * that could still confirm (which would orphan a later-landing on-chain effect).
 */
async function confirmSignature(
  signature: string,
  lastValidBlockHeight: bigint,
): Promise<'confirmed' | 'failed'> {
  const r = rpc();
  for (let i = 0; i < 60; i++) {
    try {
      const { value } = (await r.getSignatureStatuses([signature] as never).send()) as unknown as {
        value: ({ err: unknown; confirmationStatus?: string } | null)[];
      };
      const st = value?.[0];
      if (st) {
        if (st.err) return 'failed';
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
      } else {
        const height = BigInt((await r.getBlockHeight().send()) as unknown as bigint);
        if (height > lastValidBlockHeight) {
          throw new SolanaOnchainError(`transaction ${signature} expired without landing (dropped)`);
        }
      }
    } catch (err) {
      if (err instanceof SolanaOnchainError) throw err;
      /* transient RPC error — keep polling */
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new SolanaOnchainError(`transaction ${signature} not confirmed within the timeout`);
}

export interface IssuedSolanaSession {
  treasuryAddress: string;
  spenderAddress: string;
  mint: string;
  tokenAccount: string;
  approveSignature: string;
}

/**
 * Approve the spender as delegate of the treasury's USDC ATA for `maxAmountTotal`
 * (the on-chain cap). One tx, signed by the treasury (fee payer + owner).
 */
export async function issueSolanaSessionKey(maxAmountTotal: bigint): Promise<IssuedSolanaSession> {
  const treasury = await getSolanaTreasury();
  const spender = await getSolanaSpender();
  const cfg = solCfg();
  const ata = await usdcAtaOf(treasury.address);

  const ix = getApproveCheckedInstruction({
    source: address(ata),
    mint: address(cfg.usdcMint),
    delegate: address(spender.address),
    owner: createNoopSigner(address(treasury.address)), // CDP fills the treasury signature
    amount: maxAmountTotal,
    decimals: cfg.usdcDecimals,
  });

  const { signature: approveSignature, lastValidBlockHeight } = await submit(treasury, [ix]);

  // sendTransaction returns after broadcast, not finalization — so confirm the
  // Approve actually LANDED on-chain. If it failed or was dropped, throw so the
  // caller records the issuance as failed instead of a session whose on-chain cap
  // was never created.
  const outcome = await confirmSignature(approveSignature, lastValidBlockHeight);
  if (outcome === 'failed') {
    throw new SolanaOnchainError(`Approve (delegation) transaction failed on-chain: ${approveSignature}`);
  }

  // Confirmed on-chain. Best-effort wait for the delegation to be readable so the
  // session is immediately usable (non-fatal — the Approve is already confirmed).
  for (let i = 0; i < 8; i++) {
    try {
      if ((await readSolanaOnchainStatus(ata, spender.address)).live) break;
    } catch {
      /* not yet visible on this RPC node */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return {
    treasuryAddress: treasury.address,
    spenderAddress: spender.address,
    mint: cfg.usdcMint,
    tokenAccount: ata,
    approveSignature,
  };
}

/**
 * REAL on-chain revocation: Revoke clears the delegate. Owner (treasury) signs.
 * sendTransaction returns after BROADCAST, not finalization, and a tx can be
 * dropped — so for the safety-critical revoke direction we confirm the delegate
 * actually cleared on-chain (resubmitting once if needed; Revoke is idempotent).
 * Throws if it can't be confirmed, so callers never record a false 'revoked'.
 */
export async function revokeSolanaSessionKey(tokenAccount: string, expectedDelegate?: string): Promise<string> {
  const treasury = await getSolanaTreasury();
  const buildIx = () =>
    getRevokeInstruction({
      source: address(tokenAccount),
      owner: createNoopSigner(address(treasury.address)),
    });

  let { signature } = await submit(treasury, [buildIx()]);
  // Poll until the delegate is cleared. ~18s window; resubmit once at the halfway
  // point in case the first broadcast was dropped.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const acct = await fetchToken(rpc(), address(tokenAccount));
      const delegate = optionValue<string>(acct.data.delegate);
      const cleared = delegate === null || (expectedDelegate !== undefined && delegate !== expectedDelegate);
      if (cleared) return signature;
    } catch {
      /* transient read failure — keep polling */
    }
    if (i === 6) {
      try {
        signature = (await submit(treasury, [buildIx()])).signature;
      } catch {
        /* resubmit failed; keep polling the original */
      }
    }
  }
  throw new SolanaOnchainError(`revoke not confirmed on-chain for token account ${tokenAccount}`);
}

// @solana/kit Option -> value | null (handles both raw and {__option} shapes).
function optionValue<T>(o: unknown): T | null {
  if (o == null) return null;
  if (typeof o === 'object' && o !== null && '__option' in o) {
    const opt = o as { __option: string; value?: T };
    return opt.__option === 'Some' ? (opt.value ?? null) : null;
  }
  return o as T;
}

export interface SolanaOnchainStatus {
  found: boolean;
  delegate: string | null;
  delegatedAmount: bigint;
  live: boolean; // delegate == expectedDelegate AND allowance > 0
}

/** Read the token account's delegate + remaining delegated_amount on-chain. */
export async function readSolanaOnchainStatus(
  tokenAccount: string,
  expectedDelegate: string,
): Promise<SolanaOnchainStatus> {
  try {
    const acct = await fetchToken(rpc(), address(tokenAccount));
    const delegate = optionValue<string>(acct.data.delegate);
    const delegatedAmount = BigInt(acct.data.delegatedAmount as unknown as bigint);
    const live = delegate !== null && delegate === expectedDelegate && delegatedAmount > 0n;
    return { found: true, delegate, delegatedAmount, live };
  } catch (err) {
    // A genuinely-absent account is a real not-found; anything else (RPC outage,
    // timeout, decode error) must propagate so callers don't mistake a transient
    // failure for a missing/zeroed delegation.
    if (isAccountNotFound(err)) {
      return { found: false, delegate: null, delegatedAmount: 0n, live: false };
    }
    throw new SolanaOnchainError(`could not read token account ${tokenAccount}: ${(err as Error).message}`, err);
  }
}

/** Fund a Solana account with devnet SOL (for fees) and/or USDC. Testnet only. */
export async function fundSolana(
  token: 'sol' | 'usdc',
  target: 'treasury' | 'spender' = 'treasury',
): Promise<{ signature: string }> {
  const account = target === 'spender' ? await getSolanaSpender() : await getSolanaTreasury();
  const res = await account.requestFaucet({ token });
  return { signature: res.signature };
}

/**
 * SINGLE-HOP payment: the delegate (spender) transfers `amount` USDC from the
 * treasury token account directly to the merchant's ATA via transferChecked. The
 * token program enforces the delegated_amount cap on-chain. Signed + fee-paid by
 * the spender (needs SOL). Creates the merchant ATA idempotently.
 */
export async function executeSolanaPayment(
  treasuryTokenAccount: string,
  merchantWallet: string,
  amount: bigint,
  expectedDelegate?: string,
): Promise<{ signature: string }> {
  const spender = await getSolanaSpender();
  const cfg = solCfg();
  const merchantAta = await usdcAtaOf(merchantWallet);
  const payer = createNoopSigner(address(spender.address));
  const delegate = expectedDelegate ?? spender.address;

  const createIx = getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: address(merchantAta),
    owner: address(merchantWallet),
    mint: address(cfg.usdcMint),
  });
  const transferIx = getTransferCheckedInstruction({
    source: address(treasuryTokenAccount),
    mint: address(cfg.usdcMint),
    destination: address(merchantAta),
    authority: payer, // the delegate; program applies the delegated_amount cap
    amount,
    decimals: cfg.usdcDecimals,
  });

  // Snapshot the on-chain delegated_amount so a failed-then-retried attempt can
  // detect whether the FAILED attempt actually landed. sendTransaction returns
  // after broadcast, and if its response is lost we can't tell from the error
  // alone — a blind resubmit would DOUBLE-PAY the merchant. Best-effort: if the
  // snapshot read fails we fall back to the original retry behavior.
  let allowanceBefore: bigint | null = null;
  try {
    const s0 = await readSolanaOnchainStatus(treasuryTokenAccount, delegate);
    if (s0.found) allowanceBefore = s0.delegatedAmount;
  } catch {
    allowanceBefore = null;
  }

  // Retry the submission (fresh blockhash each attempt) to ride out propagation of
  // a just-issued delegation. Logs the real error so failures are diagnosable.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { signature } = await submit(spender, [createIx, transferIx]);
      return { signature };
    } catch (err) {
      lastErr = err;
      console.error(`[solana pay] attempt ${attempt}/3 failed: ${(err as Error).message}`);
      if (attempt >= 3) break;
      // Before resubmitting, check whether the just-failed attempt actually landed
      // (the delegated_amount would have dropped). If so, the merchant was paid —
      // do NOT resubmit; fail closed as "settlement uncertain" with the cap marked
      // consumed so the reserve is retained.
      if (allowanceBefore !== null) {
        try {
          const now = await readSolanaOnchainStatus(treasuryTokenAccount, delegate);
          if (now.found && now.delegatedAmount <= allowanceBefore - amount) {
            throw new SolanaOnchainError(
              'settlement uncertain: a prior attempt appears to have landed on-chain; not resubmitting to avoid double-payment',
              err,
              /* capMaybeConsumed */ true,
            );
          }
        } catch (checkErr) {
          if (checkErr instanceof SolanaOnchainError && checkErr.capMaybeConsumed) throw checkErr;
          // couldn't verify — fall through to the (best-effort) retry
        }
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new SolanaOnchainError(`transfer failed after retries: ${(lastErr as Error)?.message}`, lastErr);
}

export interface SolanaPaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  settlement: 'onchain-solana';
  payload: { from: string; to: string; value: string; mint: string; signature: string };
}

/** Build the base64 X-PAYMENT header the seller verifies on-chain. */
export function buildSolanaPaymentHeader(p: {
  from: string;
  to: string;
  value: bigint;
  mint: string;
  signature: string;
}): string {
  const payload: SolanaPaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: solNetId(),
    settlement: 'onchain-solana',
    payload: { from: p.from, to: p.to, value: p.value.toString(), mint: p.mint, signature: p.signature },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * Seller-side verification: confirm the tx `signature` actually transferred
 * >= `minAmount` USDC to `sellerWallet` on-chain (via post/pre token-balance
 * delta for the seller's USDC account). Mirrors the EVM receipt+log check.
 */
export async function verifySolanaSettlement(
  signature: string,
  sellerWallet: string,
  minAmount: bigint,
): Promise<boolean> {
  const mint = solCfg().usdcMint;
  // @solana/kit's getTransaction response typing is intricate; read it loosely.
  const tx = (await rpc()
    .getTransaction(signature as never, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    .send()) as unknown as {
    meta?: {
      err?: unknown;
      preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
      postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    } | null;
  } | null;

  if (!tx || !tx.meta || tx.meta.err) return false;
  const post = tx.meta.postTokenBalances ?? [];
  const pre = tx.meta.preTokenBalances ?? [];
  const postEntry = post.find((b) => b.owner === sellerWallet && b.mint === mint);
  if (!postEntry) return false;
  const preEntry = pre.find((b) => b.accountIndex === postEntry.accountIndex);
  const delta = BigInt(postEntry.uiTokenAmount.amount) - BigInt(preEntry?.uiTokenAmount.amount ?? '0');
  return delta >= minAmount;
}
