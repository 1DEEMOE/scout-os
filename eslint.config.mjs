import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // Raw database connections exist only inside packages/db. Everything else
    // goes through withTenant / withUser / withGlobal.
    files: ["apps/**/*.{ts,tsx}", "packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "pg", message: "Use withTenant/withUser/withGlobal from @wos/db." }],
          patterns: [{ group: ["@wos/db/src/*", "**/db/src/client*"], message: "Use the @wos/db entry point." }],
        },
      ],
    },
  },
);
