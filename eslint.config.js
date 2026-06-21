import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "work/**",
      "coverage/**",
      ".superpowers/**",
      "docs/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting for source TS/TSX (scoped to each workspace's `src`,
    // which its tsconfig includes): surfaces unsafe `any` flows and unawaited
    // promises that the non-type-checked rules cannot see. Tests are excluded —
    // they are not in the tsconfig projects and mock heavily.
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      // Flags `as`/`<>` casts that don't change the type — keeps the codebase
      // free of redundant assertions that mask later type drift. Type-aware, so
      // it lives in this src-scoped block alongside the other no-unsafe-* rules.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // A let read in a closure before its single assignment cannot become const.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // TypeScript already checks for undefined identifiers; no-undef misfires on types/globals.
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "no-undef": "off" },
  },
  {
    // Node-side code: API, worker, runner, shared packages, build/ops scripts, tool configs.
    files: [
      "apps/api/**",
      "apps/worker/**",
      "apps/runner/**",
      "packages/**",
      "scripts/**",
      "**/*.mjs",
      "**/*.config.{js,ts}",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Browser-side admin SPA + React hooks rules.
    files: ["apps/admin/**"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Test files run under Vitest (jsdom for admin); allow both Node and browser globals.
    files: ["**/*.test.{ts,tsx}", "**/test/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
);
