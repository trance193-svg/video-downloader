import globals from "globals";

export default [
  // The flat config itself is an ES module.
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },
  // Native host + tooling scripts run under Node.js.
  {
    files: ["host/**/*.js", "tools/**/*.js", "*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Extension code runs in browser-ish contexts and uses chrome.* APIs.
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "release/**", "test-shots/**"],
  },
];
