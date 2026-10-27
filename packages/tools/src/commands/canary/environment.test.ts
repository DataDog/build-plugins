// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { getTargetCommandEnvironment } from './environment';

describe('canary target command environment', () => {
    const shimFolder = '/tmp/xfs-1234';
    const cases = [
        {
            description: 'remove the Yarn shim folder from PATH and unset parent run variables',
            input: {
                BERRY_BIN_FOLDER: shimFolder,
                PATH: [shimFolder, '/usr/local/bin', '/usr/bin'].join(path.delimiter),
                PROJECT_CWD: '/build-plugins',
                npm_execpath: `${shimFolder}/yarn`,
                npm_config_registry: 'https://registry.example.com',
            },
            expected: {
                BERRY_BIN_FOLDER: undefined,
                PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter),
                PROJECT_CWD: undefined,
                npm_execpath: undefined,
            },
        },
        {
            description: 'remove the shim folders of outer Yarn runs',
            input: {
                BERRY_BIN_FOLDER: shimFolder,
                PATH: [shimFolder, '/tmp/xfs-5678', '/tmp/tools', '/usr/bin'].join(path.delimiter),
            },
            expected: {
                BERRY_BIN_FOLDER: undefined,
                PATH: ['/tmp/tools', '/usr/bin'].join(path.delimiter),
            },
        },
        {
            description: 'leave the environment unchanged outside of a Yarn run',
            input: {
                PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter),
                npm_config_registry: 'https://registry.example.com',
            },
            expected: {},
        },
    ];

    test.each(cases)('should $description', ({ input, expected }) => {
        expect(getTargetCommandEnvironment(input)).toStrictEqual(expected);
    });
});
