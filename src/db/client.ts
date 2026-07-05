// Thin DB bootstrap over Node's built-in `node:sqlite` (DatabaseSync). Only the
// repository layer (./repositories/*) imports this — the rest of the app talks to
// repositories, never to the driver, so a future swap to Postgres is a
// repository-layer change, not an app-wide rewrite.
//
// Why node:sqlite (not better-sqlite3 / Drizzle):
//   - Node v26 has no better-sqlite3 prebuild and this box has no C++ toolchain,
//     so the native build fails.
//   - drizzle-orm's released version ships no node:sqlite adapter.
//   node:sqlite is built into Node (zero deps, no compiler) and is synchronous,
//   which gives us real BEGIN IMMEDIATE transactions for race-free spend
//   accounting. Spec explicitly allows this fallback.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '../config/env.js';
import { SCHEMA_DDL } from './schema.js';

export type Db = DatabaseSync;

let db: Db | null = null;

/** Singleton DB handle. Ensures the parent dir exists and the schema is applied. */
export function getDb(): Db {
  if (db) return db;
  const env = loadEnv();
  const dir = dirname(env.DATABASE_URL);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(env.DATABASE_URL);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Wait briefly for a write lock instead of failing a payment's BEGIN IMMEDIATE
  // with SQLITE_BUSY the instant a second connection (an ops CLI, a mistaken
  // second instance) touches the file. Kept modest — the driver is synchronous,
  // so this is also the max the event loop can stall on lock contention.
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA_DDL); // idempotent CREATE TABLE IF NOT EXISTS (fresh DBs)
  migrate(db); // additive ALTERs for pre-existing DBs
  return db;
}

/** Add a column to an existing table if it isn't already present (idempotent). */
function addColumnIfMissing(handle: Db, table: string, column: string, ddl: string): void {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Additive, idempotent migrations so pre-existing DB files gain new columns. */
export function migrate(handle: Db): void {
  // Multi-chain columns (legacy rows default to base-sepolia, the only chain then).
  addColumnIfMissing(handle, 'sessions', 'network', "network TEXT NOT NULL DEFAULT 'base-sepolia'");
  addColumnIfMissing(handle, 'sessions', 'token_account', 'token_account TEXT');
  addColumnIfMissing(handle, 'audit_log', 'network', 'network TEXT');
}

/** Apply the schema. Kept as a named export so index.ts reads intentionally. */
export function ensureSchema(): void {
  getDb();
}
