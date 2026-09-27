// ESLint "flat config" (the current format, replacing .eslintrc). Rules apply top to bottom;
// later entries override earlier ones for the files they match.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "node_modules/"] },

  js.configs.recommended,

  // TypeScript: type-aware rules read the real types, so they catch bugs like a promise
  // that is never awaited, not just style problems.
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // node:test's describe/it return promises the runner already tracks; don't flag them.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "test", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
    },
  },

  // The dashboard script runs in the browser, not Node.
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
  { files: ["*.js"], languageOptions: { globals: globals.node } },

  // Last: turn off any rules that would fight Prettier's formatting.
  prettier,
);
