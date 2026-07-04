# CDP + x402 Research Report: AI-Agent Payment Safety Layer

**Target stack:** TypeScript/Node, Fastify, SQLite/Drizzle, Base Sepolia, test USDC
**Report date:** 2026-07-03
**Verified SDK:** `@coinbase/cdp-sdk@1.51.2` (latest, published 2026-06-18)

---

## 1. Executive Summary

Coinbase Developer Platform (CDP) **Server Wallets v2** + the **Spend Permissions** system give us a real, on-chain-enforced spending-limit primitive for an autonomous agent, and **x402** gives us the HTTP-402 pay-per-request settlement layer on the same USDC/Base rails. Concretely:

- **CDP Smart Accounts** are ERC-4337 accounts (Base Sepolia + Base mainnet only) that we create via the Node SDK, owned by a CDP-managed EOA ("Server Wallet"). On Base Sepolia, user operations are **gasless** via the CDP Paymaster.
- **Spend Permissions** are standing, on-chain authorizations recorded in the singleton `SpendPermissionManager` contract (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`, same address on every supported chain). Once approved, a designated **spender** can pull funds from the smart account up to an `allowance` per recurring `period`, bounded by `[start, end)`. The contract enforces the allowance cap, the period reset, and the time window on-chain — every `spend()` reverts if violated.
- **x402** lets a resource server demand payment via an HTTP `402` response; the client attaches an `X-PAYMENT` header and a facilitator verifies/settles it. It runs on Base (incl. Base Sepolia via CDP's hosted facilitator) using EIP-3009 `transferWithAuthorization` for USDC.

### The single most important caveat

**The on-chain contract enforces exactly THREE things about a spend: (1) the per-period allowance cap, (2) the `[start, end)` time window, and (3) that funds go to the immutable `spender` address (which must also be the caller). It does NOT enforce a per-transaction cap, a lifetime/cumulative cap, or an allowlist of arbitrary recipients.** These three policy dimensions — **per-tx cap, lifetime total, and recipient allowlisting** — have **no on-chain surface** in `SpendPermissionManager` and **must be soft-enforced by our backend spender service**. Any marketing or doc language implying CDP "enforces your spending limits" refers only to the per-period `allowance` + time window. Downstream code MUST treat per-tx, lifetime, and recipient rules as our responsibility. See §8 (Trust Boundary Table) and §9 (Red Flags).

---

## 2. Verified Package Set (exact versions)

| Package | Version | Role | Source |
|---|---|---|---|
| `@coinbase/cdp-sdk` | **1.51.2** (latest; 79 versions; created 2025-04-07, latest published 2026-06-18) | Node/TS Server Wallet + Smart Account + Spend Permission API | https://registry.npmjs.org/@coinbase/cdp-sdk/latest |
| `viem` | `^2.47.0` (runtime dep of cdp-sdk; use for `parseUnits`/`parseEther`, public client, direct contract reads) | EVM utils + optional direct contract reads of the manager | https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md |
| `zod` | `^3.25.76` (runtime dep) | Schema validation (transitive) | (cdp-sdk deps) |
| `abitype` | `1.0.6` (runtime dep) | ABI typing (transitive) | (cdp-sdk deps) |
| `axios` | `1.16.0` (runtime dep) | HTTP client (transitive) | (cdp-sdk deps) |
| `jose` | `^6.2.0` (runtime dep) | JWT auth for CDP API (transitive) | (cdp-sdk deps) |
| `x402` | **1.2.0** (latest; "x402 Payment Protocol"; deps `viem ^2.21.26`, `wagmi ^2.15.6`) | Core x402 protocol types | https://registry.npmjs.org/x402/latest |
| `x402-fetch` / `x402-axios` / `x402-express` | (companion packages — enumerate before use; see §6 open item) | Client wrappers / server middleware | https://github.com/coinbase/x402 |
| `dotenv` | (optional) | Load `CDP_*` env vars | README |

**Not the same package family:** `@coinbase/cdp-hooks`, `@coinbase/cdp-core`, `@coinbase/cdp-react` are **front-end / embedded-wallet** companions (React `useCreateSpendPermission`, `useRevokeSpendPermission`). Our backend uses only the Node `@coinbase/cdp-sdk`.

**Install:**
```bash
npm install @coinbase/cdp-sdk
# x402 client (pick the wrapper matching your HTTP client):
npm install x402 x402-fetch   # or x402-axios
```
Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md

---

## 3. Smart Account Creation

### Verified current API

Smart Accounts are **ERC-4337 account-abstraction accounts, supported only on Base Sepolia and Base Mainnet.** They require an **owner EOA** to sign on their behalf.

**Client init** (create once, reuse):
```ts
// source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md
import { CdpClient } from "@coinbase/cdp-sdk";
import dotenv from "dotenv";
dotenv.config();

// Reads CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET from env:
const cdp = new CdpClient();

// or pass explicitly:
const cdp2 = new CdpClient({
  apiKeyId: "YOUR_API_KEY_ID",
  apiKeySecret: "YOUR_API_KEY_SECRET",
  walletSecret: "YOUR_WALLET_SECRET",
});
```

**Create owner EOA + Smart Account:**
```ts
// source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md
const owner = await cdp.evm.getOrCreateAccount({ name: "Owner" });
const smartAccount = await cdp.evm.getOrCreateSmartAccount({
  name: "SmartAccount",
  owner,
  enableSpendPermissions: true, // REQUIRED for the spend-permission flow (see below)
});
```

`enableSpendPermissions?: boolean` is a real field on `CreateSmartAccountOptions`, `GetOrCreateSmartAccountOptions`, and `UpdateEvmSmartAccountOptions` in v1.51.2.
Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk@1.51.2/_types/client/evm/evm.types.d.ts
Docs snippet using `enableSpendPermissions: true`: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions

### The CDP Server Wallet ownership requirement (CRITICAL)

Verbatim from CDP docs:

> "Creating Spend Permissions is currently only supported on CDP Smart Accounts owned by CDP Server Wallets."

Source: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions

**Implication for our design:** the smart account's `owner` must be a **CDP-managed EOA** (`cdp.evm.getOrCreateAccount(...)`), not an arbitrary external EOA, if we want to create spend permissions through the SDK. Mechanically, when a spend permission is approved, the `SpendPermissionManager` singleton is added as an **owner of the smart account**, which lets it pull funds within the permission's constraints. On Base Sepolia the operations are gasless (CDP Paymaster).

> **Open item to confirm before coding:** whether `createSpendPermission` transparently handles first-time smart-account deployment + the on-chain approval (ERC-6492 wrap when the account is counterfactual/undeployed), or whether an explicit deploy/approve step is needed. Verify against live docs; do not assume.

---

## 4. Spend Permission Creation

### SDK surface (v1.51.2)

```ts
// source: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions
import { parseUnits, type SpendPermissionInput } from "@coinbase/cdp-sdk";

const spendPermission: SpendPermissionInput = {
  account: smartAccount.address,   // token owner (our user's smart account)
  spender: spender.address,        // the agent/backend address authorized to pull
  token: "usdc",                   // "eth" | "usdc" | ERC-20 Address
  allowance: parseUnits("0.01", 6),// per-PERIOD cap, smallest unit (6 decimals)
  periodInDays: 1,                 // recurring reset window
};

const { userOpHash } = await cdp.evm.createSpendPermission({
  network: "base-sepolia",
  spendPermission,
});
const result = await smartAccount.waitForUserOperation({ userOpHash });
```

`CreateSpendPermissionOptions = { spendPermission: SpendPermissionInput; network: SpendPermissionNetwork; paymasterUrl?: string; idempotencyKey? }`. Returns `{ userOpHash }`.
Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk@1.51.2/_types/spend-permissions/types.d.ts

`SpendPermissionNetwork` = `base | base-sepolia | ethereum | ethereum-sepolia | optimism | arbitrum | avalanche | polygon`.
Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk@1.51.2/_types/openapi-client/generated/coinbaseDeveloperPlatformAPIs.schemas.d.ts

### SDK input defaulting logic (`resolveSpendPermission`)

- Exactly **one** of `period` (seconds) or `periodInDays` must be given — supplying both or neither throws `UserInputValidationError`. `period = periodInDays * 86400`.
- `start` defaults to `now` (unix seconds). `end` defaults to `281474976710655` (max `uint48`, i.e. **"never expires"**) if omitted.
- `salt` defaults to a random 32-byte bigint; `extraData` defaults to `0x`.
- `token: "eth"` → native sentinel `0xEeee…EEeE`; `token: "usdc"` is auto-resolved **only on `base` / `base-sepolia`** (else pass an explicit ERC-20 address).

Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk@1.51.2/_types/spend-permissions/types.d.ts (and `resolveSpendPermission` in the published package)

### On-chain `SpendPermission` struct (source of truth)

`SpendPermissionManager.sol` (coinbase/spend-permissions, v1.0.0, pragma `^0.8.28`). The struct has **exactly 9 immutable fields**:

```solidity
// source: https://raw.githubusercontent.com/coinbase/spend-permissions/main/src/SpendPermissionManager.sol
struct SpendPermission {
    address account;   // Smart account the permission is valid for (token owner)
    address spender;   // Entity authorized to spend — AND the fixed fund recipient
    address token;     // ERC-7528 native sentinel 0xEeee…EEeE, or ERC-20 contract
    uint160 allowance; // MAX value per period (resets each period — NOT lifetime)
    uint48  period;    // Reset duration in SECONDS (recurring)
    uint48  start;     // Valid-from, unix seconds, INCLUSIVE
    uint48  end;       // Valid-until, unix seconds, EXCLUSIVE
    uint256 salt;      // Disambiguates otherwise-identical permissions
    bytes   extraData; // Arbitrary spender data; NEVER decoded by the contract
}
```

EIP-712 typehash matches struct field order exactly.

### What each field MEANS (verbatim contract semantics)

- **`allowance`** — "Maximum allowed value to spend **within each `period`**." It is a **recurring per-period cap that RESETS at each period boundary**, NOT a cumulative lifetime total. There is no lifetime accumulator anywhere in the contract.
- **`period`** — "Time duration for resetting used `allowance` on a recurring basis (seconds)." Period windows are fixed intervals `[start + n*period, min(end, start + (n+1)*period))`, computed via `currentPeriodProgress = (block.timestamp - start) % period`.
- **`start`** — valid-from, **inclusive**. `spend()` reverts `BeforeSpendPermissionStart` if `block.timestamp < start`.
- **`end`** — valid-until, **exclusive**. `spend()` reverts `AfterSpendPermissionEnd` once `block.timestamp >= end`. `end` need not align to a period boundary.

Per-period usage is tracked in `PeriodSpend { uint48 start; uint48 end; uint160 spend; }`, stored as `_lastUpdatedPeriod[getHash(spendPermission)]` and overwritten each period.

Source (all of the above, read verbatim from `.sol`): https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol

---

## 5. Spend Permission Revocation

Revocation is a **real, state-changing on-chain transaction**, not an off-chain flag.

### SDK path

```ts
// source: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions
const permissions = await cdp.evm.listSpendPermissions({ address: smartAccount.address });
const permissionHash = permissions.spendPermissions[0].permissionHash;

const { userOpHash } = await cdp.evm.revokeSpendPermission({
  address: smartAccount.address,
  permissionHash,
  network: "base-sepolia",
});

const result = await cdp.evm.waitForUserOperation({
  smartAccountAddress: smartAccount.address,
  userOpHash,
});
```

`RevokeSpendPermissionOptions = { address, permissionHash: Hex, network, paymasterUrl?, idempotencyKey? } -> { userOpHash }`.

### Underlying contract mechanics

`revokeSpendPermission` drives the account-side `revoke()` on the manager:

```solidity
// source: https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol
function revoke(SpendPermission calldata sp) external requireSender(sp.account) { _revoke(sp); }
function revokeAsSpender(SpendPermission calldata sp) external requireSender(sp.spender) { _revoke(sp); }

function _revoke(SpendPermission memory sp) internal returns (bool) {
    bytes32 hash = getHash(sp);
    if (_isRevoked[hash]) return true;
    _isRevoked[hash] = true;                      // storage mutation => genuine on-chain state
    emit SpendPermissionRevoked(hash, sp);
    return true;
}
```

- `revoke()` is callable by the **account** (our smart account; this is what the SDK drives).
- `revokeAsSpender()` is callable by the **spender**. The SDK example uses the account side; SDK coverage of `revokeAsSpender` is **not confirmed** — if we need spender-initiated revocation, verify or call the contract directly.
- `approveWithRevoke(permissionToApprove, permissionToRevoke, expectedLastUpdatedPeriod)` atomically revokes an old permission and approves a new one in one tx (useful for "update the limit" flows).

### Confirming validity on-chain (source of truth)

The manager exposes view functions to check status **directly on-chain** (more authoritative than the indexed `listSpendPermissions` API read):

```solidity
function isValid(SpendPermission memory sp) public view returns (bool) {
    bytes32 hash = getHash(sp);
    return !_isRevoked[hash] && _isApproved[hash];   // NOTE: does NOT check start/end timestamps
}
function isApproved(SpendPermission memory sp) public view returns (bool);
function isRevoked(SpendPermission memory sp) public view returns (bool);
function getCurrentPeriod(SpendPermission memory sp) public view returns (PeriodSpend memory); // remaining allowance; reverts outside [start,end)
function getLastUpdatedPeriod(SpendPermission memory sp) public view returns (PeriodSpend memory);
function getHash(SpendPermission memory sp) public view returns (bytes32);
```

**Important nuance:** `isValid()` checks **only** approved-and-not-revoked; it does **not** validate the `[start, end)` window. Time-window validity is enforced separately inside `getCurrentPeriod()` (and thus every `spend()`), which reverts `BeforeSpendPermissionStart` / `AfterSpendPermissionEnd`. To fully answer "can this permission spend right now?" our backend should check `isValid()` **and** that `start <= now < end`, or call `getCurrentPeriod()` and read remaining allowance (`allowance - period.spend`).

Source: https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol

> The SDK does **not** expose a documented helper to call these view functions directly (only `create`/`list`/`revoke`/`use`). To read `isValid`/`getCurrentPeriod` on-chain, use `viem` with the manager ABI at `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`. `listSpendPermissions` returns `revoked` status but is an indexed/API read (may lag chain state).

---

## 6. x402 Client Flow

x402 is Coinbase's HTTP-402 pay-per-request protocol, layered on the same USDC/Base rails. It is **separate from** the Spend Permission API — no single SDK call couples them.

### The 402 flow shape

1. Client requests a paid resource.
2. Server responds **HTTP `402 Payment Required`** with a JSON body describing **payment requirements** (an `accepts` array of one or more payment options): `scheme` (e.g. `exact`), `network` (e.g. `base-sepolia`), `maxAmountRequired` (atomic units), `resource`, `payTo` (recipient address), `asset` (USDC contract), `maxTimeoutSeconds`, and `extra` (e.g. EIP-712 domain name/version for the token).
3. Client constructs a payment payload — for the `exact` EVM scheme, an **EIP-3009 `transferWithAuthorization`** signature over `{from, to, value, validAfter, validBefore, nonce}` — base64-encodes it, and retries the request with an **`X-PAYMENT`** header.
4. A **facilitator** (`/verify` then `/settle`) validates the signature and broadcasts the transfer on-chain. The server returns the resource plus an `X-PAYMENT-RESPONSE` header with settlement details.

The `x402-fetch` / `x402-axios` client wrappers automate steps 2–3 given a signer.

Source: https://github.com/coinbase/x402, https://x402.org, https://docs.cdp.coinbase.com/x402/welcome

### Can a CDP spend-permission signer be the payer?

**Not directly as one atomic primitive, and this is the key integration subtlety.** The `exact` EVM scheme's default settlement is **EIP-3009 `transferWithAuthorization`**, which requires a signature **from the token-holding account itself** (the smart account) authorizing a transfer to the server's `payTo`. That is a *different* authorization path than `SpendPermissionManager.spend()`, which pulls funds to the **`spender`** address, not to an arbitrary `payTo`.

So the two compose like this rather than being the same call:

- **Spend Permission = the control plane / budget.** It caps how much the agent (spender) may pull from the user's smart account over a period.
- **x402 = the settlement of an individual paid request**, whose funds ultimately reach the server's `payTo`.

Practical wiring for our safety layer: the **spender/agent** holds a funded balance (or pulls from the smart account via `spend()` up to the permission), and it is the **spender** that signs/pays the x402 request (its own EIP-3009 authorization or its own wallet). The spend permission bounds how much the agent can draw from the user; x402 handles each merchant payment. Do **not** assume `SpendPermissionManager` will deliver funds to an x402 merchant `payTo` — its `spend()` destination is hardcoded to `spender` (see §8/§9).

> The SDK bundles a `fetchWithX402`-style wrapped fetch that auto-handles 402s given a signer, independent of `createSpendPermission`. Confirm the exact export name/signature and which signer types it accepts before relying on it — x402 was only lightly scoped here.

### Base Sepolia facilitator status

CDP hosts an x402 **facilitator** covering Base (and Polygon, Arbitrum, World, Solana). **Base Sepolia is supported** for testnet development with test USDC. `network: "base-sepolia"` appears in the payment-requirements `accepts` entries for testnet resources. (x402 cited at 119M+ tx on Base, zero protocol fees, as of ~2026 — mainnet scale context.)

Source: https://docs.cdp.coinbase.com/x402/welcome, https://github.com/coinbase/x402

---

## 7. Base Sepolia USDC

| Property | Value |
|---|---|
| **USDC contract (Base Sepolia, chain 84532)** | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle FiatTokenProxy) |
| **Decimals** | **6** (`parseUnits("0.01", 6) === 10000n`) |
| **USDC contract (Base mainnet)** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Faucet (SDK)** | `cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "usdc" })` — token ∈ `eth \| usdc \| eurc \| cbbtc` |

```ts
// source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md
await cdp.evm.requestFaucet({
  address: evmAccount.address,
  network: "base-sepolia",
  token: "usdc",
});
```

Sources: https://developers.circle.com/stablecoins/usdc-contract-addresses ; https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk@1.51.2/_types/actions/evm/requestFaucet.d.ts

---

## 8. TRUST BOUNDARY TABLE

One row per policy parameter. "Enforcement" resolves the confirm/refute lenses into one honest call. **Where the refute lens found a real gap, the gap wins.**

| Parameter | Enforcement | On-chain mechanism | Confidence | Doc / contract URL | Caveats |
|---|---|---|---|---|---|
| **maxAmountPerTx** | **soft-only** | **None.** `spend()`→`_useSpendPermission()` bounds a single call only by (a) remaining per-period allowance (`allowance - currentPeriod.spend`) and (b) the `uint160` overflow guard. There is **no per-transaction field or check**. A single `spend()` can drain the entire period allowance at once. | high | https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol ; https://github.com/coinbase/spend-permissions/blob/main/docs/SpendPermissionAccounting.md | Only degenerate coercion: set `period` == desired per-tx window so `allowance` becomes an effective per-tx cap — but that destroys any real recurring-period semantics and conflates two concepts. For a genuine per-tx cap independent of the period, **our backend must enforce it** before calling `useSpendPermission`. |
| **maxAmountTotal** (lifetime/cumulative) | **soft-only** | **None** in the normal case. `allowance` is a **per-period** cap that **resets every period** (`getCurrentPeriod()` returns `spend: 0` at each new window). `_lastUpdatedPeriod[hash]` stores only the current window and is overwritten — **no lifetime accumulator exists** in the struct or contract. | high | https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol | Degenerate exception: if `period >= (end - start)` (one non-resetting window), the single period never rolls over and `allowance` **is** enforced on-chain as a lifetime total (reverts `ExceededSpendPermission` once cumulative > allowance). This is a workaround, not a first-class field, and forfeits recurring semantics. In the SDK's normal usage (`periodInDays`, `end` defaulting to max uint48 "never expires"), **maxAmountTotal is NOT on-chain — our backend must sum spends across all periods and stop at the lifetime cap.** |
| **expiresAt** | **BOTH (on-chain enforced)** | **`end` field, enforced on every spend.** `getCurrentPeriod()` (called by every `spend()`) reverts `AfterSpendPermissionEnd` once `block.timestamp >= end` (exclusive) and `BeforeSpendPermissionStart` if `block.timestamp < start` (inclusive). This is a genuine, contract-enforced expiry. | high | https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol | Map our policy's `expiresAt` → the permission's `end` (Date → the SDK converts to unix seconds). Two nuances: (1) `isValid()` does **not** check the time window — only `getCurrentPeriod()`/`spend()` do — so an on-chain "is it live?" check must also compare `now` against `[start, end)`. (2) By SDK default, `end` = max uint48 ("never expires") if you omit it, so you **must explicitly pass `end`** or the permission never expires on-chain. Belt-and-suspenders: also store/enforce `expiresAt` in our DB. |
| **allowedRecipients** | **soft-only** | **None** (architecturally absent). The struct has no recipient/allowlist field. `spend()` hardcodes the destination to the immutable `spendPermission.spender`: `_transferFrom(token, account, spendPermission.spender, value)`, and `requireSender(spendPermission.spender)` forces the caller to equal that same address. There is no per-call `to`, no allowlist, no `InvalidRecipient` check. `extraData` is opaque and never decoded to a destination. | high | https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol | The on-chain contract guarantees exactly one thing about the payee: **funds can only reach the single `spender` baked into the approved permission** (a "whitelist of one," which is also the puller). It cannot express a multi-address allowlist, and once the spender receives funds it may forward them **anywhere** — the manager gives zero guarantee about the ultimate payee. The common product intent (agent pulls, then may pay only an approved SET of merchants) is **NOT enforceable on-chain**. Our backend must soft-enforce the recipient allowlist at payment time. |

### Lens reconciliation note

For **allowedRecipients**, both the "confirm" and "refute" lenses independently concluded **soft-only** — the refute lens went further and called on-chain enforcement *architecturally impossible* (no destination argument exists to constrain). For **maxAmountTotal**, the "confirm" lens honestly reported soft-only for the general case, with a narrow degenerate-config exception. **expiresAt** is the one parameter with real on-chain teeth. **maxAmountPerTx** has no on-chain surface at all.

---

## 9. Capability Gaps / Red Flags (STATE LOUDLY)

**Three of our four policy parameters are NOT enforced on-chain and MUST be soft-enforced by our Fastify backend / spender service. If our backend is bypassed or buggy, the contract will NOT save us on these three.**

### RED FLAG 1 — No per-transaction cap on-chain
`SpendPermissionManager` has **no per-tx limit**. A single `spend()`/`useSpendPermission()` call can consume the **entire remaining period allowance** in one shot. If our threat model includes "one runaway call drains the period budget," the contract does not stop it. **Our backend must check `value <= maxAmountPerTx` before every `useSpendPermission` call.** (Verify: docs/SpendPermissionAccounting.md, SpendPermissionManager.sol.)

### RED FLAG 2 — No lifetime/cumulative cap on-chain (in normal config)
`allowance` **resets every period**. There is no on-chain accumulator across periods. With the SDK's typical `periodInDays` usage and `end` = "never expires," an agent could spend `allowance` **per period, indefinitely**. **Our backend must persist cumulative spend (in SQLite/Drizzle) and refuse to call once `maxAmountTotal` is reached.** The only on-chain way to get a true lifetime cap is the degenerate `period >= end - start` single-window config — which we may choose deliberately for short-lived sessions (see §10), but it is not general.

### RED FLAG 3 — No recipient allowlisting on-chain (architecturally impossible)
There is **no way** to constrain, at spend time, which addresses funds may reach. The contract pins the destination to the single immutable `spender`, and after the spender receives funds it can forward them anywhere. **A multi-merchant recipient allowlist cannot be enforced by CDP.** Our backend is the *only* thing standing between the agent and an arbitrary payee. **This is the highest-severity gap** because recipient control is usually the whole point of a payment safety layer. Soft-enforce it rigorously (see §10), and treat the spender key as extremely sensitive — whoever controls the spender controls where pulled funds go.

### Secondary flags
- **`end` defaults to "never expires."** Omitting `end` yields max uint48. Always set it explicitly (Red Flag adjacent to expiresAt).
- **`isValid()` ignores the time window.** Do not use `isValid()` alone to decide "can spend now" — also check `[start, end)` or use `getCurrentPeriod()`.
- **Ownership requirement.** Spend permissions require a smart account **owned by a CDP Server Wallet EOA**; an external EOA owner breaks the SDK flow.
- **x402 ≠ spend permission delivery.** `spend()` cannot deliver funds to an x402 merchant `payTo`; the spender pays the merchant separately (see §6). Don't design as if the permission pays merchants directly.

---

## 10. Concrete Recommendations — Mapping Our 4 Policy Params to CDP

Our safety-layer policy has: **`maxAmountPerTx`, `maxAmountTotal`, `expiresAt`, `allowedRecipients`.** Here is the honest mapping.

### 10.1 `expiresAt` → CDP `end` (on-chain — use it)
Set the permission's `end` (via `SpendPermissionInput.end: Date`) to our `expiresAt`. This is the one param CDP truly enforces. **Always set it explicitly** (never rely on the "never expires" default). Redundantly store `expiresAt` in our DB and reject requests past it, since `isValid()` alone won't check the window.

### 10.2 `maxAmountTotal` → two viable strategies

**Strategy A (recommended for most cases): soft-enforce a lifetime cap, use the period as a rate limit.**
- Set `allowance` = a sensible **per-period** budget and `periodInDays` = your rate window (e.g. daily).
- Track **cumulative spend across all periods** in SQLite (Drizzle). Before each `useSpendPermission`, check `cumulativeSpent + value <= maxAmountTotal`; refuse and (optionally) auto-revoke when the lifetime cap is hit.
- Pros: keeps natural recurring semantics; flexible. Cons: lifetime cap is only as strong as our backend.

**Strategy B (stronger on-chain guarantee for short-lived sessions): collapse period into a single lifetime window.**
- Set `allowance` = `maxAmountTotal`, `start` = now, `end` = `expiresAt`, and `period` (seconds) `>= (end - start)`. The single window never resets, so the contract enforces `maxAmountTotal` **on-chain** (reverts `ExceededSpendPermission` once cumulative > allowance).
- Pros: real on-chain lifetime cap. Cons: no recurring semantics; you lose the "resets daily" behavior; only appropriate for bounded, expiring sessions. Note the SDK requires a `period`, so pass `period` explicitly large rather than `periodInDays`.

> Choose B when a session has a hard total budget and a fixed expiry (typical for an agent task); choose A when you want recurring allowances with a soft lifetime ceiling.

### 10.3 `maxAmountPerTx` → soft-enforce (no on-chain field)
There is no per-tx field. Enforce in the backend: **reject any spend where `value > maxAmountPerTx` before calling `useSpendPermission`.** (Do not try to model per-tx via `period` unless you genuinely want "one tx per period" semantics — that couples per-tx to the reset window and usually isn't what you want.) Persist per-tx limit in the policy row and validate on every request.

### 10.4 `allowedRecipients` → soft-enforce (no on-chain support), harden the spender

Because the contract pins funds to the `spender` and gives no downstream guarantee, do **all** of the following:

1. **Backend allowlist check (primary control).** Before the spender forwards/pays any recipient, validate the destination address against the policy's `allowedRecipients` set stored in SQLite. Reject anything not on the list. This is the real enforcement point.
2. **Model the spender as a controlled, minimal-logic address you own.** Since `spender` == fund recipient == required caller, treat the spender key as high-value. Only our backend should be able to trigger `spend()`/`useSpendPermission`, and only after the allowlist check passes.
3. **Optional stronger pattern — one-spender-per-approved-recipient.** If a use case truly needs on-chain payee guarantees, create a **separate spend permission per allowed recipient**, each with that recipient as the `spender`. Then "funds reached address X" is on-chain-enforced (X == that permission's spender). This is a degenerate 1-element allowlist per permission and adds operational overhead (N permissions for N recipients, and the recipient itself must call `spend()`), so use it only where the guarantee is worth it. For a general merchant-allowlist agent, Strategy 1 (backend enforcement) is the practical answer.
4. **Log every spend + destination** for audit, and consider auto-revoking the permission if a disallowed destination is ever attempted.

### 10.5 Reference param mapping cheat-sheet

| Our policy param | CDP field | Enforced where | Backend action required |
|---|---|---|---|
| `expiresAt` | `end` (Date) | **On-chain** (`AfterSpendPermissionEnd`) | Set explicitly; also store + check in DB |
| `maxAmountTotal` | `allowance` (Strategy B: single window) OR soft (Strategy A) | On-chain only in Strategy B; else soft | Track cumulative spend in SQLite; refuse at cap |
| `maxAmountPerTx` | — (none) | **Soft only** | Reject `value > maxAmountPerTx` pre-call |
| `allowedRecipients` | — (none; spender is fixed payee) | **Soft only** | Validate destination against allowlist pre-payment; guard spender key |

### 10.6 Non-negotiables for downstream implementation
- Create the smart account with `enableSpendPermissions: true`, owned by a CDP Server Wallet EOA.
- Always set `end` explicitly; never accept the "never expires" default.
- Treat the backend as the sole enforcement point for per-tx, lifetime, and recipient rules — the contract does not back us up on these.
- On revocation, confirm on-chain via `waitForUserOperation` and (for certainty) read `isRevoked()`/`isValid()` from the manager at `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` via viem, not just the indexed `listSpendPermissions`.

---

## Appendix: Key Addresses & Constants

| Item | Value |
|---|---|
| `SpendPermissionManager` (all chains incl. Base Sepolia) | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` |
| `PublicERC6492Validator` | `0xcfCE48B757601F3f351CB6f434CB0517aEEE293D` |
| Native token sentinel (ERC-7528) | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |
| USDC — Base Sepolia (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) |
| USDC — Base mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `@coinbase/cdp-sdk` latest | `1.51.2` |
| `x402` latest | `1.2.0` |

### Open items to verify before/while coding
1. Whether `createSpendPermission` auto-handles first-time smart-account deployment + ERC-6492 approval (counterfactual account) or needs an explicit step.
2. Exact x402 client wrapper package names/exports (`x402-fetch`/`x402-axios`) and which signer types the CDP `fetchWithX402`-style helper accepts.
3. `userOpHash` → settled on-chain tx hash field name on the `waitForUserOperation` receipt.
4. Whether a cdp-sdk newer than 1.51.2 adds on-chain read helpers (`getSpendPermission`/`isValid`) — none as top-level `cdp.evm` methods in 1.51.2.
