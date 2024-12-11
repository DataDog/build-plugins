import { datadogRum } from '@datadog/browser-rum';

// Wrapping it in order to avoid variable name collisions.
(() => {
    // To please TypeScript.
    const globalAny: any = global;

    // Also them to the global DD_RUM object.
    globalAny.DD_RUM = globalAny.DD_RUM || {};
    globalAny.DD_RUM = {
        ...globalAny.DD_RUM,
        ...datadogRum,
    };
})();
