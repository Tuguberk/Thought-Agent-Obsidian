import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint,
      obsidianmd,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],
      // Obsidianmd required rules
      "obsidianmd/ui/sentence-case": ["error", { enforceCamelCaseLower: true }],
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/no-tfile-tfolder-cast": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/prefer-file-manager-trash-file": "warn",
      "obsidianmd/commands/no-plugin-name-in-command-name": "error",
      "obsidianmd/commands/no-command-in-command-name": "error",
    },
  },
];
