// Breaker in-flight repository (node:sqlite). Tracks payment attempts that have
// passed the circuit breaker but not yet written their terminal audit row, so the
// breaker can count them on top of committed attempts. Kept in SQLite (not an
// in-memory Map) so the count is shared across processes and survives restart.

import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '../client.js';

export class BreakerRepository {
  private readonly db: Db;
  constructor(db: Db = getDb()) {
    this.db = db;
  }

  /** Mark an attempt in-flight. Returns the row id to release it with later. */
  begin(sessionId: string, at: number = Math.floor(Date.now() / 1000)): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO breaker_inflight (id, session_id, started_at) VALUES (?, ?, ?)').run(id, sessionId, at);
    return id;
  }

  /** Release an in-flight attempt (idempotent). */
  end(id: string): void {
    this.db.prepare('DELETE FROM breaker_inflight WHERE id = ?').run(id);
  }

  /** Drop rows older than `cutoff` — bounds table growth from attempts that were
   *  never released (e.g. a process crash between begin and end). Such rows are
   *  already ignored by countSince's window; this just reclaims them. */
  deleteStaleBefore(cutoff: number): void {
    this.db.prepare('DELETE FROM breaker_inflight WHERE started_at < ?').run(cutoff);
  }

  /** Count a session's in-flight attempts started at/after `since` (older rows are
   *  treated as stale and ignored — they fall outside the breaker's window). */
  countSince(sessionId: string, since: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM breaker_inflight WHERE session_id = ? AND started_at >= ?')
      .get(sessionId, since) as { n: number };
    return Number(row.n);
  }
}
