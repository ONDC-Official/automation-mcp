import { defineConfig } from "vitest/config";

export default defineConfig({
  // Native replacement for the vite-tsconfig-paths plugin: reads `paths`
  // straight from tsconfig.json, so the `@/` alias has exactly one definition.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The logger is a boot-time singleton reading the real environment, so
    // quieten it here rather than threading a config through every test.
    env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test/**",
        "src/entrypoints/**",
        "src/types/**",
      ],
      thresholds: { lines: 70, functions: 70 },
    },
  },
});
