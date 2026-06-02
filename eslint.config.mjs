/**
 * ESLint flat config — narrow scope.
 *
 * Single rule enabled: react/no-unstable-nested-components. Catches the
 * ProvRow-class bug (a component defined INSIDE another component's
 * render body, recreated on every parent render → loses identity →
 * children unmount/remount → focus loss + lost state). The smoking
 * gun was the inline ProvRow inside ProjectSettingsModal; the fix
 * (commit 2275286) moved it to a module-level component. This rule
 * prevents the same shape from regenerating.
 *
 * Intentionally NOT enabling eslint:recommended or any preset — they'd
 * surface 100+ noise warnings (unused imports, missing useEffect deps,
 * etc.) that drown the signal we care about. Tight rule set, broad
 * coverage of the failure mode.
 *
 * Run: `npx eslint .` or `npm run lint`.
 */
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";

export default [
  // Global ignores. Flat config requires this in its own object (with no
  // `files` key) so the .next build artefacts are excluded BEFORE any
  // file pattern matches them.
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "public/**",
      "scripts/**",
      "branding/configs/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    // react-hooks + @next/next + @typescript-eslint plugins registered
    // ONLY so existing `// eslint-disable-next-line <rule>` directives
    // in the source resolve cleanly. We don't enable any of their
    // rules — that would surface 100+ noise warnings and drown the
    // actual signal.
    plugins: {
      "react":              reactPlugin,
      "react-hooks":        reactHooksPlugin,
      "@next/next":         nextPlugin,
      "@typescript-eslint": tsPlugin,
    },
    settings: { react: { version: "detect" } },
    rules: {
      "react/no-unstable-nested-components": ["error", { allowAsProps: false }],
    },
  },
];
