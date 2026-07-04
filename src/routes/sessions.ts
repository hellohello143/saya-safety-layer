// Session routes. Create / list / get / revoke sessions — network-aware via the
// chain adapter (EVM Spend Permissions or Solana SPL delegation). Creating a
// session mints a REAL on-chain session key; revoking performs REAL on-chain
// revocation and only flips DB status after it confirms.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAddress } from 'viem';
import { loadEnv } from '../config/env.js';
import { familyOf, isSolanaNetwork } from '../config/network.js';
import { usdcToBaseUnits, baseUnitsToUsdc } from '../money/usdc.js';
import { adapterFor, enabledNetworks } from '../chains/index.js';
import { OnchainError } from '../cdp/spendPermissions.js';
import { SessionRepository } from '../db/repositories/sessionRepository.js';
import type { SessionRow } from '../db/schema.js';

const repo = new SessionRepository();

const usdcAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a USDC amount with up to 6 decimal places');

const CreateSessionBody = z.object({
  agentId: z.string().min(1),
  network: z.enum(['base', 'base-sepolia', 'solana', 'solana-devnet']).optional(),
  maxAmountPerTx: usdcAmount,
  maxAmountTotal: usdcAmount,
  expiresAt: z.number().int().positive(), // unix seconds
  // Addresses are validated per-chain in the handler (EVM hex vs Solana base58).
  allowedRecipients: z.array(z.string()).optional().default([]),
});

