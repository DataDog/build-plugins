// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import vitePluginPackage from '../../../published/vite-plugin/package.json';

import { getUnsupportedViteWarning, MAX_VITE_MAJOR, MIN_VITE_VERSION } from './vite-version';

const floor = MIN_VITE_VERSION.split('.').slice(0, 2).join('.');
const supported = (version: string) =>
    `Datadog's Vite plugin supports Vite ${MIN_VITE_VERSION} to ${MAX_VITE_MAJOR}.x (found ${version})`;
const below = (version: string) =>
    `${supported(version)}: please upgrade to Vite ${floor} or later.`;
const above = (version: string) => `${supported(version)}.`;

describe('getUnsupportedViteWarning', () => {
    const cases: { version: unknown; expected: string | undefined }[] = [
        { version: '4.5.3', expected: below('4.5.3') },
        { version: '5.4.21', expected: below('5.4.21') },
        { version: '6.0.0', expected: below('6.0.0') },
        { version: '6.3.9', expected: below('6.3.9') },
        { version: '6.4.0-beta.1', expected: below('6.4.0-beta.1') },
        { version: MIN_VITE_VERSION, expected: undefined },
        { version: '6.4.3', expected: undefined },
        { version: '6.10.0', expected: undefined },
        { version: '7.0.0-beta.1', expected: undefined },
        { version: '8.3.4', expected: undefined },
        { version: '9.0.0', expected: above('9.0.0') },
        { version: '9.0.0-beta.1', expected: above('9.0.0-beta.1') },
        { version: '10.1.0', expected: above('10.1.0') },
        { version: 'v5.4.21', expected: below('v5.4.21') },
        { version: '6.3', expected: undefined },
        { version: '', expected: undefined },
        { version: 'not-a-version', expected: undefined },
        { version: undefined, expected: undefined },
        { version: 5, expected: undefined },
    ];

    test.each(cases)('Should return the expected warning for $version', ({ version, expected }) => {
        const warning = getUnsupportedViteWarning(version);
        expect(warning).toBe(expected);
    });

    test('Should match the peer range the Vite plugin declares', () => {
        const peerRange = `>=${MIN_VITE_VERSION} <${MAX_VITE_MAJOR + 1}`;
        expect(vitePluginPackage.peerDependencies.vite).toBe(peerRange);
    });
});
