// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { isInjectionFile } from '@dd/core/helpers/plugins';
import type { PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { getContentToInject } from './helpers';
import type { ContentsToInject } from './types';

// Use "INJECTED_FILE" so it get flagged by isInjectionFile().
const TO_INJECT_ID = INJECTED_FILE;
const TO_INJECT_SUFFIX = '?inject-proxy';

export const getRollupPlugin = (contentsToInject: ContentsToInject): PluginOptions['rollup'] => {
    return {
        banner(chunk) {
            if (chunk.isEntry) {
                // Can be empty.
                return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
            }
            return '';
        },
        async resolveId(source, importer, options) {
            if (isInjectionFile(source)) {
                // It is important that side effects are always respected for injections, otherwise using
                // "treeshake.moduleSideEffects: false" may prevent the injection from being included.
                return { id: source, moduleSideEffects: true };
            }
            if (options.isEntry && getContentToInject(contentsToInject[InjectPosition.MIDDLE])) {
                // Determine what the actual entry would have been.
                const resolution = await this.resolve(source, importer, options);
                // If it cannot be resolved or is external, just return it so that Rollup can display an error
                if (!resolution || resolution.external) {
                    return resolution;
                }
                // In the load hook of the proxy, we need to know if the
                // entry has a default export. There, however, we no longer
                // have the full "resolution" object that may contain
                // meta-data from other plugins that is only added on first
                // load. Therefore we trigger loading here.
                const moduleInfo = await this.load(resolution);
                // We need to make sure side effects in the original entry
                // point are respected even for
                // treeshake.moduleSideEffects: false. "moduleSideEffects"
                // is a writable property on ModuleInfo.
                moduleInfo.moduleSideEffects = true;
                // It is important that the new entry does not start with
                // \0 and has the same directory as the original one to not
                // mess up relative external import generation. Also
                // keeping the name and just adding a "?query" to the end
                // ensures that preserveModules will generate the original
                // entry name for this entry.
                return `${resolution.id}${TO_INJECT_SUFFIX}`;
            }
            return null;
        },
        load(id) {
            if (isInjectionFile(id)) {
                // Replace with injection content.
                return getContentToInject(contentsToInject[InjectPosition.MIDDLE]);
            }
            if (id.endsWith(TO_INJECT_SUFFIX)) {
                const entryId = id.slice(0, -TO_INJECT_SUFFIX.length);
                // We know ModuleInfo.hasDefaultExport is reliable because we awaited this.load in resolveId
                const info = this.getModuleInfo(entryId);
                let code = `import ${JSON.stringify(TO_INJECT_ID)};\nexport * from ${JSON.stringify(entryId)};`;
                // Namespace reexports do not reexport default, so we need special handling here
                if (info?.hasDefaultExport) {
                    code += `export { default } from ${JSON.stringify(entryId)};`;
                }
                return code;
            }
            return null;
        },
        footer(chunk) {
            if (chunk.isEntry) {
                // Can be empty.
                return getContentToInject(contentsToInject[InjectPosition.AFTER]);
            }
            return '';
        },
    };
};
