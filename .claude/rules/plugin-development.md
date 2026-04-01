---
paths: "packages/plugins/**"
---
# Plugin Development Conventions

- Inject bundler functionality (e.g., `vite.build`, bundler references) as parameters rather than importing bundler packages directly. This improves testability and avoids dynamic import issues.
- When a plugin needs bundler-specific behavior, encapsulate it in a bundler-specific sub-plugin (e.g., `getVitePlugin()`) and pass bundler functionality in from the top-level plugin entry point.
- The bundler reference is available through the factory's global context — don't import bundler APIs directly when the context already provides what you need.
- When adding new functionality, check if similar patterns already exist in other plugins. Follow established patterns for consistency.
