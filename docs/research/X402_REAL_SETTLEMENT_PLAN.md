# Wiring REAL x402 Base Sepolia Settlement Into the Safety Layer

Implementation-ready plan. Replaces the MVP mock settlement with a real x402 "exact"
EIP-3009 USDC payment on Base Sepolia: the **spender pays the merchant `payTo`**, and the
**seller verifies + settles via a facilitator**. Scope is unchanged: hop 1 (capped
`useSpendPermission` pull to the spender) stays exactly as-is; only hop 2 (merchant leg)
and the mock seller's verify become real.

Two-hop flow (unchanged shape):
- **Hop 1** — `useSpendPermission`: pulls capped USDC from the treasury smart account **to
  the spender**. On-chain, gasless via CDP paymaster today.
- **Hop 2** — x402 payment: the **spender** signs an EIP-3009 `transferWithAuthorization`
  paying the merchant `payTo`; the seller calls the facilitator to verify + settle.

---

## 1. RECOMMENDED DESIGN — spender becomes an EOA (decisive)

**Make the x402-paying spender a CDP Server-Wallet EOA (`cdp.evm.getOrCreateAccount`), not a
smart account.** This is a change from the current code, where `getSpender()` returns a CDP
**smart account** (`getOrCreateSmartAccount`).

Why an EOA, decisively:

- The x402 "exact" EVM scheme has the payer sign an EIP-712 `TransferWithAuthorization`
  (USDC EIP-3009). The facilitator verifies the signature recovers to `authorization.from`.
  For an **EOA** this is a plain 65-byte `ecrecover` signature — the universally-supported,
  zero-friction path. ([exact-scheme spec](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md))
