// Guided setup / preflight. Run before the first `npm run dev` (or in Docker via
// `docker compose run --rm backend npm run setup`). It:
//   1. validates .env (fails fast if CDP creds are missing),
//   2. actually calls CDP so it catches the common traps with friendly guidance
//      (API-key/wallet-secret project mismatch; malformed secret),
//   3. resolves + prints the treasury and spender addresses,
//   4. checks the treasury USDC balance — auto-funds via faucet on TESTNET; on
//      MAINNET it tells you to fund with real USDC (there is no faucet).
//
// Run: npm run setup

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { loadEnv, type Env } from '../src/config/env.js';
import { getCdpClient } from '../src/cdp/client.js';
import { getTreasury, getSpender, fundWithTestUsdc } from '../src/cdp/smartAccount.js';
import { usdcBalance } from '../src/cdp/onchain.js';
import { baseUnitsToUsdc, usdcToBaseUnits } from '../src/money/usdc.js';

const ok = (m: string) => console.log(`  [ok] ${m}`);
const bad = (m: string) => console.error(`  [x]  ${m}`);

async function main() {
  console.log('\n▶ AI Agent Payment Safety Layer — preflight\n');

  // 0. Auth: ensure an API token exists (protects all /api routes).
  if (process.env.API_TOKEN) {
    ok('API_TOKEN is set (API auth enabled)');
  } else if (existsSync('.env')) {
    const token = randomBytes(24).toString('base64url');
    appendFileSync('.env', `\n# API auth token (protects /api/* routes)\nAPI_TOKEN=${token}\n`);
    process.env.API_TOKEN = token;
    ok('generated an API_TOKEN and added it to .env');
    console.log(`      token: ${token}`);
    console.log('      (the dashboard asks for this once; agents send it as a Bearer token)');
  } else {
    // No .env file to persist to — typically Docker, where compose injects .env as
    // environment variables rather than mounting the file. Generate one and tell the
    // operator to add it to the .env that `docker compose` reads (a generated token
    // that isn't persisted there wouldn't survive to `docker compose up`).
    const token = randomBytes(24).toString('base64url');
    bad('API_TOKEN is not set and there is no .env file here to write it to (Docker?).');
    console.log('      Add this line to the .env that docker compose reads, then re-run:');
    console.log(`      API_TOKEN=${token}`);
    console.log('      (On mainnet the server refuses to start without it.)');
  }

  // 1. env presence
  let env: Env;
  try {
    env = loadEnv();
    ok('.env loaded (CDP credentials present)');
  } catch (err) {
    bad((err as Error).message);
    console.error('\n  Copy .env.example to .env and fill in your CDP credentials.\n');
    process.exit(1);
  }

  if (env.IS_TESTNET) {
    console.log(`      network: ${env.NETWORK} (testnet)`);
  } else {
    console.log(`\n  WARNING: NETWORK=${env.NETWORK} — MAINNET. Real funds. API auth is REQUIRED (and set);`);
    console.log('      keep API_TOKEN secret, serve over TLS, and read the README "SECURITY" section.\n');
  }

  // 2. CDP credentials actually work — resolve the accounts.
  let treasury: Awaited<ReturnType<typeof getTreasury>>;
  let spender: Awaited<ReturnType<typeof getSpender>>;
  try {
    getCdpClient();
    treasury = await getTreasury();
    spender = await getSpender();
    ok('CDP credentials valid; owner + treasury + spender accounts resolved');
  } catch (err) {
    const msg = (err as Error).message;
    bad(`CDP call failed: ${msg}`);
    if (/no secret|register a secret/i.test(msg)) {
      console.error(
        '\n  → Your API key and Wallet Secret must belong to the SAME CDP project.\n' +
          '    With that project selected, generate the Wallet Secret at:\n' +
          '    https://portal.cdp.coinbase.com/wallets/non-custodial/security\n',
      );
    } else if (/key format|invalid key|malformed/i.test(msg)) {
      console.error(
        '\n  → CDP_API_KEY_SECRET or CDP_WALLET_SECRET looks malformed. Re-copy it from the\n' +
          '    portal into .env with no surrounding quotes and no spaces around `=`.\n',
      );
    }
    process.exit(1);
  }
  console.log(`      treasury (fund this): ${treasury.address}`);
  console.log(`      spender:              ${spender.address}`);

  // 3. treasury USDC balance; auto-fund on testnet, guide on mainnet.
  let bal: bigint;
  try {
    bal = await usdcBalance(treasury.address);
  } catch (err) {
    bad(`could not read treasury USDC balance: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`\n      treasury USDC balance: ${baseUnitsToUsdc(bal)} USDC`);

  if (bal >= usdcToBaseUnits('0.5')) {
    ok('treasury is funded');
  } else if (!env.IS_TESTNET) {
    bad('treasury balance is low. There is no faucet on mainnet — fund it with REAL USDC:');
    console.error(`    send USDC on Base to ${treasury.address}\n`);
  } else {
    console.log('      balance is low — requesting test USDC from the CDP faucet...');
    try {
      const { transactionHash } = await fundWithTestUsdc(treasury.address);
      ok(`faucet requested (tx ${transactionHash}); it may take ~30s. Re-run \`npm run setup\` to confirm.`);
    } catch (err) {
      bad(`faucet request failed: ${(err as Error).message}`);
      console.error(
        `    Fund manually at https://faucet.circle.com (Base Sepolia) → ${treasury.address}\n`,
      );
    }
  }

  // 4. Solana (opt-in). Resolve accounts; fund SOL (fees) + USDC on devnet.
  if (env.SOLANA_ENABLED) {
    console.log(`\n  ── Solana (${env.SOLANA_NETWORK}) ──`);
    try {
      const { getSolanaTreasury, getSolanaSpender, fundSolana } = await import('../src/solana/session.js');
      const solTreasury = await getSolanaTreasury();
      const solSpender = await getSolanaSpender();
      ok('Solana treasury + spender resolved');
      console.log(`      treasury (holds USDC; pays SOL fees): ${solTreasury.address}`);
      console.log(`      spender (delegate):                   ${solSpender.address}`);
      if (env.SOLANA_IS_TESTNET) {
        console.log('      requesting devnet SOL (fees) + USDC from the CDP faucet...');
        // treasury needs SOL (Approve/Revoke fees) + USDC (the pool). The spender
        // (delegate) needs SOL for the payment transfer AND the one-time rent to
        // create the merchant's token account (~0.00204 SOL); the devnet faucet
        // only gives ~0.00125 SOL per request, so top the spender up a few times.
        const jobs: [string, 'sol' | 'usdc', 'treasury' | 'spender'][] = [
          ['treasury SOL', 'sol', 'treasury'],
          ['treasury USDC', 'usdc', 'treasury'],
          ['spender SOL (1/3)', 'sol', 'spender'],
          ['spender SOL (2/3)', 'sol', 'spender'],
          ['spender SOL (3/3)', 'sol', 'spender'],
        ];
        for (const [label, token, target] of jobs) {
          try {
            const { signature } = await fundSolana(token, target);
            ok(`${label} faucet requested (sig ${signature})`);
          } catch (err) {
            bad(`${label} faucet: ${(err as Error).message} (rate-limited? re-run setup)`);
          }
        }
      } else {
        bad('MAINNET Solana — no faucet. Fund the treasury with REAL SOL (fees) + USDC manually.');
      }
    } catch (err) {
      bad(`Solana preflight failed: ${(err as Error).message}`);
    }
  }

  console.log('\nPreflight complete. Start it:  npm run dev   (or: docker compose up)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
