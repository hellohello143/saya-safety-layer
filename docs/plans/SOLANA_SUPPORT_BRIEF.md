# Instruction: Add Solana support to the AI Agent Payment Safety Layer

> Authored 2026-07-04 as the next work order for this repo (`C:\Claude\SafetyLayer`).
> Planning artifact only — no code was written alongside this document.

## Context (read first)

The repo is a working, tested (40 tests green) payment safety layer: scoped on-chain session keys
via CDP Spend Permissions + x402-shaped payments with real on-chain settlement, EVM-only today.
`.env` currently runs **Base mainnet** (`NETWORK=base`) with guardrails; Base Sepolia is the safe
default. Core principle is unchanged and non-negotiable: **hard limits enforced on-chain; the
backend is a policy/audit layer, never the last line of defense; never silently downgrade a hard
limit to a soft one — flag it loudly** (code comments + audit risk flags + `TRUST_BOUNDARY.md` +
summary to the user).

Recall context from memory (`trust-boundary-findings`, `safety-layer-build-plan`,
`installability-hardening`) and `docs/research/*` before starting.

## Mission

Add **Solana** as a second chain — devnet first, mainnet only behind the same guarded flip — so an
operator can create per-session agent keys on **either** Base or Solana from the dashboard, pay
x402-protected sellers with USDC on both, with per-chain on-chain enforcement, real revocation,
full audit, and zero behavior change to the live EVM flows.

## Hard constraints

1. **Verify-before-code (web).** The CDP SDK moves fast; re-check the latest `@coinbase/cdp-sdk`
   (pinned 1.51.2 today) and cite doc URLs in code comments, as done for EVM.
2. **No native compilation.** Node 26, no C++ toolchain on this machine. Solana deps must be
   pure-JS (`@solana/kit` — already shipped inside cdp-sdk — qualifies; avoid anything pulling
   node-gyp builds).
3. Keep `node:sqlite` + the repository layer; schema changes must be **additive** (existing rows
   survive; PRAGMA-guarded idempotent `ALTER TABLE`).
4. Money stays **bigint base units**; USDC is 6 decimals on Solana too. Addresses are per-chain
   (EVM hex vs Solana base58) — validate per chain at the API edge.
5. The **audit-never-skipped invariant** holds on every new path (one audit row per terminal path).
6. **EVM regression bar:** all existing tests stay green; live Base behavior unchanged; do not
   touch the user's mainnet `.env` settings except to add new Solana keys (defaulting to devnet).

## Known facts — priors from verified session research (re-verify, they may be stale)

- `@coinbase/cdp-sdk@1.51.2` `SpendPermissionNetwork` = `base | base-sepolia | ethereum |
  ethereum-sepolia | optimism | arbitrum | avalanche | polygon` → **no Solana Spend Permissions**
  (verified from published type defs). `SpendPermissionManager` is an EVM Solidity singleton.
- cdp-sdk has a Solana wallet API (`cdp.solana.*`) and ships `@solana/kit ^5.5.1`.
- Our x402 layer is a **custom v1-shaped flow** (402 challenge + `X-PAYMENT` header + real on-chain
  settlement verified by the seller via RPC) — we do **not** use the `@x402/*` packages. Extend the
  same pattern to Solana; do not adopt the facilitator protocol (explicitly rejected earlier).
- USDC mints to verify: Solana mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle; 6 decimals).

## Phase 0 — Mandatory research (before any code)

Answer in order; the first answer forks the whole design:

1. **Does current CDP support Spend Permissions on Solana?** (Expected: NO.) If YES → mirror the
   EVM design 1:1 and most of the below simplifies. If NO → the on-chain primitive is **SPL Token
   delegate approval** (Path B, below).
2. **SPL delegation semantics** (from the SPL Token program docs/source, not blogs): `Approve`
   (delegate + capped `delegated_amount` that decrements per delegated transfer), `Revoke`,
   `transferChecked` decimals requirement, and the **single-delegate-per-token-account** limit.
   Check Token-2022 extensions for any *time-bound* delegation (expected: none → `expiresAt` is
   soft-only on Solana).
3. **CDP Solana API surface:** `cdp.solana.getOrCreateAccount`, how to build/sign/send an arbitrary
   transaction (for Approve/Revoke/TransferChecked), who pays fees (does CDP sponsor Solana fees or
   does the spender need SOL?), devnet faucets (`requestFaucet` for SOL and USDC on solana-devnet).
4. **Seller-side verification:** `getTransaction(signature)` — how to confirm a finalized USDC
   transfer of ≥ price to the seller's token account for the right mint (this mirrors the EVM
   receipt+Transfer-log check in `mock-seller/server.ts`).

## Expected Solana trust boundary (validate in Phase 0; this is the heart of the task)