/** DB row -> API shape (base units -> decimal USDC at the edge; add derived fields). */
function serialize(row: SessionRow) {
  const total = BigInt(row.maxAmountTotal);
  const spent = BigInt(row.cumulativeSpent);
  const remaining = total > spent ? total - spent : 0n;
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    network: row.network,
    // expiry is enforced on-chain on EVM but SOFT-ONLY on Solana — surfaced so the
    // dashboard can badge it and callers know the trust boundary per session.
    expiryEnforcedOnChain: familyOf(row.network as never) === 'evm',
    smartAccountAddress: row.smartAccountAddress,
    spenderAddress: row.spenderAddress,
    tokenAddress: row.tokenAddress,
    tokenAccount: row.tokenAccount,
    permissionHash: row.permissionHash,
    maxAmountPerTx: baseUnitsToUsdc(BigInt(row.maxAmountPerTx)),
    maxAmountTotal: baseUnitsToUsdc(total),
    cumulativeSpent: baseUnitsToUsdc(spent),
    remainingBudget: baseUnitsToUsdc(remaining),
    expiresAt: row.expiresAt,
    allowedRecipients: row.allowedRecipients,
    higherRisk: row.higherRisk,
    flaggedForReview: row.flaggedForReview,
    createTxHash: row.createTxHash,
    revokeTxHash: row.revokeTxHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();

  // GET /api/networks -> which chains the operator has enabled (for the create form)
  app.get('/api/networks', async () =>
    enabledNetworks().map((n) => ({
      network: n,
      family: familyOf(n),
      expiryEnforcedOnChain: familyOf(n) === 'evm',
    })),
  );

  // POST /api/sessions -> issue an on-chain session key on the chosen network
  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const body = parsed.data;
    const network = body.network ?? env.EVM_NETWORK;

    if (!enabledNetworks().includes(network)) {
      return reply.code(400).send({ error: 'invalid_request', message: `network ${network} is not enabled` });
    }
    const adapter = adapterFor(network);

    const perTx = usdcToBaseUnits(body.maxAmountPerTx);
    const total = usdcToBaseUnits(body.maxAmountTotal);
    if (perTx <= 0n || total <= 0n) {
      return reply.code(400).send({ error: 'invalid_request', message: 'amounts must be > 0' });
    }
    if (body.expiresAt <= Math.floor(Date.now() / 1000)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'expiresAt must be in the future' });
    }

    // Per-chain address validation + canonicalization.
    for (const a of body.allowedRecipients) {
      if (!adapter.validateAddress(a)) {
        return reply.code(400).send({ error: 'invalid_request', message: `invalid ${network} address: ${a}` });
      }
    }
    const recipients =
      familyOf(network) === 'evm'
        ? body.allowedRecipients.map((a) => getAddress(a.toLowerCase() as `0x${string}`))
        : body.allowedRecipients;

    // Solana: SPL allows one delegate per token account, so only one active Solana
    // session on the shared treasury ATA at a time (option b). Reject with guidance.
    if (isSolanaNetwork(network)) {
      const active = await repo.list({ status: 'active' });
      if (active.some((s) => isSolanaNetwork(s.network))) {
        return reply.code(409).send({
          error: 'solana_session_exists',
          message:
            'An active Solana session already exists. SPL delegation allows one delegate per token account — revoke it before issuing another (per-session token accounts are a planned upgrade).',
        });
      }
    }

    const id = randomUUID();
    try {
      const issued = await adapter.issueSessionKey({
        sessionId: id,
        agentId: body.agentId,
        maxAmountPerTx: perTx,
        maxAmountTotal: total,
        expiresAt: body.expiresAt,
        allowedRecipients: recipients,
      });

      const now = Math.floor(Date.now() / 1000);
      const row = await repo.create({
        id,
        agentId: body.agentId,
        status: 'active',
        network,
        smartAccountAddress: issued.smartAccountAddress,
        spenderAddress: issued.spenderAddress,
        tokenAddress: issued.tokenAddress,
        tokenAccount: issued.tokenAccount,
        permissionHash: issued.permissionHash,
        maxAmountPerTx: perTx.toString(),
        maxAmountTotal: total.toString(),
        expiresAt: body.expiresAt,
        allowedRecipients: recipients,
        higherRisk: issued.higherRisk,
        flaggedForReview: false,
        cumulativeSpent: '0',
        createTxHash: issued.createTxHash,
        revokeTxHash: null,
        createdAt: now,
        updatedAt: now,
      });

      return reply.code(201).send(serialize(row));
    } catch (err) {
      req.log.error({ err }, 'session issuance failed');
      if (err instanceof OnchainError) {
        return reply.code(502).send({ error: 'onchain_error', message: err.message });
      }
      return reply.code(502).send({ error: 'onchain_error', message: (err as Error).message });
    }
  });

  // GET /api/sessions -> list (status, remaining budget, risk flags)
  app.get('/api/sessions', async (req, reply) => {
    const q = req.query as { agentId?: string; status?: string };
    const rows = await repo.list({ agentId: q.agentId, status: q.status });
    return reply.send(rows.map(serialize));
  });

  // GET /api/sessions/:id  (?onchain=true to include an authoritative chain read)
  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await repo.getById(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const base = serialize(row);
    const withOnchain = (req.query as { onchain?: string }).onchain === 'true';
    if (withOnchain) {
      const onchain = await adapterFor(row.network).readOnchainStatus(row);
      return reply.send({ ...base, onchain });
    }
    return reply.send(base);
  });

  // POST /api/sessions/:id/revoke -> REAL on-chain revocation
  app.post('/api/sessions/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await repo.getById(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!row.permissionHash && !row.tokenAccount) {
      return reply.code(409).send({ error: 'no_onchain_ref', message: 'session has no on-chain key to revoke' });
    }
    if (row.status === 'revoked') return reply.send(serialize(row));
    try {
      const { revokeTxHash } = await adapterFor(row.network).revokeSessionKeyOnchain(row);
      await repo.updateStatus(id, 'revoked', { revokeTxHash });
      const updated = await repo.getById(id);
      return reply.send(serialize(updated!));
    } catch (err) {
      req.log.error({ err }, 'revocation failed');
      return reply.code(502).send({ error: 'onchain_error', message: (err as Error).message });
    }
  });
}
