// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Partially taken from https://github.com/arcanis/webpack-project-generator/blob/master/generator.js

import { mkdir, rm } from '@dd/core/helpers/fs';
import faker from 'faker';
import fs from 'fs/promises';
import path from 'path';

const INITIAL_SEED = 123;
const NUMBER_OF_MODULES = 500;
const NUMBER_OF_ENTRIES = 2;
const PROJECT_PATH = 'fixtures/massiveProject';

type Module = {
    fileName: string;
    staticImports: Set<number>;
    dynamicImports: Set<number>;
    size: number;
    lazyOnly: boolean;
};

export const generateProject = async (
    nbEntries: number = NUMBER_OF_ENTRIES,
    nbModules: number = NUMBER_OF_MODULES,
) => {
    faker.seed(INITIAL_SEED);

    const modules: Module[] = [];
    for (let id = 0; id < nbModules; ++id) {
        modules.push({
            fileName: `file${`${id}`.padStart(4, `0`)}.js`,
            staticImports: new Set(),
            dynamicImports: new Set(),
            size: 0,
            lazyOnly: false,
        });
    }

    const entries: Set<number> = new Set();
    for (let t = 0; t < nbEntries; ++t) {
        entries.add(faker.datatype.number(modules.length - 1));
    }

    const randomDep = () => {
        let dep;
        do {
            dep = faker.datatype.number(modules.length - 1);
        } while (entries.has(dep));
        return dep;
    };

    for (const module of modules) {
        module.size = faker.datatype.number(30000);
        module.lazyOnly = faker.datatype.number(100) === 0;

        for (let t = 0; t < faker.datatype.number(8); ++t) {
            if (!module.lazyOnly) {
                module.staticImports.add(randomDep());
            } else {
                module.staticImports.add(randomDep());
            }
        }

        for (let t = 0; t < faker.datatype.number(8); ++t) {
            module.dynamicImports.add(randomDep());
        }
    }

    const target = path.join(__dirname, `../${PROJECT_PATH}`);

    // Clean previous project.
    await rm(target);
    await mkdir(target);

    // Create new project.
    await Promise.all(
        modules.map(async (module, moduleIndex) => {
            let content = ``;

            for (const importTarget of module.staticImports) {
                content += `import fn${importTarget} from './${modules[importTarget].fileName}';\n`;
            }
            content += `\n`;
            content += `let hasRan = false;\n`;
            content += `\n`;
            content += `const fn = async function () {\n`;
            content += `  if (hasRan) return;\n`;
            content += `  hasRan = true;\n`;
            for (const importTarget of module.staticImports) {
                content += `  await fn${importTarget}();\n`;
            }
            for (const importTarget of module.dynamicImports) {
                content += `  await (await import('./${modules[importTarget].fileName}')).default();\n`;
            }
            content += `  "${'x'.repeat(module.size)}";\n`;
            content += `};\n`;
            content += `\n`;
            content += `export default fn;\n`;
            if (entries.has(moduleIndex)) {
                content += `fn().catch(err => { console.error(err.stack); process.exitCode = 1; });\n`;
            }

            await fs.writeFile(path.join(target, module.fileName), content);
        }),
    );

    const entriesToReturn: Record<string, string> = {};
    let index = 0;

    for (const moduleId of entries) {
        entriesToReturn[`app${index}`] = `@dd/tests/${PROJECT_PATH}/${modules[moduleId].fileName}`;
        index += 1;
    }

    return entriesToReturn;
};
