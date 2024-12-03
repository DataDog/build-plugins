import { reactPlugin } from '@datadog/browser-rum-react';

const globalAny: any = global;
globalAny.reactPlugin = reactPlugin;
