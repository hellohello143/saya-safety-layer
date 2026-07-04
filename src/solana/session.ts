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
//   expiresAt         -> NONE. 🔴 SOFT-ONLY. SPL delegation has no time bound and
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
  ) {
    super(message);
    this.name = 'SolanaOnchainError';
  }
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

/** Build, sign (via CDP), and broadcast a tx where `account` is fee payer + signer. */
async function submit(account: SolanaAccount, instructions: Instruction[]): Promise<string> {
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
  return res.transactionSignature;
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

  const approveSignature = await submit(treasury, [ix]);
  // Wait for the delegation to be visible on-chain (sendTransaction returns after
  // broadcast, not finalization) so the session is immediately usable for payment.
  for (let i = 0; i < 12; i++) {
    try {
      const st = await readSolanaOnchainStatus(ata, spender.address);
      if (st.live) break;
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

/** REAL on-chain revocation: Revoke clears the delegate. Owner (treasury) signs. */
export async function revokeSolanaSessionKey(tokenAccount: string): Promise<string> {
  const treasury = await getSolanaTreasury();
  const ix = getRevokeInstruction({
    source: address(tokenAccount),
    owner: createNoopSigner(address(treasury.address)),
  });
  return submit(treasury, [ix]);
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
  } catch {
    return { found: false, delegate: null, delegatedAmount: 0n, live: false };
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
): Promise<{ signature: string }> {
  const spender = await getSolanaSpender();
  const cfg = solCfg();
  const merchantAta = await usdcAtaOf(merchantWallet);
  const payer = createNoopSigner(address(spender.address));

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

  // Retry the submission (fresh blockhash each attempt) to ride out propagation of
  // a just-issued delegation. Logs the real error so failures are diagnosable.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const signature = await submit(spender, [createIx, transferIx]);
      return { signature };
    } catch (err) {
      lastErr = err;
      console.error(`[solana pay] attempt ${attempt}/3 failed: ${(err as Error).message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
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
