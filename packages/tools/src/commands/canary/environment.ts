// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

// Variables that Yarn sets to identify the run of `yarn cli` itself.
const PARENT_RUN_VARIABLES = [
    'BERRY_BIN_FOLDER',
    'INIT_CWD',
    'PROJECT_CWD',
    'YARNSW_DETECTED_ROOT',
    'npm_config_user_agent',
    'npm_execpath',
    'npm_node_execpath',
];

// Yarn creates its shim folders as `xfs-*` temporary directories.
const SHIM_FOLDER_PREFIX = 'xfs-';

// Every nested Yarn run (`yarn cli` itself runs `yarn workspace @dd/tools cli`)
// prepends another shim folder next to the innermost one in BERRY_BIN_FOLDER.
const isYarnShimFolder = (entry: string, shimFolder: string): boolean => {
    if (entry === shimFolder) {
        return true;
    }
    const isSibling = path.dirname(entry) === path.dirname(shimFolder);
    return isSibling && path.basename(entry).startsWith(SHIM_FOLDER_PREFIX);
};

// Yarn prepends its own shims to PATH for the commands it runs, so a target
// command would otherwise use build-plugins' Yarn instead of the package
// manager pinned by the target checkout.
export const getTargetCommandEnvironment = (
    env: Record<string, string | undefined>,
): Record<string, string | undefined> => {
    const overrides: Record<string, string | undefined> = {};
    for (const name of PARENT_RUN_VARIABLES) {
        if (name in env) {
            overrides[name] = undefined;
        }
    }

    const shimFolder = env.BERRY_BIN_FOLDER;
    if (shimFolder && env.PATH) {
        const entries = env.PATH.split(path.delimiter);
        const targetEntries = entries.filter((entry) => !isYarnShimFolder(entry, shimFolder));
        overrides.PATH = targetEntries.join(path.delimiter);
    }

    return overrides;
};
