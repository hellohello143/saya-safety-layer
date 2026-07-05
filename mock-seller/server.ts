// Mock x402-protected seller (spec §5). Returns HTTP 402 with per-network payment
// requirements, then VERIFIES the payment ON-CHAIN and returns a dummy resource.
//
// SETTLEMENT IS REAL (not mocked): the buyer's X-PAYMENT header carries the tx
// hash/signature of a real USDC transfer to this seller's payTo. This server
// verifies that transfer on-chain (EVM via viem Transfer logs; Solana via the
// getTransaction token-balance delta) before releasing the resource. It is NOT
// the x402 facilitator /verify+/settle flow (a deliberate "keep it gasless"
// choice); the x402 HTTP shape is preserved.

import Fastify from 'fastify';
import { createPublicClient, http, getAddress, parseEventLogs, type Hex } from 'viem';
import { loadEnv } from '../src/config/env.js';
import { EVM_NETWORKS, SOLANA_NETWORKS } from '../src/config/network.js';
import { usdcToBaseUnits } from '../src/money/usdc.js';
import { getCdpClient } from '../src/cdp/client.js';
import { verifySolanaSettlement } from '../src/solana/session.js';
import type { Http402Body, PaymentRequirementsV1, PaymentPayloadV1 } from '../src/x402/types.js';
import type { SolanaPaymentPayload } from '../src/solana/session.js';

