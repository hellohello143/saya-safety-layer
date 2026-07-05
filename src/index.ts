// Backend entrypoint. Fastify was chosen (per spec) for built-in schema
// validation and low overhead; nothing in the CDP/x402 libraries requires
// Express. Boots a server that serves the API routes (token-gated) and the
// static dashboard, refusing to start on a mainnet network without API_TOKEN.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { loadEnv } from './config/env.js';
import { ensureSchema } from './db/client.js';
import { getTreasury, getSpender } from './cdp/smartAccount.js';
import { sessionRoutes } from './routes/sessions.js';
import { paymentRoutes } from './routes/payments.js';
import { auditRoutes } from './routes/audit.js';
import { accountRoutes } from './routes/accounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv();
  const mainnets = [
    !env.IS_TESTNET ? env.NETWORK.toUpperCase() : null,
    env.SOLANA_ENABLED && !env.SOLANA_IS_TESTNET ? String(env.SOLANA_NETWORK).toUpperCase() : null,
  ].filter(Boolean);
  const authEnabled = !!env.API_TOKEN;

  // Real money MUST be protected: refuse to start on any mainnet without a token.
  if (mainnets.length && !authEnabled) {
    console.error(
      `\nREFUSING TO START on ${mainnets.join(' + ')} without API_TOKEN — real funds must be\n` +
        'protected. Set API_TOKEN in .env (run `npm run setup` to auto-generate one).\n',
    );
    process.exit(1);
  }
  if (mainnets.length) {
    const bar = '='.repeat(74);
    console.warn(`\n${bar}`);
    console.warn(`  WARNING: RUNNING ON ${mainnets.join(' + ')} — REAL FUNDS.`);
    console.warn('  API auth is ON. Still soft-enforces per-tx + recipient limits (and expiry on');
    console.warn('  Solana). Keep the API_TOKEN secret. See README "SECURITY".');
    console.warn(`${bar}\n`);
  }
  ensureSchema(); // create tables (idempotent) before serving
  const app = Fastify({ logger: true });

  // --- Auth: bearer token on all /api/* routes (static dashboard + /health open) ---
  const tokenMatches = (got: string): boolean => {
    const a = Buffer.from(got);
    const b = Buffer.from(env.API_TOKEN as string);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!authEnabled) {
    app.log.warn('API_TOKEN not set — /api routes are UNAUTHENTICATED (local dev only).');
  }
  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled) return;
    // Gate on the MATCHED ROUTE pattern, not the raw URL. The raw path can be
    // percent-encoded (e.g. `/%61pi/...`) so that a naive `startsWith('/api/')`
    // string check misses it, yet the router still decodes and dispatches it to
    // the `/api/...` handler — a full auth bypass. `routeOptions.url` is the
    // registered pattern (onRequest runs after routing), immune to that trick.
    // Unmatched (404) and static/`/health` routes don't start with /api/ → open.
    const routeUrl = req.routeOptions?.url ?? '';
    if (!routeUrl.startsWith('/api/')) return;
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : null;
    const token = bearer ?? apiKey;
    if (!token || !tokenMatches(token)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid API token' });
    }
  });

  // Defense-in-depth: any unexpected throw returns structured JSON (not an opaque
  // Fastify 500). The payment flow guards its own paths so audit logging is never
  // skipped; this is the backstop for everything else.
  app.setErrorHandler((err: Error, req, reply) => {
    req.log.error({ err }, 'unhandled route error');
    return reply.code(500).send({ error: 'internal_error', message: err.message });
  });

  await app.register(formbody); // parse dashboard form posts
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'dashboard', 'public'),
    prefix: '/',
  });

  app.get('/health', async () => ({ ok: true, network: env.NETWORK }));

  await app.register(sessionRoutes);
  await app.register(paymentRoutes);
  await app.register(auditRoutes);
  await app.register(accountRoutes);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Safety layer up on http://${env.HOST}:${env.PORT} (dashboard at /)`);

  // Resolve + log the CDP accounts so the operator knows which address to fund.
  // Non-fatal: the server is already listening; a CDP/creds error just warns.
  try {
    const [treasury, spender] = await Promise.all([getTreasury(), getSpender()]);
    app.log.info(`>> EVM treasury smart account (FUND with USDC): ${treasury.address}`);
    app.log.info(`>> EVM spender smart account (pulls funds):     ${spender.address}`);
  } catch (err) {
    app.log.warn(`Could not resolve EVM CDP accounts on boot (check CDP_* creds): ${(err as Error).message}`);
  }

  if (env.SOLANA_ENABLED) {
    try {
      const { getSolanaTreasury, getSolanaSpender } = await import('./solana/session.js');
      const [st, ss] = await Promise.all([getSolanaTreasury(), getSolanaSpender()]);
      app.log.info(`>> Solana treasury (FUND with SOL for fees + USDC): ${st.address}`);
      app.log.info(`>> Solana spender / delegate:                       ${ss.address}`);
    } catch (err) {
      app.log.warn(`Could not resolve Solana accounts on boot: ${(err as Error).message}`);
    }

    // Enforce Solana expiry on-chain: SPL delegation has no time bound, so this
    // periodically revokes expired Solana sessions on-chain (and sweeps any that
    // expired while the process was down) rather than relying only on the backend
    // refusing to sign. See src/solana/expirySweeper.ts.
    const { startExpirySweeper, EXPIRY_SWEEP_SECONDS } = await import('./solana/expirySweeper.js');
    startExpirySweeper();
    app.log.info(`>> Solana expiry sweeper on (every ${EXPIRY_SWEEP_SECONDS}s): expired delegations are revoked on-chain`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
