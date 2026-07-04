// Session repository (node:sqlite). All session persistence goes through here.
//
// Concurrency (spec §2 "Concurrency"): reserveSpend() does a race-free
// read-check-write inside a BEGIN IMMEDIATE transaction on a synchronous
// connection, so two simultaneous intents can't both pass the maxAmountTotal
// check. The on-chain cap is the backstop; this keeps the soft layer correct.

import { getDb, type Db } from '../client.js';
import type { NewSessionRow, SessionRow } from '../schema.js';

// All SELECTs alias snake_case columns -> camelCase so rows match SessionRow.
const SELECT_COLS = `
  id,
  agent_id              AS agentId,
  status,
  network,
  smart_account_address AS smartAccountAddress,
  spender_address       AS spenderAddress,
  token_address         AS tokenAddress,
  token_account         AS tokenAccount,
  permission_hash       AS permissionHash,
  max_amount_per_tx     AS maxAmountPerTx,
  max_amount_total      AS maxAmountTotal,
  expires_at            AS expiresAt,
  allowed_recipients    AS allowedRecipients,
  higher_risk           AS higherRisk,
  flagged_for_review    AS flaggedForReview,
  cumulative_spent      AS cumulativeSpent,
  create_tx_hash        AS createTxHash,
  revoke_tx_hash        AS revokeTxHash,
  created_at            AS createdAt,
  updated_at            AS updatedAt
`;

// node:sqlite returns null-prototype objects with raw column types; normalize.
function hydrate(raw: Record<string, unknown>): SessionRow {
  return {
    id: raw.id as string,
    agentId: raw.agentId as string,
    status: raw.status as string,
    network: (raw.network as string) ?? 'base-sepolia',
    smartAccountAddress: raw.smartAccountAddress as string,
    spenderAddress: raw.spenderAddress as string,
    tokenAddress: raw.tokenAddress as string,
    tokenAccount: (raw.tokenAccount as string | null) ?? null,
    permissionHash: (raw.permissionHash as string | null) ?? null,
    maxAmountPerTx: raw.maxAmountPerTx as string,
    maxAmountTotal: raw.maxAmountTotal as string,
    expiresAt: Number(raw.expiresAt),
    allowedRecipients: JSON.parse((raw.allowedRecipients as string) || '[]') as string[],
    higherRisk: Number(raw.higherRisk) === 1,
    flaggedForReview: Number(raw.flaggedForReview) === 1,
    cumulativeSpent: raw.cumulativeSpent as string,
    createTxHash: (raw.createTxHash as string | null) ?? null,
    revokeTxHash: (raw.revokeTxHash as string | null) ?? null,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  };
}

export class SessionRepository {
  private readonly db: Db;
  constructor(db: Db = getDb()) {
    this.db = db;
  }

  async create(row: NewSessionRow): Promise<SessionRow> {
    const now = Math.floor(Date.now() / 1000);
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, agent_id, status, network, smart_account_address, spender_address, token_address,
          token_account, permission_hash, max_amount_per_tx, max_amount_total, expires_at,
          allowed_recipients, higher_risk, flagged_for_review, cumulative_spent,
          create_tx_hash, revoke_tx_hash, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.agentId,
        row.status,
        row.network ?? 'base-sepolia',
        row.smartAccountAddress,
        row.spenderAddress,
        row.tokenAddress,
        row.tokenAccount ?? null,
        row.permissionHash ?? null,
        row.maxAmountPerTx,
        row.maxAmountTotal,
        row.expiresAt,
        JSON.stringify(row.allowedRecipients ?? []),
        row.higherRisk ? 1 : 0,
        row.flaggedForReview ? 1 : 0,
        row.cumulativeSpent ?? '0',
        row.createTxHash ?? null,
        row.revokeTxHash ?? null,
        createdAt,
        updatedAt,
      );
    const created = await this.getById(row.id);
    if (!created) throw new Error('failed to insert session');
    return created;
  }

  async getById(id: string): Promise<SessionRow | undefined> {
    const raw = this.db.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return raw ? hydrate(raw) : undefined;
  }

  async list(filter?: { agentId?: string; status?: string }): Promise<SessionRow[]> {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter?.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter?.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql =
      `SELECT ${SELECT_COLS} FROM sessions` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(hydrate);
  }

  async updateStatus(
    id: string,
    status: string,
    fields: Partial<Pick<SessionRow, 'revokeTxHash' | 'flaggedForReview' | 'permissionHash'>> = {},
  ): Promise<void> {
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [status, Math.floor(Date.now() / 1000)];
    if (fields.revokeTxHash !== undefined) {
      sets.push('revoke_tx_hash = ?');
      params.push(fields.revokeTxHash);
    }
    if (fields.flaggedForReview !== undefined) {
      sets.push('flagged_for_review = ?');
      params.push(fields.flaggedForReview ? 1 : 0);
    }
    if (fields.permissionHash !== undefined) {
      sets.push('permission_hash = ?');
      params.push(fields.permissionHash);
    }
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Race-free reserve of `amount` (base units) against maxAmountTotal. Returns
   * { ok:false, reason } if the session isn't active or the reservation would
   * exceed the total cap; on ok:true the cumulative ledger is advanced.
   * Synchronous by design — the atomicity is the point.
   */
  reserveSpend(id: string, amount: bigint): { ok: boolean; reason?: string } {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const raw = this.db
        .prepare('SELECT status, cumulative_spent AS spent, max_amount_total AS total FROM sessions WHERE id = ?')
        .get(id) as { status: string; spent: string; total: string } | undefined;
      if (!raw) {
        this.db.exec('ROLLBACK;');
        return { ok: false, reason: 'SESSION_NOT_FOUND' };
      }
      if (raw.status !== 'active') {
        this.db.exec('ROLLBACK;');
        return { ok: false, reason: 'SESSION_NOT_ACTIVE' };
      }
      const spent = BigInt(raw.spent);
      const total = BigInt(raw.total);
      if (spent + amount > total) {
        this.db.exec('ROLLBACK;');
        return { ok: false, reason: 'EXCEEDS_TOTAL_LIMIT' };
      }
      this.db
        .prepare('UPDATE sessions SET cumulative_spent = ?, updated_at = ? WHERE id = ?')
        .run((spent + amount).toString(), Math.floor(Date.now() / 1000), id);
      this.db.exec('COMMIT;');
      return { ok: true };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /** Compensating release used when an on-chain spend fails after a reserve. */
  releaseSpend(id: string, amount: bigint): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const raw = this.db
        .prepare('SELECT cumulative_spent AS spent FROM sessions WHERE id = ?')
        .get(id) as { spent: string } | undefined;
      if (raw) {
        const spent = BigInt(raw.spent);
        const next = spent > amount ? spent - amount : 0n;
        this.db
          .prepare('UPDATE sessions SET cumulative_spent = ?, updated_at = ? WHERE id = ?')
          .run(next.toString(), Math.floor(Date.now() / 1000), id);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }
}
