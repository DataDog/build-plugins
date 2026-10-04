# apps_backend_library_project

An app (`app/`) and the packages it installs (`packages/`), for tests of backend functions shipped
by npm packages. It is not a fixtures workspace: tests assemble it into a temporary directory with
a real `node_modules/` layout (copied or symlinked), since that layout is what's under test.

-   `@fixtures/viz-lib` opts in with `"datadogApps": { "backendFunctions": true }`. Its frontend
    entry imports its own backend function through a self-referencing subpath, like
    `@datadog/apps-frontend/visualizations/backend`, and the backend calls an action through its
    `@datadog/action-catalog` peer dependency.
-   `plain-backend-lib` ships a `.backend.js` file without opting in; it must stay an ordinary module.
-   `@fixtures/banned-lib` opts in, but its backend function's helper imports a Node built-in.
-   `@fixtures/hooks-lib` opts in, but its backend function lives in a subfolder with its own named
    `package.json`, like `preact/hooks`. The package root's opt-in still covers it.
-   `linked-plain-backend-lib` doesn't opt in and is always symlinked from outside the app. A linked
    workspace file is always proxied, so its `.backend.js` fails the build instead of shipping.