| Param | EVM today | Solana expected (Path B) | Mechanism / gap |
|---|---|---|---|
| `maxAmountTotal` | on-chain | **on-chain** | SPL `Approve` amount decrements per delegated transfer; token program rejects beyond it |
| `expiresAt` | on-chain | **SOFT-ONLY** | SPL delegation has no time bound → **a downgrade vs EVM**; per rule 5 flag loudly: code comments, `expiry_soft_only` risk flag on every Solana payment, dashboard badge, per-chain `TRUST_BOUNDARY.md`, README |
| `maxAmountPerTx` | soft | soft | unchanged |
| `allowedRecipients` | soft | soft | unchanged — but note the flow difference below |
| Revocation | real (revoke userOp) | real | SPL `Revoke` instruction; record the tx signature; circuit breaker uses it |

**Flow difference:** SPL delegation does **not** pin the payee to the delegate (unlike EVM
`spend()`), so Solana payments are **single-hop**: the spender-as-delegate transfers USDC directly
treasury → merchant. Funds never custody with the spender. Simpler and better — document it.

**Design wrinkle to resolve at Checkpoint S1:** one token account = one delegate. Options:
(a) **per-session dedicated treasury token account** funded with exactly `maxAmountTotal`,
delegate = spender (recommended: dodges the limit, adds a balance cap as defense-in-depth; costs
~rent per session, reclaimable on close), or (b) single shared token account = only one active
Solana session at a time (simpler MVP). Present both; recommend (a).

## Checkpoint S1 — STOP and present before implementing

Research findings; the resolved fork (CDP-native vs SPL delegation); the confirmed Solana
trust-boundary table; decision (a)/(b) above; and the config shape:
`EVM_NETWORK=base|base-sepolia|off` (keep `NETWORK` as a backward-compat alias) +
`SOLANA_NETWORK=solana|solana-devnet|off`, both chains servable simultaneously, per-chain
USDC/RPC resolution in `src/config/network.ts`. Get approval, then build.

## Implementation scope (after S1 approval)

1. **Chain adapter layer** `src/chains/`: interface (`issueSessionKey`, `executePayment`,
   `revokeSessionKeyOnchain`, `readOnchainStatus`, `verifySettlement`, `validateAddress`,
   `explorerUrl`) + `evm/` (behavior-preserving refactor of existing `src/cdp` + `src/x402`
   settlement paths) + `solana/` (new).
2. **Config:** as approved at S1; replicate all mainnet guardrails per chain (boot banner, mock
   seller refuses to start on mainnet without an explicit payTo, `setup.ts` per-chain: devnet
   SOL+USDC faucet vs mainnet real-funding instructions). Solana **defaults to devnet**.
3. **DB (additive):** `sessions.network`, `audit_log.network` (legacy rows default
   `'base-sepolia'`), nullable `sessions.token_account` for Solana option (a).
4. **Policy engine:** already chain-agnostic; enforce `intent.network === session.network`
   (existing `WRONG_NETWORK` reason).
5. **Mock seller:** one `accepts` entry per enabled network; per-chain on-chain verification;
   shared replay guard (tx hash / signature set). On devnet, default payTo may be the spender's own
   address (no Solana burn-address convention); on mainnet an explicit payTo stays mandatory.
6. **Dashboard:** chain selector on the create form, per-chain address validation, network column +
   explorer links (Basescan / Solana Explorer with cluster param), an **"expiry not on-chain"
   badge** on Solana sessions.
7. **agent-sim:** `--network` flag; all 4 scenarios per enabled chain (breaker must perform the
   real SPL `Revoke` on Solana). EVM sims on the user's current mainnet config spend real money —
   run Solana scenarios on devnet.
8. **Checkpoint S2** (mirrors original CP2): once Solana issuance works on devnet, present the
   updated per-chain `TRUST_BOUNDARY.md` before continuing to the payment flow.
9. **Tests:** existing 40 stay green; add Solana adapter units (mocked CDP), per-chain address
   validation, multi-network `selectRequirement`, migration-default test.
10. **Docs:** README (Solana setup, devnet faucets, fee/SOL requirements, mainnet warnings),
    `.env.example`, `TRUST_BOUNDARY.md` restructured as a per-chain matrix.

## Definition of done (Solana devnet)

- [ ] Create a Solana session with limits from the dashboard (on-chain Approve; ref recorded)
- [ ] Within-limits payment against the mock seller on devnet → `approved` + real signature,
      seller verified it on-chain
- [ ] Structured `EXCEEDS_PER_TX_LIMIT` and `EXCEEDS_TOTAL_LIMIT` rejections
- [ ] Breaker trip → suspend + **real on-chain SPL Revoke** (signature recorded) + flag
- [ ] Every attempt audited with correct decision/reason/network
- [ ] Dashboard revoke prevents further spend, verified on-chain (not just DB)
- [ ] `TRUST_BOUNDARY.md` per-chain matrix accurate — **expiry-soft-on-Solana flagged loudly**
- [ ] All tests green, including untouched EVM suite

## Non-goals

Custom Anchor/on-chain program for time-bound delegation (note it as the only path to on-chain
expiry, but do not build); x402 facilitator protocol; auth/multi-tenant (unchanged gap — restate
the warning, louder now that two mainnets are reachable); SPL tokens other than USDC.
