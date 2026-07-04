# TRUST BOUNDARY

**This is the entire point of the project.** Hard limits must be enforced by the smart-contract
account itself (CDP Spend Permissions / `SpendPermissionManager`). This backend is a policy / config /
audit layer *on top of* that on-chain enforcement — a convenience and observability layer, **not** the
last line of defense. This document states, per parameter, exactly where enforcement lives.

- **Source of truth:** `SpendPermissionManager.sol` v1.0.0, deployed at
  [`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`](https://basescan.org/address/0xf85210B21cC50302F477BA56686d2019dC9b67Ad)
  (same address on Base Sepolia), read verbatim in
  [`docs/research/SpendPermissionManager.reference.sol`](docs/research/SpendPermissionManager.reference.sol).
- **SDK:** `@coinbase/cdp-sdk@1.51.2`.
- **Full analysis + citations:** [`docs/research/CDP_X402_RESEARCH.md`](docs/research/CDP_X402_RESEARCH.md).
- **Implementation:** [`src/cdp/spendPermissions.ts`](src/cdp/spendPermissions.ts) (issue/revoke),
  [`src/cdp/onchain.ts`](src/cdp/onchain.ts) (authoritative on-chain reads).

## Per-chain summary (read this first)

The layer supports two chains with **different** on-chain primitives — so the trust boundary is
**not identical** between them. The critical difference: **`expiresAt` is enforced on-chain on EVM but
SOFT-ONLY on Solana.**

| Parameter | EVM (Base) — CDP Spend Permissions | Solana — SPL Token delegation |
|---|---|---|
| **`maxAmountTotal`** | **On-chain** (`allowance`, single-window) | **On-chain** (`ApproveChecked` `delegated_amount`) |
| **`expiresAt`** | **On-chain** (`end`; `spend()` reverts) | **SOFT-ONLY** — SPL delegation has no time bound; no Token-2022 extension adds one |
| **`maxAmountPerTx`** | Soft | Soft |
| **`allowedRecipients`** | Soft | Soft |
| **Revocation** | Real on-chain (`revoke()`) | Real on-chain (`Revoke`, owner-only) |
| **Fund flow** | Two-hop (pull to spender → pay merchant) | Single-hop (delegate transfers treasury → merchant) |
| **Gas** | Gasless (CDP paymaster) | Needs SOL (fee payer) |

**Solana `expiresAt` downgrade** is flagged everywhere per the never-downgrade-silently rule: in code
([`src/solana/session.ts`](src/solana/session.ts)), on the session API (`expiryEnforcedOnChain: false`),
in the dashboard ("expiry:soft" badge + create-form warning), and here. On Solana, expiry is enforced
only by this backend refusing to sign after `expiresAt` (a future upgrade is a scheduled on-chain
`Revoke` at expiry; the only path to true on-chain expiry is a custom program — out of scope).

Solana source of truth: token program `processor.rs`
([solana-program/token](https://github.com/solana-program/token)); analysis in
[`docs/plans/CHECKPOINT_S1_SOLANA.md`](docs/plans/CHECKPOINT_S1_SOLANA.md).

## EVM (Base) — CDP Spend Permissions

| Parameter | Enforcement | On-chain mechanism (or why none) | Confidence | Reference |
|---|---|---|---|---|
| **`expiresAt`** | **On-chain by CDP** | `SpendPermission.end` (uint48, exclusive). Every `spend()` calls `getCurrentPeriod()`, which reverts `BeforeSpendPermissionStart` if `now < start` and `AfterSpendPermissionEnd` once `now >= end`. We also soft-check it for clean errors. | High | [SpendPermissionManager.sol `getCurrentPeriod`](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol) |
| **`maxAmountTotal`** | **On-chain by CDP** (via our single-window config) | `SpendPermission.allowance` (uint160). `allowance` is natively a **recurring per-period** cap that resets each `period`; there is **no lifetime accumulator**. We deliberately issue every session with a **single non-resetting window** (`start = now`, `end = expiresAt`, `period = end − start`), so `allowance = maxAmountTotal` becomes a true lifetime cap the contract enforces: `spend()` reverts `ExceededSpendPermission` once cumulative spend > allowance. | High | [`_useSpendPermission`](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol); config in [`spendPermissions.ts`](src/cdp/spendPermissions.ts) |
| **`maxAmountPerTx`** | **SOFT — backend only** | **None.** The contract has no per-transaction field; the only single-call ceilings are the *remaining per-period allowance* and a `uint160` overflow guard. A single `spend()` may drain the entire remaining allowance. Our backend must reject `value > maxAmountPerTx` before calling `useSpendPermission`. | High | [docs/SpendPermissionAccounting.md](https://github.com/coinbase/spend-permissions/blob/main/docs/SpendPermissionAccounting.md) |
| **`allowedRecipients`** | **SOFT — backend only** (on-chain is architecturally impossible) | **None.** `spend()` hard-codes the payee to the immutable `spendPermission.spender` (`_transferFrom(token, account, spender, value)`), and `requireSender(spender)` forces the caller to *be* that spender. There is no recipient argument, no allowlist field, and `extraData` is never decoded to a destination. Funds can only ever reach the one `spender`; where the spender forwards them afterward is outside the contract's guarantees. Our backend is the **only** thing enforcing which merchants may be paid. Empty allowlist ⇒ session marked `higher_risk` and every payment flagged. | High | [`spend` / `_transferFrom`](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol) |

Legend: **On-chain by CDP** = the smart contract reverts a violating transaction regardless of our
backend. **SOFT — backend only** = nothing on-chain stops it; only this backend does.

## Solana — SPL Token delegation

Verified from the token program source (`processor.rs`). The treasury owner `ApproveChecked`s the
spender as a **delegate** of its USDC token account with a capped `delegated_amount`; the delegate
pays merchants directly via `transferChecked` (single-hop). Implementation:
[`src/solana/session.ts`](src/solana/session.ts).

| Parameter | Enforcement | On-chain mechanism (or why none) | Confidence |
|---|---|---|---|
| **`maxAmountTotal`** | **On-chain** | `ApproveChecked` sets `delegated_amount`; the program **rejects** any delegated transfer beyond it (`InsufficientFunds`), **decrements** it per transfer, and **auto-clears** the delegate at 0. We `Approve` **once** with the full total (a re-`Approve` overwrites), giving a genuine on-chain lifetime cap. | High |
| **`expiresAt`** | **SOFT — backend only** | **None, architecturally.** A token account has no slot/timestamp field, and an exhaustive scan of Token-2022 extensions found **no** time-bounded delegation. Enforced off-chain by the policy engine refusing to sign after `expiresAt`. This is a **downgrade vs EVM** — flagged in code, API, dashboard, and here. | High |
| **`maxAmountPerTx`** | **SOFT — backend only** | No per-transfer field. Backend rejects `value > maxAmountPerTx`. | High |
| **`allowedRecipients`** | **SOFT — backend only** | Delegation doesn't constrain the payee; the delegate can transfer to anyone. Backend enforces the allowlist. Empty ⇒ `higher_risk`. | High |
| **Revocation** | **On-chain** | `Revoke` clears the delegate (owner-only). Real, immediate on-chain revocation; the circuit breaker uses it. | High |

**Concurrency note (first cut):** one token account has at most one delegate, so this cut allows **one
active Solana session at a time** (option b). Per-session token accounts (option a) are the documented
concurrency upgrade.

## What this means for the security model

Two of the four limits (**`maxAmountPerTx`**, **`allowedRecipients`**) are **not** enforced on-chain and
never can be with the current `SpendPermissionManager`. A bypassed, buggy, or malicious backend removes
those two protections entirely. This is called out loudly here, in code comments
([`spendPermissions.ts`](src/cdp/spendPermissions.ts)), and — once the audit log lands — as per-payment
risk flags. We are **not** silently downgrading any hard limit: `expiresAt` and `maxAmountTotal` are
genuinely on-chain; the other two are honestly labeled soft.

### Fund-flow consequence (important)
Because `spend()` always delivers to the `spender`, a payment is **two hops**: (1) pull funds from the
treasury smart account to our spender (on-chain, capped by `allowance`/`end`), then (2) the spender pays
the merchant via a separate x402 leg the backend controls. The Spend Permission never pays a merchant
directly — so merchant-recipient control is inherently a backend responsibility.

## How to verify on-chain (not just in our DB)

`src/cdp/onchain.ts` reads the manager directly via viem (`isApproved`, `isRevoked`, `isValid`,
`getCurrentPeriod`) rather than trusting our database or the indexed API:

- **`GET /api/sessions/:id?onchain=true`** returns the live on-chain status alongside the DB row:
  `isValid`, `isRevoked`, `withinWindow`, `live`, and remaining allowance read from the chain.
- **Revocation** (`revokeSessionKeyOnchain`) submits a real `revoke()` user op and only flips DB status
  to `revoked` after the user op confirms (recording the revoke tx hash). Re-reading `isRevoked` from the
  manager afterward confirms it on-chain.

> Note: `isValid()` alone checks approved-AND-not-revoked but **not** the `[start, end)` window (that is
> enforced inside `getCurrentPeriod`/`spend`). Our `live` flag combines `isValid` with an explicit
> `start <= now < end` check.
