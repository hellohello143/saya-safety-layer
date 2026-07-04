# AI Agent Payment Safety Layer (MVP)

Scoped, **on-chain-enforced** session keys for autonomous AI-agent payments. Agents pay for
resources over the [x402](https://x402.org) protocol using USDC on **Base** (EVM) and **Solana** —
testnet *or* mainnet — but never hold unlimited spending power: each agent gets a scoped session key
(a [CDP Spend Permission](https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions)
on EVM, an SPL token delegation on Solana) with hard limits the chain enforces itself. This backend is
a policy / config / audit layer **on top of** that on-chain enforcement — a convenience and
observability layer, **not** the last line of defense.

> **MVP.** Ships with API-token auth and mainnet guardrails (the server refuses to start on mainnet
> without a token). Still an MVP — read [Security & production readiness](#security--production-readiness)
> before pointing it at real funds.

## The trust boundary (read this first)

The entire point of the project is being honest about what is enforced where. Full analysis with
primary-source citations: [`docs/research/CDP_X402_RESEARCH.md`](docs/research/CDP_X402_RESEARCH.md)
and the actual contract snapshot
[`docs/research/SpendPermissionManager.reference.sol`](docs/research/SpendPermissionManager.reference.sol).
The definitive table is in [`TRUST_BOUNDARY.md`](TRUST_BOUNDARY.md).

| Policy parameter | Enforced on-chain? | How |
| --- | --- | --- |
| `expiresAt` | ✅ **On-chain** | `SpendPermission.end`; every `spend()` reverts once `now ≥ end` |
| `maxAmountTotal` | ✅ **On-chain** | `allowance` under our single-window config → contract reverts `ExceededSpendPermission` |
| `maxAmountPerTx` | ⚠️ **Soft (backend only)** | no per-tx field exists in the contract |
| `allowedRecipients` | ⚠️ **Soft (backend only)** | `spend()` hard-pins the payee to the spender; no recipient arg exists |

The two soft parameters **cannot** be enforced on-chain by `SpendPermissionManager` and are enforced
only by this backend. They are flagged in code, in `TRUST_BOUNDARY.md`, and as per-payment audit risk
flags. Nothing is silently downgraded.

### How a payment actually flows (two hops)
Because `spend()` delivers funds to the **spender**, not to a merchant, a payment is two hops:
1. **Hop 1 (on-chain, capped):** the spender pulls up to `maxAmountTotal`/before `expiresAt` from the
   treasury smart account via `useSpendPermission`.
2. **Hop 2 (merchant leg):** the spender pays the x402 merchant with a **real on-chain USDC transfer**
   (gasless via the CDP paymaster), and the seller **verifies that transfer on-chain** before releasing
   the resource ([`src/x402/settlement.ts`](src/x402/settlement.ts), [`mock-seller/server.ts`](mock-seller/server.ts)).
   The x402 HTTP shape (402 + `X-PAYMENT`) is preserved; this is a real direct transfer with an on-chain
   proof rather than the x402 facilitator `/verify`+`/settle` flow (a deliberate keep-it-gasless choice).
   > Set `MOCK_SELLER_PAY_TO` to an address you control to actually receive the test USDC; if left unset
   > it defaults to the burn address `0x…dEaD`, so payments are real but the funds are burned.

## Architecture

```
src/
  config/env.ts            validated env config (fails fast)
  money/usdc.ts            USDC base-unit math (6 decimals, bigint, no floats)
  cdp/                     CDP client, smart account/spender, spend-permission issue/use/revoke,
                           and viem on-chain reads (isValid / isRevoked / getCurrentPeriod)
  policy/                  reason codes, policy engine, circuit breaker
  x402/                    x402 types + selection, merchant settlement, payment middleware
  audit/                   audit-log service
  db/                      node:sqlite schema + repository layer (Postgres-swappable)
  routes/                  Fastify plugins (sessions, payments, audit)
  index.ts                 entrypoint (serves API + dashboard)
  chains/                  chain-adapter interface + EVM (CDP) and Solana (SPL) adapters
  solana/                  Solana session issue/use/revoke + settlement verification
mock-seller/server.ts      local x402-protected test resource (EVM + Solana)
scripts/agent-sim.ts       DoD harness: within-limits / exceeds-per-tx / exceeds-total / trip-breaker
dashboard/public/          token-gated ops UI (static HTML + fetch)
docs/research/             verified CDP/x402 research + contract source snapshot
```

**Database note:** the spec's preferred Drizzle + `better-sqlite3` stack hit a wall on Node 24+ (no
prebuilt native binary + no local C++ toolchain, and drizzle-orm ships no `node:sqlite` adapter). Per
the spec's escape hatch, persistence uses **Node's built-in `node:sqlite`** directly behind the
repository layer — zero native deps, no compiler, real synchronous transactions for race-free spend
accounting. Swapping to Postgres later is a repository-layer change.

## Quick start (Docker)

Prereqs: Docker, and CDP credentials in `.env`.

```bash
cp .env.example .env                              # then fill in the 3 CDP_* values (see below)
docker compose run --rm backend npm run setup     # validates creds + auto-funds the treasury
docker compose up                                 # backend + dashboard :3000, mock seller :4021
docker compose --profile demo up                  # ^ plus runs the agent-sim demo once
```

`npm run setup` is a **preflight**: it generates an `API_TOKEN` if you don't have one (see
[Security](#security--production-readiness)), checks your `.env`, verifies the CDP credentials actually
work (with targeted fixes for the common traps — e.g. the API-key/wallet-secret project mismatch),
prints the treasury/spender addresses, and requests test USDC from the faucet if the treasury is low.

## Setup (local, without Docker)

**Prerequisites:** **Node.js ≥ 22.13** (built-in `node:sqlite` is unflagged from 22.13 / 23.4; Node 24
LTS or 26 recommended). No native build tools required.

1. **Install** — `npm install`
2. **Configure** — `cp .env.example .env`, then fill in the CDP credentials (below).
3. **Preflight** — `npm run setup` (validates creds, prints addresses, funds the treasury).

The SQLite schema is created automatically on first boot (no migrate step).

### Getting CDP testnet credentials
1. Sign in at the [CDP Portal](https://portal.cdp.coinbase.com).
2. Create a **Secret API Key** → gives you `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.
3. Create/note your **Wallet Secret** (authorizes wallet operations) → `CDP_WALLET_SECRET`.
4. Put all three in `.env`. That's all the backend needs — it creates the owner EOA, the treasury
   smart account (with `enableSpendPermissions: true`), and the spender smart account by name on first
   use. (Docs: [CDP Server Wallets v2 quickstart](https://docs.cdp.coinbase.com/server-wallets/v2/introduction/quickstart).)

### Funding the smart account with test USDC (Base Sepolia)
The treasury smart account must hold test USDC to make real payments. Smart-account user ops are
**gasless** via the CDP Paymaster, so you only need USDC (no test ETH).

- Easiest: the CDP faucet — `cdp.evm.requestFaucet({ address, network: 'base-sepolia', token: 'usdc' })`
  (helper in [`src/cdp/smartAccount.ts`](src/cdp/smartAccount.ts) → `fundWithTestUsdc`).
- Or Circle's [USDC faucet](https://faucet.circle.com) (Base Sepolia). USDC contract:
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals).

The treasury address is printed in the backend log on boot (`>> Treasury smart account (FUND THIS…)`),
shown in the dashboard's **Accounts** panel, and available at `GET /api/accounts`.

## Running

Open three terminals (all commands from the repo root):

```bash
npm run dev           # backend + dashboard on http://127.0.0.1:3000  (dashboard at /)
npm run mock-seller   # mock x402 seller on http://127.0.0.1:4021/resource
npm run agent-sim     # runs the definition-of-done scenarios against the above
```

- **Dashboard:** http://127.0.0.1:3000 — create sessions, watch status/remaining budget/risk flags,
  revoke on-chain, and filter the audit log. It asks for the `API_TOKEN` once and remembers it in the
  browser (`localStorage`); re-prompts if the token is rejected.
- **agent-sim** reads `API_TOKEN` from `.env` automatically (via `dotenv`), so no extra step is needed.
- **Type-check / build / test:** `npm run typecheck` · `npm run build` · `npm test` (48 tests).

### Multi-chain: Solana
The layer runs EVM (Base) and Solana at once. Enable Solana with `SOLANA_NETWORK=solana-devnet`
(testnet) or `SOLANA_NETWORK=solana` (mainnet, real funds) in `.env`, then `npm run setup` resolves the
Solana treasury/spender. On **devnet** it auto-funds them with **SOL (for fees) + USDC**; on **mainnet**
there is no faucet, so fund the treasury with real SOL + USDC yourself. Create Solana sessions from the
dashboard's network dropdown, or:

```bash
npm run agent-sim -- --network=solana-devnet
```

The Solana trust boundary differs — **`expiresAt` is enforced SOFT-ONLY on Solana** (SPL delegation
has no on-chain time bound); the total cap (`delegated_amount`) and revocation (`Revoke`) *are*
on-chain. See [`TRUST_BOUNDARY.md`](TRUST_BOUNDARY.md). Solana is **not gasless** (the treasury needs
SOL), and this first cut allows **one active Solana session at a time** (one delegate per token
account). Full analysis: [`docs/plans/CHECKPOINT_S1_SOLANA.md`](docs/plans/CHECKPOINT_S1_SOLANA.md).

### The agent test script (definition of done)
`npm run agent-sim` runs four scenarios and prints each decision + reason code:

| Scenario | Expectation |
| --- | --- |
| `within`  | payment within limits → `approved` |
| `pertx`   | payment over the per-tx cap → `EXCEEDS_PER_TX_LIMIT` |
| `total`   | second payment over the total cap → `EXCEEDS_TOTAL_LIMIT` |
| `breaker` | hammering past the window → `RATE_LIMIT_TRIPPED` + **real on-chain revocation** |

Run one at a time with `npm run agent-sim -- within|pertx|total|breaker`. It finishes by printing the
audit-log row count for the sim agent. (Requires real CDP creds in `.env`, since these exercise real
on-chain issuance / spend / revoke.)

### API surface
- `POST /api/sessions` — issue an on-chain session key. Body: `{ agentId, maxAmountPerTx, maxAmountTotal, expiresAt, allowedRecipients? }`.
- `GET /api/sessions` · `GET /api/sessions/:id?onchain=true` (includes a live chain read).
- `POST /api/sessions/:id/revoke` — real on-chain revocation.
- `POST /api/pay` — `{ sessionId, targetUrl }` → resource or a structured rejection with a reason code.
- `GET /api/audit?agentId&sessionId&decision&onchainStatus&from&to&limit`.
- `GET /api/accounts` — resolved treasury + spender addresses (where to fund).

## Security & production readiness

### Authentication
All `/api/*` routes are gated by a single **`API_TOKEN`** bearer token; the static dashboard and
`GET /health` stay open so the UI can load and health checks work.

- **Sending it:** `Authorization: Bearer <token>` (or `X-API-Key: <token>`). Compared with
  `crypto.timingSafeEqual` (constant-time, length-checked) in [`src/index.ts`](src/index.ts).
- **Getting one:** `npm run setup` generates a 24-byte URL-safe token and writes `API_TOKEN=…` to
  `.env` if it's missing. Set your own anytime — any non-empty value turns auth on.
- **Mainnet is fail-closed:** with any mainnet network configured (`NETWORK=base` or
  `SOLANA_NETWORK=solana`), the server **refuses to start** without `API_TOKEN`. On testnet, a missing
  token runs open (with a loud log warning) for frictionless local dev.
- **Rotating:** change `API_TOKEN` in `.env` and restart; clients re-prompt / re-read on the next call.

### Deploying with real funds — checklist
1. **Terminate TLS in front of it.** The token is a bearer credential — never send it over plain HTTP.
   Put the backend behind a reverse proxy (nginx/Caddy/Cloud LB) that does HTTPS.
2. **Don't expose the port directly.** Bind to `127.0.0.1` (default `HOST`) and let the proxy reach it,
   or lock the port down at the firewall/security-group level.
3. **Keep secrets in a real secret store**, not a committed `.env`: `CDP_*`, `CDP_WALLET_SECRET`, and
   `API_TOKEN`. Whoever holds the wallet secret + spender controls where pulled funds go.
4. **Fund deliberately.** Mainnet has no faucet; `npm run setup` prints the addresses to fund. Keep the
   treasury balance close to what the agents actually need — the on-chain caps bound spend, but a
   smaller float bounds blast radius.
5. **Set `MOCK_SELLER_PAY_TO`** (or your real merchant flow) — unset, EVM payments burn to `0x…dEaD`.

### Remaining gaps (an MVP, honestly)
- **One shared token, no per-agent scopes/roles.** Every API caller with the token is fully trusted;
  there's no per-agent authorization, no token expiry/rotation automation, no audit of *who* called.
- **No HTTP-layer rate limiting.** The circuit breaker limits *agent payment attempts*, not raw HTTP
  callers — add a proxy-level rate limit for internet-facing deploys.
- **No monitoring / alerting** built in (structured logs + the audit log are the hooks to wire one up).
- **Merchant settlement is a direct on-chain transfer, not the x402 facilitator protocol.** Funds
  really move and the seller verifies receipt on-chain, but there's no `/verify`+`/settle` facilitator
  and no EIP-3009 authorization. Swapping in the real facilitator (`@x402/*` v2) would require the
  spender to become a gas-funded EOA.
- **Soft-enforced limits are only as strong as this backend.** `maxAmountPerTx` and `allowedRecipients`
  (and `expiresAt` **on Solana**) are **not** enforced on-chain — a bypassed or buggy backend removes
  those protections. This is the core trust boundary, spelled out per-chain in
  [`TRUST_BOUNDARY.md`](TRUST_BOUNDARY.md). Nothing is silently downgraded; the soft params surface as
  per-payment audit risk flags.
