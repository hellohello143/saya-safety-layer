// Agent simulator — the definition-of-done harness (spec §5). Drives the backend
// HTTP API against the running mock x402 seller and prints the decision + reason
// code for each scenario so results are eyeball-verifiable:
//   (a) a payment WITHIN limits           -> approved
//   (b) a payment EXCEEDING the per-tx cap -> EXCEEDS_PER_TX_LIMIT
//   (c) a payment EXCEEDING the total cap  -> EXCEEDS_TOTAL_LIMIT
//   (d) HAMMERING to trip the circuit breaker -> RATE_LIMIT_TRIPPED + on-chain revoke
//
// Prereqs: backend (`npm run dev`) and mock seller (`npm run mock-seller`) running,
// with real CDP creds in .env (issuance + the on-chain pull need them).
//
// Run: npm run agent-sim

import 'dotenv/config';

const BACKEND = process.env.BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const SELLER = process.env.MOCK_SELLER_URL ?? `http://127.0.0.1:${process.env.MOCK_SELLER_PORT ?? 4021}/resource`;
// `||` (not `??`) so an empty MOCK_SELLER_PAY_TO= line in .env falls back too.
const PAY_TO = process.env.MOCK_SELLER_PAY_TO || '0x000000000000000000000000000000000000dEaD';
// --network=solana-devnet (or SIM_NETWORK); default lets the backend pick its EVM network.
const NETWORK =
  (process.argv.find((a) => a.startsWith('--network='))?.split('=')[1] || process.env.SIM_NETWORK) ?? undefined;
const IS_SOLANA = (NETWORK ?? '').startsWith('solana');
const AGENT = IS_SOLANA ? 'sim-agent-sol' : 'sim-agent';

const AUTH: Record<string, string> = process.env.API_TOKEN
  ? { authorization: `Bearer ${process.env.API_TOKEN}` }
  : {};

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...AUTH, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

// SPL allows one delegate per token account, so only one active Solana session at
// a time. Revoke any active Solana session before creating the next.
async function revokeActiveSolana() {
  const { json } = await api('/api/sessions?status=active');
  if (!Array.isArray(json)) return;
  for (const s of json) {
    if (String(s.network).startsWith('solana')) {
      process.stdout.write(`  (revoking prior solana session ${String(s.id).slice(0, 8)}… )\n`);
      await api(`/api/sessions/${s.id}/revoke`, {});
    }
  }
}

async function createSession(opts: {
  maxAmountPerTx: string;
  maxAmountTotal: string;
  allowRecipient?: boolean;
}) {
  if (IS_SOLANA) await revokeActiveSolana();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  // On Solana the sim doesn't know the seller's Solana payTo, so it uses an empty
  // allowlist (higher_risk). On EVM it allowlists the mock seller's payTo.
  const allowedRecipients = IS_SOLANA || opts.allowRecipient === false ? [] : [PAY_TO];
  const { status, json } = await api('/api/sessions', {
    agentId: AGENT,
    ...(NETWORK ? { network: NETWORK } : {}),
    maxAmountPerTx: opts.maxAmountPerTx,
    maxAmountTotal: opts.maxAmountTotal,
    expiresAt,
    allowedRecipients,
  });
  if (status !== 201) throw new Error(`create session failed (${status}): ${JSON.stringify(json)}`);
  return json.id as string;
}

const pay = (sessionId: string) => api('/api/pay', { sessionId, targetUrl: SELLER });
const line = (label: string, r: { status: number; json: any }) =>
  console.log(
    `  ${label}: http=${r.status} status=${r.json?.status} reason=${r.json?.reason ?? '-'}` +
      (r.json?.detail ? `\n      detail: ${r.json.detail}` : ''),
  );

async function scenarioWithinLimits() {
  console.log('\n(a) WITHIN LIMITS  (expect approved)');
  const id = await createSession({ maxAmountPerTx: '0.05', maxAmountTotal: '1.00' });
  line('pay', await pay(id));
}

async function scenarioExceedsPerTx() {
  console.log('\n(b) EXCEEDS PER-TX  (expect EXCEEDS_PER_TX_LIMIT; per-tx 0.005 < price 0.01)');
  const id = await createSession({ maxAmountPerTx: '0.005', maxAmountTotal: '1.00' });
  line('pay', await pay(id));
}

async function scenarioExceedsTotal() {
  console.log('\n(c) EXCEEDS TOTAL  (expect approved then EXCEEDS_TOTAL_LIMIT; total = one payment)');
  const id = await createSession({ maxAmountPerTx: '0.05', maxAmountTotal: '0.01' });
  line('pay #1', await pay(id));
  line('pay #2', await pay(id));
}

async function scenarioTripBreaker() {
  console.log('\n(d) TRIP CIRCUIT BREAKER  (expect RATE_LIMIT_TRIPPED after the limit, then session revoked)');
  const id = await createSession({ maxAmountPerTx: '0.05', maxAmountTotal: '100.00' });
  const max = Number(process.env.CIRCUIT_BREAKER_MAX_ATTEMPTS ?? 10);
  for (let i = 1; i <= max + 3; i++) line(`pay #${i}`, await pay(id));
  const s = await api(`/api/sessions/${id}?onchain=true`);
  console.log(`  final session status=${s.json?.status} revokeTx=${s.json?.revokeTxHash ?? '-'} onchain.isRevoked=${s.json?.onchain?.isRevoked ?? '-'}`);
}

async function main() {
  console.log(`agent-sim -> backend ${BACKEND}, seller ${SELLER}, network ${NETWORK ?? '(backend default EVM)'}`);
  // First non-flag arg is the scenario (flags like --network are skipped).
  const scenario = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const all = !scenario || scenario === 'all';
  if (all || scenario === 'within') await scenarioWithinLimits();
  if (all || scenario === 'pertx') await scenarioExceedsPerTx();
  if (all || scenario === 'total') await scenarioExceedsTotal();
  if (all || scenario === 'breaker') await scenarioTripBreaker();

  const audit = await api(`/api/audit?agentId=${AGENT}&limit=50`);
  console.log(`\nAUDIT: ${Array.isArray(audit.json) ? audit.json.length : 0} rows for ${AGENT} (decisions: ${
    Array.isArray(audit.json) ? [...new Set(audit.json.map((r: any) => r.decision))].join(', ') : '-'
  })`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
