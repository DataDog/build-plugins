import { buildPluginFactory } from '@dd/factory';

export const datadogWebpackPlugin = buildPluginFactory().webpack;
export default datadogWebpackPlugin;
module.exports = datadogWebpackPlugin;
