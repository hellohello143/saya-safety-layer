// Vitest setup — runs before each test file. Provides dummy CDP creds (so
// loadEnv passes) and an in-memory SQLite DB. Each test file runs isolated, so
// this in-memory DB is per-file; DB-backed suites reset tables in beforeEach.
process.env.CDP_API_KEY_ID = 'test';
process.env.CDP_API_KEY_SECRET = 'test';
process.env.CDP_WALLET_SECRET = 'test';
// Hermetic: pin the network so tests don't inherit the developer's real .env
// (EVM_NETWORK takes precedence over the legacy NETWORK alias).
process.env.EVM_NETWORK = 'base-sepolia';
process.env.SOLANA_NETWORK = 'off';
process.env.DATABASE_URL = ':memory:';
process.env.CIRCUIT_BREAKER_MAX_ATTEMPTS = '10';
process.env.CIRCUIT_BREAKER_WINDOW_SECONDS = '60';
