import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Dummy values so modules that import env/db don't abort during unit tests.
    // PrismaClient construction does not open a connection, so no DB is needed.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test",
      SESSION_SECRET: "test-secret-value-1234567890",
    },
  },
});
