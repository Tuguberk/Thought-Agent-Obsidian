import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["**/*.js"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],
    },
  },
  {
    // The OpenRouter settings surface legitimately shows the "OpenRouter" brand
    // name and literal, case-sensitive identifiers — model slugs like
    // deepseek/deepseek-v4-pro and URLs like https://openrouter.ai/models.
    // Sentence-casing those would corrupt real values, so treat OpenRouter as a
    // known brand (added to the defaults) and skip any label carrying a slug/URL.
    files: ["src/settings.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          ignoreWords: ["OpenRouter"],
          ignoreRegex: ["https?://", "[a-z0-9.]+/[a-z0-9.-]+"],
        },
      ],
    },
  },
]);
