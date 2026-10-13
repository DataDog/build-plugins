// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Whether `code` loads `specifier` (or a subpath of it) through an identifier: a
// variable assigned the specifier, passed to `import()`, `require()`,
// `require.resolve()` or a `createRequire(...)` alias.
export const loadsSpecifierThroughIdentifier = (code: string, specifier: string): boolean => {
    const escapedSpecifier = escapeRegExp(specifier);
    const assignmentRe = new RegExp(
        `(?<![\\w$])([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*['"\`]${escapedSpecifier}(?:/[^'"\`]*)?['"\`]`,
        'g',
    );
    const assignments = code.matchAll(assignmentRe);
    const names = [...assignments].map(([, name]) => name);
    const requireAliases = code.matchAll(
        /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*createRequire\s*\(/g,
    );
    const aliasNames = [...requireAliases].map(([, name]) => escapeRegExp(name));
    const loaders = ['import', 'require(?:\\s*\\.\\s*resolve)?', ...aliasNames].join('|');
    return names.some((name) => {
        const escapedName = escapeRegExp(name);
        const loadRe = new RegExp(`(?<![\\w$.])(?:${loaders})\\s*\\(\\s*${escapedName}\\s*[,)]`);
        return loadRe.test(code);
    });
};
