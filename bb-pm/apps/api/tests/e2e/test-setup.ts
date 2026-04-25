/**
 * Per-file setup. Vitest's globalSetup mutates process.env in the parent
 * process; child workers re-import this file to re-export the same
 * constants so individual tests can read them.
 */

process.env.DATABASE_URL ??= "postgres://bbpm_test:bbpm_test_pwd@localhost:5434/bb_pm_test";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.AGENT_API_TOKEN ??= "test-agent-token-deadbeefdeadbeefdeadbeefdeadbeef";
process.env.AGENT_USER_EMAIL ??= "pm-agent-test@bluebolt.local";
process.env.JWT_SECRET ??= "test-jwt-secret-stable-for-fixtures";
process.env.NODE_ENV ??= "test";
