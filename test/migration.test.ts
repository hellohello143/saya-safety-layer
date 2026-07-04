import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/client.js';

// Simulate a pre-multi-chain database (the original sessions schema, no `network`
// / `token_account` columns) and confirm the additive migration upgrades it
// without losing data, defaulting legacy rows to base-sepolia.
describe('additive DB migration (backward compatibility)', () => {
  it('adds new columns to a legacy DB and defaults legacy rows to base-sepolia', () => {
    const db = new DatabaseSync(':memory:');
    // Original (pre-Solana) minimal sessions table.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        smart_account_address TEXT NOT NULL, spender_address TEXT NOT NULL, token_address TEXT NOT NULL,
        permission_hash TEXT, max_amount_per_tx TEXT NOT NULL, max_amount_total TEXT NOT NULL,
        expires_at INTEGER NOT NULL, allowed_recipients TEXT NOT NULL DEFAULT '[]',
        higher_risk INTEGER NOT NULL DEFAULT 0, flagged_for_review INTEGER NOT NULL DEFAULT 0,
        cumulative_spent TEXT NOT NULL DEFAULT '0', create_tx_hash TEXT, revoke_tx_hash TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        decision TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, smart_account_address, spender_address, token_address,
        max_amount_per_tx, max_amount_total, expires_at, created_at, updated_at)
       VALUES ('legacy-1','a','0xaa','0xbb','0xcc','1','2',9999,1,1)`,
    ).run();

    migrate(db); // idempotent additive migration
    migrate(db); // run twice — must not throw (idempotent)

    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('network');
    expect(cols).toContain('token_account');

    const row = db.prepare('SELECT network, token_account FROM sessions WHERE id = ?').get('legacy-1') as {
      network: string;
      token_account: string | null;
    };
    expect(row.network).toBe('base-sepolia'); // legacy default
    expect(row.token_account).toBeNull();

    const auditCols = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map((c) => c.name);
    expect(auditCols).toContain('network');
  });
});
