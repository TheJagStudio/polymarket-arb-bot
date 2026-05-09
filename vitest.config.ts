import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file gets its own module registry — so vi.mock() in one
    // file doesn't bleed into another (esp. the dotenv-loading config.ts).
    isolate: true,
    // Suppress console output during tests unless explicitly asked.
    silent: false,
    environment: "node",
  },
});
