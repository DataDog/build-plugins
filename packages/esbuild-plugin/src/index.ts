import { buildPluginFactory } from '@dd/factory';

export const datadogEsbuildPlugin = buildPluginFactory().esbuild;
export default datadogEsbuildPlugin;
module.exports = datadogEsbuildPlugin;
