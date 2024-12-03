import { createBrowserRouter } from '@datadog/browser-rum-react/react-router-v6';

(() => {
    const globalAny: any = global;
    globalAny.DD_RUM = globalAny.DD_RUM || {};
    globalAny.DD_RUM.createBrowserRouter = createBrowserRouter;
})();
