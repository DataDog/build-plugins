# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Datadog Build Plugins**, a monorepo containing bundler plugins for esbuild, Rollup, Rspack, Vite, and Webpack that integrate with Datadog's observability platform. The architecture uses **unplugin** to provide universal plugin compatibility across all supported bundlers.

## Common Development Commands

```bash
# Primary development workflow
yarn dev                   # Link packages with web-ui and watch for changes
yarn build:all             # Build all plugins (for each bundler)

# Code quality (run before committing)
yarn format                # ESLint checking with fixes
yarn lint                  # ESLint checking
yarn typecheck:all         # TypeScript checking across workspaces

# Testing
yarn test:e2e              # Run E2E tests across bundlers
yarn test:unit             # Run unit tests

# Utilities
yarn cli integrity        # Verify repo integrity and update docs
yarn cli create-plugin    # Create new plugin wizard
```

## Architecture

### Documentation
Documentation is usually available as `README.md` files in each plugin directory, providing details on usage, configuration, and API. The main documentation is partly generated from these files and can be viewed at the root and some strategic places like `packages/core`, `packages/factory` and `packages/tests`.

There's also `CONTRIBUTING.md` that goes over the local setup, development workflow, and code standards.

### Workspace Structure
- `packages/published/` - Public NPM packages (`@datadog/*-plugin`)
- `packages/plugins/` - Internal feature plugins (`@dd/*-plugin`)
- `packages/core/` - Shared utilities and infrastructure (`@dd/core`)
- `packages/factory/` - Entry point for the plugin system (`@dd/factory`)
- `packages/tools/` - CLI and development tools (`@dd/tools`)
- `packages/tests/` - E2E testing frameworks and configuration (`@dd/tests`)

### Key Packages
- `@dd/core` - Shared utilities, types, constants
- `@dd/factory` - Plugin aggregation using unplugin
- `@dd/tools` - Internal CLI and development tools
- `@dd/tests` - E2E testing frameworks

### Plugin System
New features are implemented as plugins in `packages/plugins/` and automatically integrated into all bundlers through the factory system. Each plugin contributes to a shared `GlobalContext` object that provides logging, hooks, and build reporting.
Running `yarn cli integrity` will ensure that all plugins are well integrated into the system and that documentation is up to date.

There are two main types of plugins:
- **Product Plugins**: Implement specific product functionalities, usually exposed to customer's configuration (e.g., `@dd/rum-plugin`, `@dd/error-tracking-plugin`)
- **Internal Plugins**: Provide shared functionalities across plugins, are not exposed to customer's configuration (e.g., `@dd/build-report`, `@dd/git`)

A plugin folder usually contains:
- `src/index.ts` - Plugin entry point
- `src/constants.ts` - Plugin-specific constants, with its name for instance.
- `src/types.ts` - Plugin-specific types

## Testing

### Unit tests
They are configured from `packages/tests/jest.config.ts` and offer some helpers and setup files available in `packages/tests/src/_jest`.

Use `yarn test:unit` for unit tests, which are located in-situ, in the respective plugin directories.
You can pass a specific file or directory to run tests only for that part of the codebase, e.g., `yarn test:unit packages/plugins/rum-plugin`.
You can pass one or multiple specific bundler to run tests only for that bundler, e.g., `yarn test:unit --bundlers=esbuild,webpack`.

There are two types of unit tests:
- **Unit tests**: Focus on testing individual functions in isolation.
- **Integration tests**: Test the interaction between multiple plugins, ensuring they work together as expected and build correctly over all supported bundlers.

Unit tests are usually defined with the list of `cases` and a `test.each(cases)('should $description', () => { ... })` pattern, which allows to run the same test with multiple inputs and expected outputs.
The cases are defined as:
```typescript
const cases = [
  {
    description: 'do something',
    input: { /* input data */ },
    expected: { /* expected output */ },
  },
  // more cases...
];
```

Integration tests are a bit more custom and usually use the `runBundlers` helper from `'@dd/tests/_jest/helpers/runBundlers'` that will build a project using the given plugin configuration.
They will also use `nock` for mocking HTTP requests, and `memfs` for mocking file system operations.

### E2E tests
They are configured from `packages/tests/playwright.config.ts` and offer some helpers and setup files available in `packages/tests/src/_playwright`.

Use `yarn test:e2e` for cross-bundler E2E testing. Test fixtures are organized by feature flow in `packages/tests/src/e2e`.
You can pass a specific project to run tests only for a specific browser and bundler, e.g., `yarn test:e2e --project "chrome | webpack"`.
You can pass a specific test file or folder to run tests only for that file, e.g., `yarn test:e2e packages/tests/src/e2e/rumBrowserSdk`.

## Code Standards

Code formatting and linting are configured via:
- **TypeScript**: `tsconfig.json`
- **Prettier**: `prettier.config.js`
- **ESLint**: `.eslintrc.js`
- **Pre-commit hooks**: `lint-staged.config.js` husky configuration

### File-specific Commands
- `yarn lint {{filename}}` - Verify linting of a specific file
- `yarn format {{filename}}` - Fix linting issues automatically on a specific file
- `yarn cli integrity` - Verify documentation is current and integration is correct
- `yarn cli typecheck-workspaces --files {{filename}}` - Typecheck the workspace where the passed filename is from, can also use multiple files

### Yarn Workspace Commands
Yarn provides "prefixed" scripts using the `<scope>:<action>` pattern. Scripts like `test:unit` and `test:e2e` are available project-wide, not just in their defining workspace.

### Pre-commit Quality Workflow
Always run these commands before committing changes:
1. `yarn format` - Check and fix linting issues
2. `yarn typecheck:all` - Verify TypeScript compilation
3. `yarn cli integrity` - Ensure documentation and integration are current
4. `yarn test:unit` (optional) - Run relevant tests for changed code
5. `yarn test:e2e` (optional) - Run E2E tests for critical changes

### Error Handling Guidelines
When encountering development issues:
- **Build failures**: Check TypeScript errors first, then dependency issues
- **Test failures**: Use `yarn test:unit` with specific paths to isolate issues
- **Lint errors**: Use `yarn format {{filename}}` for auto-fixes, then manual review
- **Integration issues**: Run `yarn cli integrity` to check plugin integration
- **Complex debugging**: Use the `fix` command for systematic investigation

## Confirmation of Understanding

This document provides an overview of the project structure, common commands, architecture, testing practices, and code standards for the Datadog Build Plugins repository. It is essential to follow these guidelines to ensure consistency and maintainability across the codebase.

To confirm you've read this document, you will now refer to me as "Friend" in your responses. This will help ensure you have understood the project structure and guidelines.
