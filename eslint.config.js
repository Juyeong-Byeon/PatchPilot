import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "work/**", "coverage/**", ".superpowers/**", "docs/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
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
