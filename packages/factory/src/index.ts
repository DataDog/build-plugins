import type { UnpluginFactory } from 'unplugin';
import { createUnplugin } from 'unplugin';

export interface Options {
    // define your plugin options here
}

export const unpluginFactory: UnpluginFactory<Options | undefined> = (options) => [
    {
        name: 'plugin-a',
        transform(code) {
            return code.replace(/<template>/, '<template><div>Injected</div>');
        },
    },
    {
        name: 'plugin-b',
        resolveId(id) {
            return id;
        },
    },
];

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory);

export default unplugin;
