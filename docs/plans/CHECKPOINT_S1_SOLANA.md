# CHECKPOINT S1 — Solana support: resolved design (approve before code)

> Authored 2026-07-04. Phase 0 research complete. **No code has been written.** This is the STOP-and-review
> artifact required by [`docs/plans/SOLANA_SUPPORT_BRIEF.md`](SOLANA_SUPPORT_BRIEF.md) § "Checkpoint S1".
> Every claim below is cited inline; where the source is the pinned, locally-installed SDK, the path is given.
>
> **Reader:** you (the maintainer). **Decision requested:** approve the fork, the trust-boundary table, the
> token-account model (a vs b), the config shape, and the package/function list — then I build.

---

## 0. The one-line summary

CDP has **no** Spend Permissions on Solana. The on-chain primitive we build on instead is **SPL Token
delegation** (`Approve` / `Revoke`). This buys us a genuine **on-chain `maxAmountTotal`** and **genuine
on-chain revocation**, but **`expiresAt` becomes soft-only** — a real downgrade versus EVM that we flag
loudly everywhere. Payments become **single-hop** (delegate transfers treasury → merchant directly), which
is simpler and strictly better than the EVM two-hop. Recommended session model: **(a) a per-session
dedicated treasury token account funded to exactly `maxAmountTotal`**, delegate = spender.

---

## 1. THE FORK — does CDP support Spend Permissions on Solana?

**NO. Decisively no.** Spend Permissions are EVM-only in `@coinbase/cdp-sdk@1.51.2` (the pinned version) and
none is announced for Solana as of 2026-07. This is not "absent from an enum" — Solana is **structurally
excluded**:

- **The network enum is EVM-only.** `SpendPermissionNetwork` = `base | base-sepolia | ethereum |
  ethereum-sepolia | optimism | arbitrum | avalanche | polygon`. There is no `solana` / `solana-devnet`
  member. Verbatim from the installed type defs:
  [`node_modules/@coinbase/cdp-sdk/_types/openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.d.ts)
  (lines 1316–1326).
- **The data types cannot even express a Solana address.** `SpendPermission`, `CreateSpendPermissionRequest`,
  and `RevokeSpendPermissionRequest` constrain `account` / `spender` / `token` to `@pattern
  ^0x[a-fA-F0-9]{40}$` (EVM 20-byte hex). A base58 Solana address (`^[1-9A-HJ-NP-Za-km-z]{32,44}$`) is
  unrepresentable. Same file, lines 1328–1410.
- **The `SolanaClient` has zero spend-permission methods.** `SolanaClientInterface`
  ([`_types/client/solana/solana.types.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/client/solana/solana.types.d.ts),
  lines 9–22) exposes only `createAccount`, `exportAccount`, `importAccount`, `getAccount`,
  `getOrCreateAccount`, `updateAccount`, `listAccounts`, `requestFaucet`, `signMessage`, `signTransaction`,
  `listTokenBalances`, `sendTransaction`. All spend-permission code lives under `actions/evm/spend-permissions/`
  and `client/evm` only.
- **CDP's own docs confirm it.** Spend Permissions "utilize the Spend Permission Manager contract deployed on
  Base and other networks," are labeled **EVM only**, and the docs explicitly contrast that account-level
  **Policies** support "EVM and Solana" while Spend Permissions do not.
  <https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions>

**Fork resolved → Path B (SPL Token delegation).** The `SpendPermissionManager` is an EVM Solidity singleton
with no Solana counterpart. On Solana the closest native primitive is the SPL Token program's delegate model:

- **`Approve` / `ApproveChecked`** — sets a single `delegate` + a `delegated_amount` on a token account. This
  is our on-chain cap.