- A **smart account (ERC-4337)** payer produces an ERC-1271 / ERC-6492 contract signature.
  The facilitator only accepts this if the smart wallet **is already deployed on-chain**.
  An **undeployed / counterfactual** smart wallet is rejected with
  `invalid_exact_evm_payload_undeployed_smart_wallet`. Coinbase's **hosted** facilitator (the
  one at `https://x402.org/facilitator` / the CDP endpoint, legacy settle path) **hard-rejects
  every undeployed smart wallet at settle and does not auto-deploy** — even with ERC-6492
  factory info. Only a **self-hosted `@x402/evm` facilitator** with the opt-in
  `deployERC4337WithEIP6492: true` (default `false`) will deploy-then-settle.
  ([facilitator source](https://raw.githubusercontent.com/coinbase/x402/main/typescript/packages/mechanisms/evm/src/exact/facilitator/errors.ts))
- The CDP quickstart's documented buyer path is exactly `toAccount(cdp.evm.createAccount())`
  → an EOA. `toAccount()` on a CDP **EOA** yields a viem `LocalAccount` with the viem-shaped
  `signTypedData` the x402 signer expects — a drop-in. `toAccount()` on a CDP **smart account**
  is **not** a drop-in (its `signTypedData` takes a different CDP-options shape and needs an
  adapter). ([CDP buyer quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers))

**The tradeoff, plainly:** An EOA spender must hold **test ETH to pay gas for hop-1
`useSpendPermission`.** Today the spender is a smart account, so hop 1 is **gasless** via the
CDP paymaster. As an EOA, the spender submits the `useSpendPermission` call itself and pays
its own gas → it needs Base Sepolia ETH (fund via `cdp.evm.requestFaucet({ token: 'eth' })`,
already implemented as `fundWithTestEth`). **Hop 2 (the x402 payment) is gasless for the
payer regardless** — the payer only *signs* the EIP-3009 authorization off-chain; the
facilitator (or seller) submits `transferWithAuthorization` on-chain and pays that gas.

Net: EOA spender = **one funding requirement (test ETH for hop-1 gas)** in exchange for
**zero smart-wallet/undeployed caveats and the documented, supported x402 payer path.** Take
it. (The alternative — keep the smart-account spender AND self-host a facilitator with
`deployERC4337WithEIP6492: true`, first deploying the spender via a no-op user op — is
strictly more moving parts for no benefit here.)

> Note on hop 1 with an EOA spender: `useSpendPermission` on a CDP EOA still targets the
> same `SpendPermissionManager` (`0xf852…`); the permission's `spender` field must be set to
> the **EOA address**, and the EOA calls `spend()` directly (paying gas) instead of via a
> user op. Confirm the `@coinbase/cdp-sdk` EOA `useSpendPermission` surface at build time — if
> the SDK only exposes `useSpendPermission` on smart accounts, the EOA calls
> `SpendPermissionManager.spend(...)` via viem `writeContract` with the EOA as the sender.

---

## 2. Packages to install (exact versions, mid-2026 scoped v2 line)

Use the **scoped `@x402/*` v2 family at `2.17.0`** (published 2026-06-26). Do NOT use the
frozen unscoped v1 (`x402@1.2.0`) — it speaks the legacy `X-PAYMENT` / `base-sepolia` wire
format; v2 uses `PAYMENT-SIGNATURE` + CAIP-2 `eip155:84532`.

```jsonc
// dependencies to add
"@x402/core":   "2.17.0",   // facilitator client, resource server, types, header helpers
"@x402/evm":    "2.17.0",   // exact EVM scheme (client + server), USDC/Base Sepolia baked in
"@x402/fetch":  "2.17.0",   // BUYER: wrapFetchWithPayment
// SELLER uses @x402/core + @x402/evm directly (custom Fastify handler). Optional wrapper:
"@x402/fastify":"2.17.0",   // OPTIONAL: paymentMiddleware(app, routes, resourceServer)
// OPTIONAL, only if you use the Coinbase/CDP-hosted facilitator (needs CDP API keys):
"@coinbase/x402":"2.1.0"    // createFacilitatorConfig(id, secret) -> { url, createAuthHeaders }
```

Already present and compatible: `@coinbase/cdp-sdk@^1.51.2`, `viem@^2.47.0` (x402 wants
`viem ^2.48.11`; bump `viem` to `^2.48.11` to satisfy `@x402/evm`'s peer range),
`fastify@^5.2.1` (satisfies `@x402/fastify` peer `fastify ^5`).

Sources: [@x402/core](https://registry.npmjs.org/@x402%2fcore),
[@x402/evm](https://registry.npmjs.org/@x402%2fevm),
[@x402/fetch](https://www.npmjs.com/package/@x402/fetch),
[@x402/fastify](https://www.npmjs.com/package/@x402/fastify),
[@coinbase/x402](https://registry.npmjs.org/@coinbase%2fx402).

---

## 3. BUYER code — build + attach the payment header from a CDP signer

The spender (EOA) is the payer. Convert it with `toAccount()`, register the exact EVM scheme
for `eip155:84532`, and wrap `fetch`. `wrapFetchWithPayment` transparently: sends the
request → on `402` reads the requirements → signs the EIP-3009 authorization → retries with
the **`PAYMENT-SIGNATURE`** header (base64 payment payload; `X-PAYMENT` is v1-only).

```ts
// src/x402/buyer.ts (NEW)
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toAccount } from "viem/accounts";
import { getSpenderEoa } from "../cdp/smartAccount.js"; // now returns a CDP EOA (see §6)

let cachedFetch: typeof fetch | null = null;

/** fetch() that auto-pays x402 challenges as the spender EOA (Base Sepolia, exact scheme). */
export async function getPayingFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;
  const spenderEoa = await getSpenderEoa();      // cdp.evm.getOrCreateAccount(...)
  const signer = toAccount(spenderEoa);          // viem LocalAccount -> x402 ClientEvmSigner
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });    // registers eip155:* exact EVM scheme
  cachedFetch = wrapFetchWithPayment(fetch, client);
  return cachedFetch;
}
```

Usage in the middleware's hop-2 retry (replaces the manual `X-PAYMENT` header build):

```ts
const payingFetch = await getPayingFetch();
const paid = await payingFetch(req.targetUrl, { method: req.method ?? "GET" });
// paid.headers.get("PAYMENT-RESPONSE") carries the base64 SettleResponse (on-chain tx hash)
```

Config-shortcut variant if you prefer not to build the client:
`wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }] })`
(`ExactEvmScheme` from `@x402/evm/exact/client`).

**`toAccount(spenderEoa)` must expose `signTypedData` (viem shape).** A CDP EOA
(`EvmServerAccount`) does; a CDP smart account does not — this is a second reason §1 chose
an EOA. ([buyer quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers))

---

## 4. SELLER code — 402 PaymentRequirements + verify/settle via facilitator

Custom Fastify handler using the high-level `x402ResourceServer` (this is what the official
`servers/custom` example does). It builds the correct requirements from a price string,
returns a 402 with `PAYMENT-REQUIRED`, verifies the buyer's header, and settles.

```ts
// mock-seller/server.ts (replacing the mock verify)
import Fastify from "fastify";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";   // SERVER variant

const facilitatorClient = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());          // Base Sepolia
await resourceServer.initialize();                          // sync supported kinds

const routeConfig = {
  scheme: "exact",
  price: "$0.01",                 // or amount in atomic units; ExactEvmScheme resolves USDC
  network: "eip155:84532",        // CAIP-2 Base Sepolia
  payTo: env.MOCK_SELLER_PAY_TO,  // merchant address funds settle TO
  maxTimeoutSeconds: 60,
};

app.get("/resource", async (request, reply) => {
  const built = await resourceServer.buildPaymentRequirements(routeConfig);
  const requirements = built[0];

  const header = (request.headers["payment-signature"] ?? request.headers["x-payment"]) as string | undefined;
  if (!header) {
    const paymentRequired = await resourceServer.createPaymentRequiredResponse([requirements], {
      url: resourceUrl, description: "Mock premium resource", mimeType: "application/json",
    });
    reply.code(402)
      .header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(paymentRequired)).toString("base64"))
      .send({ error: "Payment Required" });
    return;
  }

  const paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  const verify = await resourceServer.verifyPayment(paymentPayload, requirements);
  if (!verify.isValid) {
    reply.code(402).send({ error: "Invalid Payment", reason: verify.invalidReason });
    return;
  }

  // ... produce the resource ...
  const settle = await resourceServer.settlePayment(paymentPayload, requirements); // on-chain
  reply.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settle)).toString("base64"));
  reply.send({ ok: true, resource: "premium-data-42", transaction: settle.transaction });
});
```

**PaymentRequirements shape (v2, `@x402/core`):**
`{ scheme:"exact", network:"eip155:84532", asset:<USDC addr>, amount:<atomic string>, payTo, maxTimeoutSeconds, extra:{ name:"USDC", version:"2" } }`.
Note v2 renames v1's `maxAmountRequired` → `amount`, and moves `resource`/`description`/`mimeType`
into the `PaymentRequired.resource` object. `buildPaymentRequirements` fills `asset`, `amount`
(atomic), and the EIP-712 `extra` for you when `ExactEvmScheme` is registered.

**Facilitator endpoint / functions:** the client does `POST {url}/verify` and `POST {url}/settle`
with body `{ x402Version, paymentPayload, paymentRequirements }`; `resourceServer.verifyPayment`
/ `settlePayment` wrap these. Raw contract: `POST /verify → { isValid, invalidReason?, payer? }`,
`POST /settle → { success, transaction, network, payer?, errorReason? }`.

**Facilitator URL + CDP key needs (pick one):**
- **Signup-free public facilitator: `https://x402.org/facilitator`** — operated by Coinbase,
  **no API keys, no signup**, supports Base Sepolia verify+settle. Use this for the MVP.
  ([CDP seller quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers))
- **CDP-hosted facilitator: `https://api.cdp.coinbase.com/platform/v2/x402`** — via
  `@coinbase/x402`'s `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`; `verify`
  and `settle` **require** `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`.
  ([@coinbase/x402](https://registry.npmjs.org/@coinbase%2fx402))
  ```ts
  import { createFacilitatorConfig } from "@coinbase/x402";
  const facilitatorClient = new HTTPFacilitatorClient(
    createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET));
  ```

---

## 5. USDC / Base Sepolia specifics (EIP-3009 domain)

Verified on-chain against `https://sepolia.base.org` and against
`@x402/evm` `defaultAssets.ts`:

| Field | Value |
|---|---|
| USDC contract (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Decimals | `6` |
| EIP-712 domain **name** | `"USDC"` (on-chain `name()` returns `USDC`, NOT `"USD Coin"`) |
| EIP-712 domain **version** | `"2"` (on-chain `version()` returns `2`) |
| chainId | `84532` |
| verifyingContract | the USDC address above |
| CAIP-2 network id (v2) | `eip155:84532` |
| Primary type | `TransferWithAuthorization` (fields `from, to, value, validAfter, validBefore, nonce`) |

The exact-scheme client reads `name`/`version` from `paymentRequirements.extra`, so the
seller's requirements **must** carry `extra: { name: "USDC", version: "2" }` (already the case
in the current mock challenge). Contract is USDC FiatToken **v2.2** (EIP-1271-capable), so a
*deployed* smart-account payer *could* settle — but per §1 we use an EOA anyway.
([defaultAssets.ts](https://raw.githubusercontent.com/coinbase/x402/main/typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts),
[Circle USDC v2.2](https://www.circle.com/blog/announcing-usdc-v2-2))

---

## 6. Migration notes (our current code)

### `src/cdp/smartAccount.ts` — spender becomes an EOA + ensure ETH funding
- **Change `getSpender()`** from `getOrCreateSmartAccount(...)` to a CDP **EOA**:
  `cdp.evm.getOrCreateAccount({ name: env.CDP_SPENDER_ACCOUNT_NAME })`. Add a `getSpenderEoa()`
  export returning that EOA (the buyer signer source). Keep `getTreasury()` as the smart
  account (it holds USDC and is the permission's `account`; still gasless via paymaster).
- **Type change:** `SmartAccount` alias no longer fits the spender. Introduce a `SpenderAccount
  = ServerAccount` (from `client.ts`) type for the spender.
- **Funding:** at spender bootstrap, ensure it holds **test ETH** for hop-1 gas — call the
  existing `fundWithTestEth(spender.address)` if its ETH balance is low. (Keep `fundWithTestUsdc`
  for the treasury only; the spender does NOT hold USDC — it receives it transiently per hop 1
  and immediately pays it out in hop 2.)

### `src/cdp/spendPermissions.ts` — hop-1 sender is now the EOA
- `issueSessionKey`: `spendPermission.spender` must be the **spender EOA address** (it already
  comes from `getSpender()`, so this follows automatically once `getSpender()` returns the EOA).
- `useSessionKey`: the current code calls `spender.useSpendPermission({...})` on a smart account
  and `waitForUserOperation`. For an EOA there is no user op. Replace with the EOA path: either
  the SDK's EOA `useSpendPermission` (if available) returning a **tx hash**, or a viem
  `writeContract` to `SpendPermissionManager.spend(...)` signed by the EOA. Return `{ txHash }`
  from the tx receipt instead of a user-op receipt. **Because the EOA now pays gas, add a clear
  `OnchainError` when the tx reverts for out-of-gas / insufficient ETH** so the middleware maps
  it to `ONCHAIN_ERROR` and still logs.

### `src/x402/settlement.ts` — replace `buildMockHeader` / `settlePayment` with a real payment
- **Delete** the mock `settlePayment` that hand-builds a base64 `PaymentPayloadV1` with
  `settlement: 'mock'`. The buyer library now builds and attaches the header itself.
- Replace with the `getPayingFetch()` helper from §3 (put it in `src/x402/buyer.ts`).
  `SettlementResult`/`mode: 'mock'|'facilitator'` becomes unnecessary; if you keep a return
  shape, surface the decoded `PAYMENT-RESPONSE` (settlement tx hash) instead.

### `src/x402/middleware.ts` — hop-2 uses the paying fetch
- Replace the block at lines 167–179 (`getSpender()` + `settlePayment()` + manual
  `{ 'X-PAYMENT': settlement.paymentHeader }` fetch) with:
  ```ts
  const payingFetch = await getPayingFetch();
  let resource: unknown = null, settleTxHash: string | undefined;
  try {
    const paid = await payingFetch(req.targetUrl, { method: req.method ?? "GET" });
    resource = await readBody(paid);
    const pr = paid.headers.get("PAYMENT-RESPONSE");
    if (pr) settleTxHash = JSON.parse(Buffer.from(pr, "base64").toString("utf8")).transaction;
  } catch { resource = null; }  // hop-1 funds already pulled; see §7 for audit handling
  ```
- **Keep the existing `finish()` audit wrapper as the single terminal-logging path.** Do NOT
  let any x402 client throw escape it — wrap hop 2 in try/catch (as today). Consider recording
  `settleTxHash` (hop-2 settlement) in addition to hop-1 `txHash`, e.g. as a risk-flag or a new
  audit field, so the audit shows both legs.
- **Network id:** the middleware compares `requirement.network` to `env.NETWORK`
  (`'base-sepolia'`). The v2 seller now advertises `eip155:84532`. Either (a) switch the whole
  loop to v2 CAIP-2 ids (recommended — set the expected network to `eip155:84532`), or (b) keep
  an internal mapping. **Pick v2 across buyer, seller, and `selectRequirement`** so the
  `PaymentRequirements` field names (`amount` vs `maxAmountRequired`) and network ids all agree
  — mixing v1 and v2 fails verification.

### `src/x402/types.ts` — align to v2 shapes
- `selectRequirement` currently reads v1 `maxAmountRequired` and `network === 'base-sepolia'`.
  With the v2 seller, either consume the library's `PaymentRequirements` type (`amount`,
  `eip155:84532`) directly, or update `INTEGER_STRING`-guarded parsing to read `amount`. Keep
  the hardening (reject malformed/negative/decimal amounts before `BigInt`) — it still guards
  the audit-never-skipped invariant.
- Remove `PaymentPayloadV1` (mock header) once the buyer library owns header construction.

### New env
- **Keep** `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`) — now used by the
  real `HTTPFacilitatorClient` on the seller.
- **Add** `X402_NETWORK_ID` (default `eip155:84532`) if you keep `NETWORK=base-sepolia` for CDP
  calls but need the CAIP-2 id for x402 — CDP SDK still wants `base-sepolia`, x402 v2 wants
  `eip155:84532`, so carry both.
- **Add (only if using the CDP-hosted facilitator)** nothing new — reuse existing
  `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`. The public `x402.org` facilitator needs no key.
- Document that the **spender EOA needs Base Sepolia ETH** (funded via faucet); no new env, but
  a bootstrap/README note.

---

## 7. Risks / gotchas + failure handling (audit is NEVER skipped)

The invariant from the current middleware — **exactly one audit row per terminal path, no path
skips logging** — must survive this migration. Every new failure mode below must route through
the existing `finish()` wrapper.

1. **Undeployed smart wallet** (`invalid_exact_evm_payload_undeployed_smart_wallet`). Avoided
   entirely by using an **EOA** spender (§1). If anyone reintroduces a smart-account payer
   against the hosted facilitator, settle will fail. → Mitigation: EOA. Guardrail: assert the
   spender is an EOA at boot.

2. **Spender out of gas (EOA, hop 1).** The EOA now pays its own gas; if it runs out of ETH,
   `useSessionKey` reverts. → Handle: on the `useSessionKey` catch, `releaseSpend` the reserve
   (already done) and `finish({ status: 'rejected_onchain', reason: 'ONCHAIN_ERROR', ... })`.
   Preventively top up ETH in the spender bootstrap. Add an `insufficient_eth` risk flag when
   the revert reason indicates gas.

3. **Facilitator downtime / non-2xx.** The **v2 `HTTPFacilitatorClient` THROWS**
   (`VerifyError` / `SettleError` / `FacilitatorResponseError`) on non-2xx rather than returning
   `isValid:false`. This lives on the **seller**; a throw there returns a 500 to the buyer,
   whose `payingFetch` then rejects — caught by the middleware's hop-2 try/catch (`resource =
   null`), and the attempt is **still logged** via `finish`. On the seller side, wrap
   `verifyPayment` / `settlePayment` in try/catch and return a structured 402/503 so it never
   500s silently. Check BOTH `isValid`/`success` AND catch throws.

4. **Settlement failed but hop-1 funds already pulled.** Hop 1 moves USDC to the spender
   *before* hop 2. If hop 2 fails (facilitator down, seller error), the spender holds USDC it
   didn't spend at the merchant. Today's code already returns `status: 'approved'` with the
   hop-1 `txHash` even if the resource fetch fails (funds pulled). → **Decide policy:** for a
   real merchant leg, prefer marking such a case distinctly (e.g. `approved` with a
   `settlement_failed` risk flag and no `settleTxHash`) so the audit reflects that hop 1 settled
   but hop 2 did not. Do NOT swallow it into a plain success. The reserve is *not* released (the
   cap was genuinely consumed on-chain in hop 1).

5. **`duplicate_settlement`.** A retried settle returns `errorReason: 'duplicate_settlement'`.
   Treat the first `PAYMENT-RESPONSE` as authoritative; do not auto-retry settle. If seen,
   record it as a risk flag, not a hard failure.

6. **v1/v2 wire mismatch.** Mixing v1 (`maxAmountRequired`, `base-sepolia`, `X-PAYMENT`) and v2
   (`amount`, `eip155:84532`, `PAYMENT-SIGNATURE`) silently fails verification. → Commit to **v2
   everywhere** (buyer, seller, `selectRequirement`, network id) in one migration.

7. **Version drift.** `@x402/*` v2 API surface is still evolving (recent minors added
   `SettleResponse.amount`, extensions, hooks). → **Pin `@x402/core`, `@x402/evm`, `@x402/fetch`,
   `@x402/fastify` to `2.17.0` exactly** (no `^`), and pin `@coinbase/x402` to `2.1.0`.

**Golden rule for every path above:** any throw between "attempt started" and "terminal
decision" must be caught and funneled into `finish()` with a structured reason code — never let
an exception from the x402 client, the facilitator, or the on-chain call escape the payment flow
and bypass the audit log. This is the same defense-in-depth the current middleware already
applies around `selectRequirement` and hop 2.

---

### Open items to confirm at build time (do not block the design)
- Whether `@coinbase/cdp-sdk@1.51.x` exposes `useSpendPermission` on a **CDP EOA** (returning a
  tx hash), or whether hop 1 must call `SpendPermissionManager.spend(...)` via viem from the EOA.
- Whether the public `x402.org` facilitator settles pure-v2 `eip155:84532` without CDP keys
  (docs say yes; verify empirically before relying on it).
- Bump `viem` to `^2.48.11` to satisfy `@x402/evm`'s peer dependency.
