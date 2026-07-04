// Audit repository (node:sqlite). Every payment intent is recorded here;
// queryable by agent, date range, and decision/status (spec §4). Also backs the
// circuit breaker's rolling-window attempt count.

import { getDb, type Db } from '../client.js';
import type { AuditRow, NewAuditRow } from '../schema.js';

export interface AuditQuery {
  agentId?: string;
  sessionId?: string;
  decision?: string;
  onchainStatus?: string;
  from?: number; // unix seconds (inclusive)
  to?: number; // unix seconds (inclusive)
  limit?: number;
}

const SELECT_COLS = `
  id,
  session_id       AS sessionId,
  agent_id         AS agentId,
  network,
  timestamp,
  target_url       AS targetUrl,
  requested_amount AS requestedAmount,
  recipient,
  decision,
  reason_code      AS reasonCode,
  risk_flags       AS riskFlags,
  tx_hash          AS txHash,
  onchain_status   AS onchainStatus,
  created_at       AS createdAt
`;

function hydrate(raw: Record<string, unknown>): AuditRow {
  return {
    id: raw.id as string,
    sessionId: (raw.sessionId as string | null) ?? null,
    agentId: raw.agentId as string,
    network: (raw.network as string | null) ?? null,
    timestamp: Number(raw.timestamp),
    targetUrl: (raw.targetUrl as string | null) ?? null,
    requestedAmount: (raw.requestedAmount as string | null) ?? null,
    recipient: (raw.recipient as string | null) ?? null,
    decision: raw.decision as string,
    reasonCode: (raw.reasonCode as string | null) ?? null,
    riskFlags: raw.riskFlags ? (JSON.parse(raw.riskFlags as string) as string[]) : null,
    txHash: (raw.txHash as string | null) ?? null,
    onchainStatus: (raw.onchainStatus as string | null) ?? null,
    createdAt: Number(raw.createdAt),
  };
}

export class AuditRepository {
  private readonly db: Db;
  constructor(db: Db = getDb()) {
    this.db = db;
  }

  async record(row: NewAuditRow): Promise<AuditRow> {
    const createdAt = row.createdAt ?? Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, session_id, agent_id, network, timestamp, target_url, requested_amount,
          recipient, decision, reason_code, risk_flags, tx_hash, onchain_status, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.sessionId ?? null,
        row.agentId,
        row.network ?? null,
        row.timestamp,
        row.targetUrl ?? null,
        row.requestedAmount ?? null,
        row.recipient ?? null,
        row.decision,
        row.reasonCode ?? null,
        row.riskFlags ? JSON.stringify(row.riskFlags) : null,
        row.txHash ?? null,
        row.onchainStatus ?? null,
        createdAt,
      );
    const created = await this.getById(row.id);
    if (!created) throw new Error('failed to insert audit row');
    return created;
  }

  async getById(id: string): Promise<AuditRow | undefined> {
    const raw = this.db.prepare(`SELECT ${SELECT_COLS} FROM audit_log WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return raw ? hydrate(raw) : undefined;
  }

  async updateOnchainStatus(id: string, status: string, txHash?: string): Promise<void> {
    if (txHash !== undefined) {
      this.db
        .prepare('UPDATE audit_log SET onchain_status = ?, tx_hash = ? WHERE id = ?')
        .run(status, txHash, id);
    } else {
      this.db.prepare('UPDATE audit_log SET onchain_status = ? WHERE id = ?').run(status, id);
    }
  }

  async query(q: AuditQuery): Promise<AuditRow[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.agentId) {
      where.push('agent_id = ?');
      params.push(q.agentId);
    }
    if (q.sessionId) {
      where.push('session_id = ?');
      params.push(q.sessionId);
    }
    if (q.decision) {
      where.push('decision = ?');
      params.push(q.decision);
    }
    if (q.onchainStatus) {
      where.push('onchain_status = ?');
      params.push(q.onchainStatus);
    }
    if (q.from !== undefined) {
      where.push('timestamp >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('timestamp <= ?');
      params.push(q.to);
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const sql =
      `SELECT ${SELECT_COLS} FROM audit_log` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY timestamp DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(hydrate);
  }

  /** Count payment attempts for a session at/after `sinceTs` (circuit breaker). */
  countAttemptsSince(sessionId: string, sinceTs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE session_id = ? AND timestamp >= ?')
      .get(sessionId, sinceTs) as { n: number };
    return Number(row.n);
  }
}