- **`Revoke`** — clears the delegate. This is our on-chain revocation.
- Solana's own docs literally title this pattern **"Spend Permissions"**
  (<https://solana.com/docs/payments/advanced-payments/spend-permissions>) and implement it with
  `@solana-program/token`'s `getApproveCheckedInstruction` / `getRevokeInstruction` — the exact packages
  cdp-sdk already ships.

> **Semantics differ from EVM in one important way.** An EVM Spend Permission caps what a *spender* may pull
> *from the owner's* account. An SPL delegation caps what the *delegate* may pull *from the token account it's
> delegated on*. So our per-agent session key must **be the delegate**; the owner (treasury) key is the one
> that grants and revokes. This maps cleanly onto our model — see § 3 and § 4.

---

## 2. SOLANA TRUST-BOUNDARY TABLE (the heart of S1)

One row per parameter. **Brutally honest.** The single most important line is `expiresAt`.

| Parameter | EVM today | Solana (Path B) | On-chain mechanism — or the gap | Confidence |
|---|---|---|---|---|
| **`maxAmountTotal`** | on-chain (`allowance` under single-window config; contract reverts `ExceededSpendPermission`) | **on-chain — for the active approval** | SPL `Approve` sets `delegated_amount`. In `process_transfer`, when the signer is the delegate, the token program **rejects** any transfer with `delegated_amount < amount` (`TokenError::InsufficientFunds`) and **decrements** `delegated_amount` per transfer, auto-clearing the delegate at zero. A real, program-enforced, monotonically-decreasing cap. **Caveat:** it is a *per-approval remaining allowance*, not a lifetime accumulator — a new `Approve` **overwrites** it. Our model (a) sidesteps this by approving exactly once for the lifetime total and never re-approving (see § 4). | **High** — verified from `processor.rs` (`solana-program/token`, `main`) and the installed `token.d.ts` (single scalar `delegatedAmount: bigint`). |
| **`expiresAt`** | on-chain (`SpendPermission.end`; every `spend()` reverts once `now ≥ end`) | **SOFT-ONLY — DOWNGRADE vs EVM** | **NONE.** The SPL `Account` struct has **no** slot / timestamp / expiry / duration field anywhere (fields are exactly: `mint, owner, amount, delegate, state, is_native, delegated_amount, close_authority`). `process_approve` / `process_transfer` reference no `Clock` / slot / `unix_timestamp`. An **exhaustive** scan of **all** Token-2022 extensions found **none** that adds a time-bounded or expiring delegation — "Permanent delegate" is the *opposite* (unlimited, perpetual, uncapped). A delegation "persists indefinitely until explicitly revoked or depleted through transfers." So expiry can only be enforced **off-chain** by (a) the backend refusing to sign/submit after `expiresAt`, **and/or** (b) a scheduled on-chain `Revoke` broadcast at `expiresAt`. **This must be flagged loudly** — see § 2.1. | **High** — verified from `interface/src/state.rs` and the full Token-2022 extension list (<https://www.solana-program.com/docs/token-2022/extensions>). |
| **`maxAmountPerTx`** | soft (backend only) | **soft (backend only)** — unchanged | **NONE.** SPL delegation caps the *total* (`delegated_amount`), not per-call. A single delegated `transferChecked` may drain the entire remaining allowance. Backend must reject `value > maxAmountPerTx` before signing — identical posture to EVM. | **High** |
| **`allowedRecipients`** | soft (backend only); on-chain impossible (payee pinned to spender) | **soft (backend only)** — but the flow *improves* (see § 3) | **NONE.** `transferChecked`'s destination is an arbitrary argument the backend chooses; nothing on-chain constrains it to an allowlist. **However**, unlike EVM (where funds first land on the spender), here the delegate transfers **treasury → merchant directly** — the merchant destination is chosen at the moment of the single transfer the backend builds. Still backend-enforced, but there is no intermediate custody. Empty allowlist ⇒ session `higher_risk`, every payment flagged, same as EVM. | **High** |
| **Revocation** | real (`revoke()` user op) | **real on-chain** | SPL `Revoke` sets `delegate = None`, `delegated_amount = 0` in `process_revoke`; takes effect the moment the tx confirms. **Owner-only** in the base Token program (the delegate/agent cannot revoke itself — the treasury owner key, custodied by CDP, must sign). Record the signature; the circuit breaker submits it. | **High** — verified from `processor.rs`. |

Legend: on-chain = the token program rejects a violating tx regardless of our backend. soft = only this
backend stops it. SOFT-ONLY (red flag) = a hard limit on EVM that is **soft on Solana** and must be surfaced everywhere.

**Primary sources for this table:**
- SPL Token program: `processor.rs` — <https://raw.githubusercontent.com/solana-program/token/main/program/src/processor.rs>
- SPL `Account` struct (no time field): `interface/src/state.rs` — <https://raw.githubusercontent.com/solana-program/token/main/interface/src/state.rs>
- Token-2022 extensions (none adds expiry): <https://www.solana-program.com/docs/token-2022/extensions>
- Solana-native "Spend Permissions" (delegate/allowance/revoke overview): <https://solana.com/docs/payments/advanced-payments/spend-permissions>
- Installed pin confirming single scalar delegate/allowance:
  [`node_modules/@solana-program/token/dist/types/generated/accounts/token.d.ts`](../../node_modules/@solana-program/token/dist/types/generated/accounts/token.d.ts)

### 2.1 The `expiresAt` downgrade — where it MUST be flagged (non-negotiable, per brief rule 5)

`expiresAt` is a hard on-chain limit on EVM and **soft-only** on Solana. Per the project's core rule ("never
silently downgrade a hard limit — flag it loudly"), this must appear in **all** of:

1. **Code comments** at the Solana adapter's issue/execute/revoke sites and in `src/config/network.ts`.
2. **Audit risk flag** `expiry_soft_only` on **every** Solana payment row (not just at issuance).
3. **Dashboard badge** — an "expiry not enforced on-chain" badge on every Solana session.
4. **`TRUST_BOUNDARY.md`** — restructured to a per-chain matrix; the Solana column shows `expiresAt` as soft.
5. **README** — the trust-boundary table gains a Solana column with the same soft-only marker.

**Mitigation we will implement (not a fix — a mitigation):** treat expiry as **both** an off-chain
refuse-to-sign guard **and** a scheduled on-chain `Revoke` job broadcast at/near `expiresAt`. The delegation
otherwise persists indefinitely. The *only* path to true on-chain expiry is a custom Anchor program — explicitly
a **non-goal** (brief § Non-goals); we note it, we do not build it.

---

## 3. FLOW DIFFERENCE — Solana payments are SINGLE-HOP

**Confirmed.** EVM `spend()` hard-pins the payee to the immutable `spendPermission.spender`
(`_transferFrom(token, account, spender, value)`), so an EVM payment is **two hops**: (1) pull treasury →
spender on-chain, then (2) spender → merchant via a separate backend-controlled leg.

SPL delegation does **not** pin the payee to the delegate. `transferChecked` takes an **arbitrary
destination** argument. So the delegate (our session key) signs **one** instruction that moves USDC
**treasury token account → merchant token account directly**. Single hop.

**Implications:**
- **No intermediate custody.** Funds never sit on the spender/session key. Strictly better custody posture
  than EVM.
- **Simpler settlement.** One `transferChecked` per payment, verified seller-side by reading that one
  transaction (§ 7). No separate "merchant leg."
- **`allowedRecipients` is still soft** — the backend picks the destination — but there is no
  spender-holds-funds window to reason about. Document this as a *simplification*, and reflect it in
  `TRUST_BOUNDARY.md` (Solana's fund-flow note replaces the EVM "two hops" note with "single hop").
- **The delegated transfer decrements `delegated_amount` on-chain**, so the single-hop payment *is* what draws
  down the on-chain `maxAmountTotal` cap — the cap and the payment are the same on-chain event.

---

## 4. THE TOKEN-ACCOUNT WRINKLE — one delegate per token account

**Structural fact:** an SPL token account holds **exactly one** `delegate` and **one** `delegated_amount`
(single scalar fields; no vector/map). A second `Approve` **overwrites** the previous delegate + amount — it
does not add. Verified from `interface/src/state.rs` and the installed `token.d.ts`. Consequence: **one token
account = one active session key at a time.**

Two ways to live with this:

### Option (a) — per-session dedicated treasury token account funded to exactly `maxAmountTotal`  RECOMMENDED

For each session, create a **fresh token account** owned by the treasury, **fund it with exactly
`maxAmountTotal` USDC**, and `ApproveChecked` the session key as delegate for that full amount.

- **Dodges the single-delegate limit entirely** — N concurrent sessions ⇒ N distinct token accounts, each with
  its own independent delegate + allowance. No clobbering.
- **Adds a second, independent cap for free: the account balance.** Even if the on-chain `delegated_amount`
  logic were somehow wrong, the delegate cannot move more USDC than physically sits in the account. Two
  independent on-chain ceilings (allowance **and** balance) = defense-in-depth. This is the strongest possible
  posture on Solana.
- **Enables the "approve once, never re-approve" discipline** that turns the per-approval allowance into a true
  **lifetime** `maxAmountTotal`: fund to the lifetime total, approve once, never top up. When depleted, the
  session is simply done (delegate auto-clears at zero).
- **Cost: ~rent.** A token account requires ~0.00204 SOL rent-exempt reserve. It is **reclaimable** — close the
  account on session revoke/expiry and the rent (plus any residual USDC swept back to treasury) is recovered.
  We record the `token_account` on the session row (nullable column, additive migration) and close it in the
  revoke/expiry path.
- **Fits our schema plan.** Brief already anticipates `nullable sessions.token_account for Solana option (a)`.

### Option (b) — single shared treasury token account = one active Solana session at a time

`Approve` the current session's key on the treasury's main USDC token account.

- **Simpler** (no per-session account creation, no rent).
- **But:** issuing a second Solana session **overwrites** the first's delegation (silently killing it), so only
  **one** Solana session can be active at once. Also there is no balance cap — the delegate is capped only by
  `delegated_amount`, and any external spend from that shared account races with the allowance bookkeeping.

### Recommendation: **(a)**, decisively.

It removes the concurrency limit, adds a balance cap as defense-in-depth, and enables true lifetime-total
semantics without re-approve. The only cost is ~0.00204 SOL rent per session, which is reclaimable on close.
Option (b)'s "one active session" ceiling is unacceptable for a layer whose whole job is issuing many scoped
keys. We take the rent hit.

> **Open sub-decision (resolve in implementation, not blocking S1):** whether the per-session account is a
> plain (randomly-keyed) token account or an ATA of a per-session owner sub-key. A plain token account with an
> explicit keypair is simplest for "create, fund, approve, close." ATAs are deterministic but one-per-(owner,
> mint), which would reintroduce the sharing problem unless each session gets its own owner key. Leaning: plain
> per-session token account owned by the treasury. Flagged in § 8.

---

## 5. FEES — does the fee payer need SOL, and does the CDP faucet fund SOL on devnet?

**Yes, the fee payer needs SOL; and yes, the CDP faucet funds SOL on solana-devnet.**

- **Every Solana tx costs SOL, paid by the fee payer.** "Every Solana transaction requires a fee paid in SOL"
  and "the first signer pays the transaction fee" (base fee 5,000 lamports/signature), charged even on failed
  txs. <https://solana.com/docs/core/fees>, <https://solana.com/docs/core/transactions>
- **CDP does NOT sponsor by default.** `sendTransaction`'s `useCdpSponsor` is an optional boolean; when false/
  omitted "the server wallet is responsible for paying the transaction fees." Verbatim in the installed
  schema:
  [`coinbaseDeveloperPlatformAPIs.schemas.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.d.ts)
  (lines 6960–6969, 7477–7497). Fee sponsorship exists but is **private-preview / enterprise-only** and the
  documented example is mainnet-only — **do not design assuming access.**
  <https://docs.cdp.coinbase.com/server-wallets/v2/solana-features/sponsor-transactions>
- **Which account needs SOL:** whichever CDP account is set as fee payer via
  `setTransactionMessageFeePayer(...)`. The SDK's own JSDoc sets the fee payer to the CDP account itself
  ([`_types/actions/solana/types.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/actions/solana/types.d.ts),
  lines 87, 146). For `Approve`/`Revoke` that's the **treasury/owner** account; for a delegated
  `transferChecked` the fee payer can be the **delegate** (session key) or a relayer — that account needs SOL.
  **Note the scheduled `Revoke`-at-expiry job needs its own funded fee payer** (the owner).
- **CDP faucet funds SOL (and USDC) on devnet.** Verbatim: "Request funds from the CDP Faucet on Solana devnet.
  Faucets are available for SOL, USDC, and CBTUSD."
  [`_types/openapi-client/generated/faucets/faucets.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/openapi-client/generated/faucets/faucets.d.ts)
  (lines 31–45). SDK-typed `requestFaucet` accepts `token: 'sol' | 'usdc'`
  ([`solana.types.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/client/solana/solana.types.d.ts) line
  106; `cbtusd` only via the raw OpenAPI client). Rate limits per the SDK doc table: SOL **0.00125 / request**,
  **0.0125 / rolling 24h** (~250 base-fee txs' worth per request). REST:
  `POST https://api.cdp.coinbase.com/platform/v2/solana/faucet` body `{address, token}`.
  <https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-solana-devnet>

**Setup/funding implication:** `setup.ts` for Solana must fund **two things per relevant account**: SOL for
fees (`requestFaucet({ token: 'sol' })`) **and** USDC for spending (`requestFaucet({ token: 'usdc' })`), on
solana-devnet. On **mainnet** there is no faucet — setup prints real-funding instructions (fund the treasury
with real SOL + USDC), same guarded-flip discipline as EVM. Add a **loud low-SOL flag** if any fee-payer's SOL
balance is too low to submit — especially the scheduled auto-`Revoke` job, which silently failing would leave a
delegation live past `expiresAt`. Watch the 0.0125 SOL / 24h cap when funding many sessions on devnet;
pre-fund/batch.

---

## 6. CONFIG SHAPE — both chains servable at once, `src/config/network.ts`

Two independent switches; **both chains can be enabled simultaneously**. `NETWORK` is retained as a
**backward-compat alias** so the user's live mainnet `.env` keeps working untouched.

```
EVM_NETWORK    = base | base-sepolia | off      # default: value of NETWORK, else base-sepolia
NETWORK        = base | base-sepolia            # DEPRECATED alias → EVM_NETWORK (still honored)
SOLANA_NETWORK = solana | solana-devnet | off   # default: solana-devnet
```

- **Precedence:** if `EVM_NETWORK` is set it wins; else fall back to `NETWORK`; else `base-sepolia`. Emit a
  one-line deprecation notice when only `NETWORK` is present. The user's current `.env` (`NETWORK=base`) thus
  continues to serve Base mainnet with **zero change**.
- **Solana defaults to `solana-devnet`** — safe by default; mainnet only behind the same guarded flip and boot
  banner as EVM.
- **Both on at once:** `EVM_NETWORK=base-sepolia` + `SOLANA_NETWORK=solana-devnet` serves both chains; an
  operator picks the chain per session on the create form.
- **`off`** disables a chain entirely (no adapter registered, create form hides it).

Per-chain resolution lives in `src/config/network.ts`, extended (additively — existing EVM export stays) with a
Solana table. Confirmed USDC mints (Circle, 6 decimals) and RPC defaults:

```ts
// Solana half of src/config/network.ts (shape only — final in implementation)
export type SolanaNetworkId = 'solana' | 'solana-devnet';

export interface SolanaNetworkConfig {
  id: SolanaNetworkId;
  cdpNetwork: 'solana' | 'solana-devnet';   // for cdp.solana.sendTransaction
  usdcMint: string;                          // base58
  tokenProgram: string;                      // classic Token program (USDC is NOT Token-2022)
  defaultRpcUrl: string;
  explorerCluster: 'mainnet' | 'devnet';     // Solana Explorer ?cluster=
  isTestnet: boolean;
}

export const SOLANA_NETWORKS: Record<SolanaNetworkId, SolanaNetworkConfig> = {
  'solana-devnet': {
    id: 'solana-devnet',
    cdpNetwork: 'solana-devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Circle devnet USDC, 6 decimals
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    defaultRpcUrl: 'https://api.devnet.solana.com',
    explorerCluster: 'devnet',
    isTestnet: true,
  },
  solana: {
    id: 'solana',
    cdpNetwork: 'solana',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // Circle mainnet USDC, 6 decimals
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerCluster: 'mainnet',
    isTestnet: false,
  },
};
```

Mints/decimals confirmed against Circle's official contract-address page
(<https://developers.circle.com/stablecoins/usdc-contract-addresses>); USDC = 6 decimals
(<https://solana.com/docs/payments/accept-payments/solana-pay>). USDC on Solana is on the **classic** Token
program `Tokenkeg…`, **not** Token-2022 — match this program id in verification (§ 7).

> **`cdpNetwork` value caveat:** the CDP send-transaction network enum in the installed schema is
> `{ solana, solana-devnet }` (`SendSolanaTransactionBodyNetwork`), while the CDP *docs* examples use
> `solana-devnet` / `solana-mainnet`. I will pin the exact accepted string against the installed type def at
> code time (the enum in the SDK is authoritative). Flagged in § 8.

---

## 7. VERIFIED PACKAGES + exact function names

All four packages are already **installed** (direct deps of the pinned cdp-sdk) — no new native builds, no
node-gyp (satisfies brief hard-constraint 2).

| Package | Installed | Notes |
|---|---|---|
| `@coinbase/cdp-sdk` | **1.51.2** (pinned) | Solana wallet + faucet + sign/send |
| `@solana/kit` | **5.5.1** (dep `^5.5.1`) | tx build + RPC. **Stay on 5.x** — npm `latest` is 7.0.0 but cdp-sdk pins the 5.x line; a mismatched major risks instruction/type interop drift with `@solana-program/token`. |
| `@solana-program/token` | **0.9.0** (dep `^0.9.0`) | SPL instruction builders |
| `@solana-program/system` | **0.10.0** (dep `^0.10.0`) | account creation (option (a)) |

**CDP session / sign / send / faucet — exact signatures (verbatim from installed type defs):**

- `cdp.solana.getOrCreateAccount({ name: string }) => Promise<SolanaAccount>`
  — [`_types/client/solana/solana.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/client/solana/solana.d.ts) (133–148)
- `cdp.solana.signTransaction({ address, transaction /* base64 */, idempotencyKey? }) => { signedTransaction, signature /* deprecated */ }`
  — [`_types/actions/solana/signTransaction.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/actions/solana/signTransaction.d.ts) (3–8, 43)
- `cdp.solana.sendTransaction({ network: 'solana' | 'solana-devnet', transaction /* base64 */, useCdpSponsor?, idempotencyKey? }) => { transactionSignature, signature /* deprecated */ }`  (CDP signs **and** broadcasts)
  — [`_types/actions/solana/sendTransaction.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/actions/solana/sendTransaction.d.ts) (3–8, 30)
- `cdp.solana.requestFaucet({ address, token: 'sol' | 'usdc' }) => …`
  — [`_types/client/solana/solana.types.d.ts`](../../node_modules/@coinbase/cdp-sdk/_types/client/solana/solana.types.d.ts) (102–109)
- Account-level convenience: `account.signTransaction`, `account.sendTransaction`, `account.requestFaucet` (same, `Omit<…,'address'>`).

**`@solana/kit@5.5.1` — build an arbitrary tx (per the SDK's own JSDoc examples):**

```ts
import {
  address as solanaAddress, createSolanaRpc, createTransactionMessage, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions, compileTransaction, getBase64EncodedWireTransaction,
  signature,
} from '@solana/kit';
// …assemble txMsg with fee payer + recent blockhash + instructions, then:
const transaction = getBase64EncodedWireTransaction(compileTransaction(txMsg));
// → cdp.solana.signTransaction({ transaction }) or cdp.solana.sendTransaction({ network, transaction })
```

**`@solana-program/token@0.9.0` — the cap / revoke / pay instructions (exact exports, default
`TOKEN_PROGRAM_ADDRESS`):**

- **Cap (grant):** `getApproveCheckedInstruction({ source, mint, delegate, owner, amount, decimals })` — sets
  `delegated_amount` = on-chain `maxAmountTotal`. Prefer the **Checked** variant so a wrong-mint/wrong-decimals
  tx fails fast (`decimals = 6` for USDC).
- **Revoke:** `getRevokeInstruction({ source, owner })` — owner-only; clears delegate. On-chain revocation.
- **Pay (single-hop):** `getTransferCheckedInstruction({ source, mint, destination, authority, amount, decimals })`
  — the delegate is the `authority`; program applies the same `delegated_amount` check + decrement.
- Source: [`node_modules/@solana-program/token/dist/types/generated/instructions/{approveChecked,revoke,transferChecked}.d.ts`](../../node_modules/@solana-program/token/dist/types/generated/instructions/)
  and Solana's spend-permissions doc using these exact builders
  (<https://solana.com/docs/payments/advanced-payments/spend-permissions>).
- **Account creation for option (a):** `@solana-program/system` `getCreateAccountInstruction` + token
  `getInitializeAccountInstruction` (or the ATA program if we go ATA-per-sub-key — see § 4 sub-decision).

**Seller-side verification — `@solana/kit` RPC (mirrors the EVM receipt + Transfer-log check):**

```ts
const rpc = createSolanaRpc(url);
// 1) finality
const { value } = await rpc.getSignatureStatuses([signature(sig)], { searchTransactionHistory: true }).send();
if (!value[0] || value[0].err !== null || value[0].confirmationStatus !== 'finalized') throw new Error('not finalized');
// 2) fetch finalized tx (returns null until it reaches commitment)
const tx = await rpc.getTransaction(signature(sig),
  { maxSupportedTransactionVersion: 0, commitment: 'finalized', encoding: 'jsonParsed' }).send();
if (!tx || tx.meta.err !== null) throw new Error('tx failed or not final');
// 3) verify USDC delta to seller via pre/postTokenBalances (robust to CPI/routing)
//    match owner === sellerWallet && mint === USDC_MINT; delta = BigInt(post.amount) - BigInt(pre.amount) >= price
// 4) replay-guard by the base58 signature (mirror the EVM per-txhash guard)
```

- `getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' | 'confirmed',
  encoding })` — returns `null` until the tx reaches the commitment; `meta.err === null` = success.
  <https://solana.com/docs/rpc/http/gettransaction>
- `getSignatureStatuses([sig], { searchTransactionHistory: true })` — `confirmationStatus === 'finalized'`
  (or `confirmations === null`) = settled; **must** pass `searchTransactionHistory` for older sigs.
  <https://solana.com/docs/rpc/http/getsignaturestatuses>
- Balance-delta method preferred (immune to how the transfer was constructed); use the **raw string** `amount`
  for exact bigint math. Token-balance object shape:
  <https://solana.com/docs/rpc/json-structures>. Match `programId === TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
  (USDC is classic Token, not Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
- `@solana/kit` is the RPC client cdp-sdk already ships — no `@solana/web3.js` needed.
  <https://www.solanakit.com/docs/concepts/rpc>

---

## 8. OPEN QUESTIONS / RISKS to resolve during implementation

None of these block S1 approval; all are implementation-time verifications.

1. **Exact `cdpNetwork` string.** SDK enum says `{ solana, solana-devnet }`; CDP docs examples say
   `solana-mainnet`. Pin against the installed `sendTransaction` type def (SDK is authoritative) before wiring.
2. **Live devnet smoke test of the fee/signer wiring.** Empirically confirm: fund via
   `requestFaucet({ token: 'sol' })`; build `ApproveChecked`/`transferChecked` with the CDP account as fee
   payer; send **without** `useCdpSponsor`; confirm success + SOL debit; confirm a zero-SOL fee payer is
   rejected. Docs are clear but this end-to-end signer/feePayer path is unproven locally.
3. **Per-session account form (§ 4 sub-decision).** Plain treasury-owned token account with an explicit keypair
   (leaning) vs ATA-of-per-session-owner. Decide before writing the issue path; affects the close/rent-reclaim
   path.
4. **Who signs & funds the scheduled auto-`Revoke`.** `Revoke` is owner-only; the owner (treasury, CDP-custodied)
   must sign, and its fee payer needs SOL. Confirm the revoke path has an authorized owner signer and a funded
   fee payer — and add a loud low-SOL alarm so a silently-unfunded revoke job can't leave a delegation live past
   `expiresAt`.
5. **Remaining-allowance read path.** Before signing any delegated transfer, read the token account's **live**
   `delegated_amount` (via `getAccount` / parsed account info) to reconcile with soft per-tx/recipient caps and
   to detect external spends. Confirm the exact read helper in `@solana-program/token@0.9.0`.
6. **`@solana/kit` version discipline.** Keep on the 5.x line to match cdp-sdk's `^5.5.1`. If anything pulls in
   6.x/7.x transitively, pin/resolve back to 5.x to avoid instruction/type drift with `@solana-program/token@0.9.0`.
7. **`transferChecked` vs `transfer` in seller verification.** Plain `transfer`'s parsed instruction has no
   inline `mint`; we control the payment path so we always emit `transferChecked` (mint inline) — but the
   balance-delta method is the primary check and is agnostic to this anyway.
8. **Two mainnets now reachable.** The unauthenticated/single-tenant warning gets **louder**: a bypassed backend
   now risks real funds on **two** mainnets. Restate in README and boot banner (brief already calls for this).

---

## Decision requested

Approve, and I proceed to implementation per the brief's post-S1 scope:

1. **Fork:** Path B — SPL Token delegation (no CDP Solana Spend Permissions). [ ]
2. **Trust-boundary table** (§ 2), including **`expiresAt` = soft-only, flagged in all 5 places** (§ 2.1). [ ]
3. **Single-hop payment flow** (§ 3). [ ]
4. **Token-account model: option (a)** — per-session dedicated treasury token account funded to exactly
   `maxAmountTotal`, delegate = spender (§ 4). [ ]
5. **Config shape** (§ 6) — `EVM_NETWORK` + `SOLANA_NETWORK`, `NETWORK` alias, Solana defaults devnet, both
   servable at once. [ ]
6. **Packages/functions** (§ 7) — pinned, no native builds. [ ]
```
