// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      // Config files live outside tsconfig's `include`, so the type-aware
      // rules have no program for them.
      "*.config.js",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Load-bearing, not stylistic: on stdio, stdout IS the JSON-RPC channel.
      // A single console.log corrupts the protocol stream. Logs go to stderr
      // via the pino logger in src/lib/logger.ts.
      "no-console": "error",

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test files may stub and assert on loosely typed fixtures.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // The stdio entrypoint is the one place allowed to touch process streams
    // directly; it still must never write to stdout outside the transport.
    files: ["src/entrypoints/**"],
    rules: {
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
  {
    // Fastify mandates an async (or callback) plugin signature, and
    // `createContainer` is async so real implementations can await
    // connections. Requiring an `await` in the body would mean writing a
    // pointless one, so the rule is scoped off exactly where the shape is
    // imposed from outside rather than chosen.
    files: ["src/plugins/**", "src/container.ts", "src/modules/**/*.routes.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
);
