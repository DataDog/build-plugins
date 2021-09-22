import { Metafile } from 'esbuild';
import { formatModuleName, getDisplayName } from '../helpers';
import { LocalModule } from '../types';

const modulesMap: { [key: string]: LocalModule } = {};

const getDefaultLocalModule = (name: string): LocalModule => ({
    name: getDisplayName(name),
    chunkNames: [],
    size: 0,
    dependencies: [],
    dependents: [],
});

export const getModulesResults = (esbuildMeta?: Metafile, context?: string) => {
    if (!esbuildMeta || !context) {
        return {};
    }
    for (const [path, obj] of Object.entries(esbuildMeta.inputs)) {
        const moduleName = formatModuleName(path, context);
        const module: LocalModule = modulesMap[moduleName] || getDefaultLocalModule(moduleName);

        module.size = obj.bytes;

        for (const dependency of obj.imports) {
            const depName = formatModuleName(dependency.path, context);
            module.dependencies.push(depName);
            const depObj: LocalModule = modulesMap[depName] || getDefaultLocalModule(depName);
            depObj.dependents.push(moduleName);
            modulesMap[depName] = depObj;
        }

        modulesMap[moduleName] = module;
    }
    return modulesMap;
};
