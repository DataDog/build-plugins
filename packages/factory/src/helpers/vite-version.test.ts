// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import vitePluginPackage from '../../../published/vite-plugin/package.json';

import { getUnsupportedViteWarning, MAX_VITE_MAJOR, MIN_VITE_VERSION } from './vite-version';

const floor = MIN_VITE_VERSION.split('.').slice(0, 2).join('.');
const deprecated = (version: string) =>
    `Vite ${version} is deprecated in Datadog's Vite plugin: please upgrade to Vite ${floor} or later.`;
const untested = (version: string) =>
    `Datadog's Vite plugin is tested up to Vite ${MAX_VITE_MAJOR}.x (found ${version}).`;

describe('getUnsupportedViteWarning', () => {
    const cases: { version: unknown; expected: string | undefined }[] = [
        { version: '4.5.3', expected: deprecated('4.5.3') },
        { version: '5.4.21', expected: deprecated('5.4.21') },
        { version: '6.0.0', expected: deprecated('6.0.0') },
        { version: '6.3.9', expected: deprecated('6.3.9') },
        { version: MIN_VITE_VERSION, expected: undefined },
        { version: '6.4.3', expected: undefined },
        { version: '6.10.0', expected: undefined },
        { version: '7.0.0-beta.1', expected: undefined },
        { version: '8.3.4', expected: undefined },
        { version: '9.0.0', expected: untested('9.0.0') },
        { version: '9.0.0-beta.1', expected: untested('9.0.0-beta.1') },
        { version: '10.1.0', expected: untested('10.1.0') },
        { version: 'v5.4.21', expected: undefined },
        { version: '', expected: undefined },
        { version: 'not-a-version', expected: undefined },
        { version: undefined, expected: undefined },
        { version: 5, expected: undefined },
    ];

    test.each(cases)('Should return the expected warning for $version', ({ version, expected }) => {
        const warning = getUnsupportedViteWarning(version);
        expect(warning).toBe(expected);
    });

    // Versions below the floor stay in the peer range while deprecated.
    test('Should share its upper bound with the peer range the Vite plugin declares', () => {
        const upperBound = new RegExp(`<= ?${MAX_VITE_MAJOR}\\.x$`);
        expect(vitePluginPackage.peerDependencies.vite).toMatch(upperBound);
    });
});