const ERC20_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  const priceBaseUnits = usdcToBaseUnits(env.MOCK_SELLER_PRICE_USDC);
  const resourceUrl = `http://127.0.0.1:${env.MOCK_SELLER_PORT}/resource`;

  // --- EVM payTo + verifier ---
  // On mainnet the burn-address default would destroy REAL USDC, so EVM is served
  // ONLY if it's a testnet or an explicit payTo is set. Otherwise EVM is skipped
  // (Solana can still be served) rather than blocking the whole seller.
  const evmServeable = env.IS_TESTNET || !!env.MOCK_SELLER_PAY_TO;
  if (!evmServeable) {
    app.log.warn(
      'EVM payments DISABLED for the mock seller: on mainnet without MOCK_SELLER_PAY_TO (the burn-address default would destroy real USDC). Set MOCK_SELLER_PAY_TO to serve EVM.',
    );
  }
  const evmPayTo = env.MOCK_SELLER_PAY_TO || '0x000000000000000000000000000000000000dEaD';
  const usdc = getAddress(env.USDC_ADDRESS);
  const evmClient = createPublicClient({
    chain: EVM_NETWORKS[env.NETWORK].viemChain,
    transport: http(env.RPC_URL),
  });

  // --- Solana payTo (a CDP account the seller controls, so it can verify receipt) ---
  let solanaPayTo: string | null = null;
  if (env.SOLANA_ENABLED) {
    try {
      solanaPayTo =
        env.MOCK_SELLER_PAY_TO_SOLANA ||
        (await getCdpClient().solana.getOrCreateAccount({ name: 'mock-seller-sol' })).address;
    } catch (err) {
      app.log.warn(`Solana disabled for the mock seller (could not resolve payTo): ${(err as Error).message}`);
    }
  }

  const consumed = new Set<string>(); // one-time-use tx hashes/signatures (replay guard)

  if (!evmServeable && !solanaPayTo) {
    throw new Error('No serveable network: EVM is mainnet-without-payTo and Solana is off/unresolved.');
  }

  function challenge(error = 'payment required'): Http402Body {
    const accepts: PaymentRequirementsV1[] = [];
    if (evmServeable) {
      accepts.push({
        scheme: 'exact',
        network: env.NETWORK,
        maxAmountRequired: priceBaseUnits.toString(),
        resource: resourceUrl,
        description: 'Mock premium resource',
        mimeType: 'application/json',
        payTo: evmPayTo,
        maxTimeoutSeconds: 60,
        asset: env.USDC_ADDRESS,
        extra: { name: 'USDC', version: '2' },
      });
    }
    if (env.SOLANA_ENABLED && solanaPayTo && env.SOLANA_NETWORK && env.SOLANA_USDC_MINT) {
      accepts.push({
        scheme: 'exact',
        network: env.SOLANA_NETWORK,
        maxAmountRequired: priceBaseUnits.toString(),
        resource: resourceUrl,
        description: 'Mock premium resource',
        mimeType: 'application/json',
        payTo: solanaPayTo,
        maxTimeoutSeconds: 60,
        asset: env.SOLANA_USDC_MINT,
        extra: { name: 'USDC' },
      });
    }
    return { x402Version: 1, accepts, error };
  }

  // EVM: verify a successful tx with a USDC Transfer to payTo >= price.
  // CLAIM-BEFORE-VERIFY: reserve the key up front so two concurrent requests with
  // the same tx hash can't both pass the check during the multi-second verify;
  // release it (finally) on any non-success so a transient RPC error doesn't burn
  // a legitimate tx permanently.
  async function verifyEvm(txHash: string): Promise<{ ok: boolean; reason?: string }> {
    const key = 'evm:' + txHash.toLowerCase();
    if (consumed.has(key)) return { ok: false, reason: 'tx already used' };
    consumed.add(key);
    let result: { ok: boolean; reason?: string } = { ok: false, reason: 'unverified' };
    try {
      let receipt: Awaited<ReturnType<typeof evmClient.getTransactionReceipt>> | null = null;
      for (let i = 0; i < 6; i++) {
        try {
          receipt = await evmClient.getTransactionReceipt({ hash: txHash as Hex });
          break;
        } catch {
          await sleep(1500);
        }
      }
      if (!receipt) result = { ok: false, reason: 'tx receipt not found' };
      else if (receipt.status !== 'success') result = { ok: false, reason: 'tx reverted' };
      else {
        const transfers = parseEventLogs({ abi: ERC20_TRANSFER_ABI, logs: receipt.logs, eventName: 'Transfer' });
        const paid = transfers.some(
          (t) => getAddress(t.address) === usdc && getAddress(t.args.to) === getAddress(evmPayTo) && t.args.value >= priceBaseUnits,
        );
        result = paid ? { ok: true } : { ok: false, reason: 'no matching USDC Transfer to payTo' };
      }
      return result;
    } finally {
      if (!result.ok) consumed.delete(key);
    }
  }

  // Solana: verify the signature credited >= price USDC to our Solana payTo.
  async function verifySolana(signature: string): Promise<{ ok: boolean; reason?: string }> {
    if (!solanaPayTo) return { ok: false, reason: 'solana not configured' };
    const key = 'sol:' + signature;
    if (consumed.has(key)) return { ok: false, reason: 'signature already used' };
    consumed.add(key);
    let ok = false;
    try {
      for (let i = 0; i < 6; i++) {
        if (await verifySolanaSettlement(signature, solanaPayTo, priceBaseUnits)) {
          ok = true;
          break;
        }
        await sleep(1500); // not yet finalized on this RPC node
      }
      return ok ? { ok: true } : { ok: false, reason: 'no finalized USDC transfer to payTo for >= price' };
    } finally {
      if (!ok) consumed.delete(key);
    }
  }

  app.get('/resource', async (req, reply) => {
    const header = req.headers['x-payment'];
    if (!header || typeof header !== 'string') return reply.code(402).send(challenge());

    let payload: PaymentPayloadV1 | SolanaPaymentPayload;
    try {
      payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      return reply.code(402).send(challenge('malformed X-PAYMENT header'));
    }
    // Structurally validate the decoded payload before touching nested fields, so a
    // crafted header returns a 402 challenge (with the accepts menu) rather than a 500.
    if (!payload || typeof payload !== 'object') {
      return reply.code(402).send(challenge('malformed X-PAYMENT payload'));
    }

    let result: { ok: boolean; reason?: string };
    let ref: string;
    if (payload.settlement === 'onchain-solana') {
      const sig = (payload as SolanaPaymentPayload).payload?.signature;
      if (typeof sig !== 'string' || !sig) return reply.code(402).send(challenge('malformed solana payment payload'));
      ref = sig;
      result = await verifySolana(ref);
    } else if (payload.settlement === 'onchain') {
      const txh = (payload as PaymentPayloadV1).payload?.settlementTxHash;
      if (typeof txh !== 'string' || !txh) return reply.code(402).send(challenge('missing or invalid settlement tx'));
      ref = txh;
      result = await verifyEvm(ref);
    } else {
      return reply.code(402).send(challenge('missing on-chain settlement proof'));
    }

    if (!result.ok) return reply.code(402).send(challenge(`payment not verified: ${result.reason}`));

    reply.header(
      'X-PAYMENT-RESPONSE',
      Buffer.from(JSON.stringify({ settled: payload.settlement, ref }), 'utf8').toString('base64'),
    );
    return reply.code(200).send({ ok: true, resource: 'premium-data-42', ref });
  });

  await app.listen({ port: env.MOCK_SELLER_PORT, host: env.HOST });
  const served = [evmServeable ? `EVM payTo ${evmPayTo}` : null, solanaPayTo ? `Solana payTo ${solanaPayTo}` : null]
    .filter(Boolean)
    .join('; ');
  app.log.info(`Mock x402 seller up on ${resourceUrl} (price ${env.MOCK_SELLER_PRICE_USDC} USDC; ${served})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
