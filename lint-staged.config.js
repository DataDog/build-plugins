// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

module.exports = {
    '*.{ts,tsx}': (filenames) => [
        `yarn cli typecheck-workspaces ${filenames.map((file) => `--files ${file}`).join(' ')}`,
        `eslint ${filenames.join(' ')} --quiet --fix`,
        'git add',
    ],
    '*.{js,mjs}': (filenames) => [`eslint ${filenames.join(' ')} --quiet --fix`, 'git add'],
    relative: 'true',
};
