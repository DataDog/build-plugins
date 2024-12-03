import { createBrowserRouter } from '@datadog/browser-rum-react/react-router-v6';
import { reactPlugin } from '@datadog/browser-rum-react';

(() => {
    const globalAny: any = global;
    globalAny.reactPlugin = reactPlugin;
    globalAny.DD_RUM = globalAny.DD_RUM || {};
    globalAny.DD_RUM.createBrowserRouter = createBrowserRouter;
})();
