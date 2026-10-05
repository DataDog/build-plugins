// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const importLoader = async () => {
    const { loadViteParseAst } = await import('./vite-parse-ast');
    return loadViteParseAst;
};

describe('Apps Plugin - loadViteParseAst', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("Should return the project Vite's parseAst", async () => {
        const parseAst = jest.fn();
        jest.doMock('vite', () => ({ parseAst, version: '8.3.2' }));
        const loadViteParseAst = await importLoader();

        const loading = loadViteParseAst();
        await expect(loading).resolves.toBe(parseAst);
    });

    test("Should fail with its own message when Vite's CJS entry throws on parseAst", async () => {
        const cjsVite = { version: '6.4.3' };
        const getParseAst = jest.fn(() => {
            throw new Error('parseAst is not available in the CJS build of Vite.');
        });
        Object.defineProperty(cjsVite, 'parseAst', { get: getParseAst, enumerable: true });
        jest.doMock('vite', () => cjsVite);
        const loadViteParseAst = await importLoader();

        const loading = loadViteParseAst();
        await expect(loading).rejects.toThrow("Couldn't load parseAst from Vite 6.4.3");
        expect(getParseAst).toHaveBeenCalled();
    });

    test('Should fail with the Vite version when Vite has no parseAst', async () => {
        jest.doMock('vite', () => ({ version: '4.5.0' }));
        const loadViteParseAst = await importLoader();

        const loading = loadViteParseAst();
        await expect(loading).rejects.toThrow(
            "Couldn't load parseAst from Vite 4.5.0; local execution needs Vite 5 or later, loaded through its ESM entry.",
        );
    });

    test('Should reuse one load across calls', async () => {
        jest.doMock('vite', () => ({ parseAst: jest.fn(), version: '6.4.3' }));
        const loadViteParseAst = await importLoader();

        const first = loadViteParseAst();
        const second = loadViteParseAst();
        await Promise.all([first, second]);
        expect(second).toBe(first);
    });

    test('Should retry the load after a failure instead of caching it', async () => {
        const viteMock: { version: string; parseAst?: jest.Mock } = { version: '6.4.3' };
        jest.doMock('vite', () => viteMock);
        const loadViteParseAst = await importLoader();

        const failing = loadViteParseAst();
        await expect(failing).rejects.toThrow("Couldn't load parseAst");

        const parseAst = jest.fn();
        viteMock.parseAst = parseAst;
        const retried = loadViteParseAst();
        await expect(retried).resolves.toBe(parseAst);
    });
});
