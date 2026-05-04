# `@datadog/eslint-plugin-apps`

ESLint rules for [Datadog High Code Apps](https://docs.datadoghq.com/service_management/app_builder/).

## Install

```bash
npm install --save-dev @datadog/eslint-plugin-apps
```

Requires `eslint >= 8.57.0`.

## Usage — flat config (`eslint.config.js`, ESLint v9)

```js
import apps from '@datadog/eslint-plugin-apps';
import tsParser from '@typescript-eslint/parser';

export default [
    ...apps.configs.recommended,
    {
        files: ['connections.{ts,tsx,js,jsx}'],
        languageOptions: { parser: tsParser },
    },
];
```

## Usage — legacy config (`.eslintrc`)

```json
{
    "extends": ["plugin:@datadog/apps/recommended-legacy"],
    "parser": "@typescript-eslint/parser"
}
```

## Rules

### `valid-connections-file`

Validates the project-root `connections.ts` file the Datadog vite plugin reads at build time. Mirrors the build plugin's structural requirements so authors see violations in their editor instead of as a build error.

The rule checks that the file:

- Defines exactly one top-level `export const CONNECTIONS = { … }`
- Uses an object literal for the initializer (not a function call)
- Does not use spread elements or computed keys inside the object
- Uses static string values (string literals or interpolation-free template literals — no env-var lookups, identifiers, concatenation, etc.)

The rule auto-scopes by filename — it only runs on files whose basename matches `connections.{ts,tsx,js,jsx}`.
