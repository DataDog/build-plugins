// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    assertSupportedVite,
    MIN_VITE_VERSION,
    unsupportedViteMessage,
} from '@dd/apps-plugin/vite/vite-version';

const [MIN_MAJOR, MIN_MINOR] = MIN_VITE_VERSION.split('.').map(Number);

describe('Apps Plugin - assertSupportedVite', () => {
    const supportedImported = `${MIN_MAJOR}.${MIN_MINOR}.3`;
    const olderImported = `${MIN_MAJOR}.${MIN_MINOR - 1}.5`;
    const hookContextOf = (viteVersion: string) => ({ meta: { viteVersion } });

    test.each(['5.4.21', '6.0.5', olderImported, `${MIN_VITE_VERSION}-beta.1`, 'v6.3.0', ''])(
        'Should refuse a running Vite %s',
        (version) => {
            const hookContext = hookContextOf(version);
            const expectedMessage = unsupportedViteMessage(version, supportedImported);
            const check = () => assertSupportedVite(hookContext, supportedImported);

            expect(check).toThrow(expectedMessage);
        },
    );

    const supportedRunning = [
        MIN_VITE_VERSION,
        `${MIN_MAJOR}.${MIN_MINOR + 10}.0`,
        `${MIN_MAJOR + 1}.0.0-beta.1`,
        `${MIN_MAJOR + 2}.3.3`,
        'v8.0.0',
    ];
    test.each(supportedRunning)('Should accept a running Vite %s', (version) => {
        const hookContext = hookContextOf(version);
        const check = () => assertSupportedVite(hookContext, supportedImported);

        expect(check).not.toThrow();
    });

    test.each(supportedRunning)(
        'Should refuse an older imported vite module under a running Vite %s',
        (version) => {
            const hookContext = hookContextOf(version);
            const expectedMessage = unsupportedViteMessage(version, olderImported);
            const check = () => assertSupportedVite(hookContext, olderImported);

            expect(check).toThrow(expectedMessage);
        },
    );

    test('Should name only one version when the running and imported versions match', () => {
        expect(unsupportedViteMessage(olderImported, olderImported)).toBe(
            unsupportedViteMessage(olderImported),
        );
    });

    test('Should ask for the floor without an install command', () => {
        const message = unsupportedViteMessage(olderImported);

        expect(message).toContain(`needs Vite ${MIN_MAJOR}.${MIN_MINOR} or later`);
        expect(message).not.toContain('npm install');
    });

    const withoutRunningVersion = [
        { description: 'no hook context', hookContext: undefined },
        { description: 'no meta.viteVersion', hookContext: { meta: { rollupVersion: '4.0.0' } } },
    ];

    test.each(withoutRunningVersion)(
        'Should check the imported version when Vite gives $description',
        ({ hookContext }) => {
            const expectedMessage = unsupportedViteMessage(olderImported);
            const refuse = () => assertSupportedVite(hookContext, olderImported);
            const accept = () => assertSupportedVite(hookContext, supportedImported);

            expect(refuse).toThrow(expectedMessage);
            expect(accept).not.toThrow();
        },
    );
});
