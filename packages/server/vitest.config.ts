import { defineConfig } from "vitest/config";

// When MOBILE_TEST_DATABASE_URL is set (opt-in DB integration run), the worker's
// DATABASE_URL must point at that same database from the very start — some
// integration test files import db.js transitively at collection time, before
// their beforeAll hook runs, so the PrismaClient singleton is constructed against
// whatever DATABASE_URL is present then. Threading the test DB URL through here
// makes every worker use it consistently. Unit-only runs keep the inert dummy.
const testDbUrl = process.env.MOBILE_TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Give DB-backed suites a generous hook budget (initialise + connect) and run
    // each file in its own forked process so per-file DB setup can't leak state.
    hookTimeout: 90_000,
    testTimeout: 30_000,
    pool: "forks",
    // Dummy values so modules that import env/db don't abort during unit tests.
    // PrismaClient construction does not open a connection, so no DB is needed.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDbUrl ?? "postgresql://user:pass@localhost:5432/test",
      SESSION_SECRET: "test-secret-value-1234567890",
    },
  },
});
