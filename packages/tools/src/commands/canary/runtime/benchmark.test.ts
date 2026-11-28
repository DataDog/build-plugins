// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    findInsufficientVariant,
    planLoads,
    runRuntimeBenchmark,
    summarizeLoads,
} from './benchmark';
import type { Chrome, ChromePage } from './chrome';
import { ChromeConnectionError, launchChrome } from './chrome';
import { createRandom } from './random';
import type { RuntimeLoad, RuntimePage, RuntimeSettings, RuntimeVariantTarget } from './types';

// Lets the benchmark run against a fake Chrome.
jest.mock('./chrome', () => {
    const original = jest.requireActual('./chrome');
    return {
        ...original,
        launchChrome: jest.fn(),
    };
});

const mockLaunchChrome = jest.mocked(launchChrome);

type Variant = 'control' | 'instrumented';

const VARIANTS: Variant[] = ['control', 'instrumented'];
const PAGES: RuntimePage[] = [
    { id: 'home', path: '/', readySelector: 'main' },
    { id: 'about', path: '/about', readySelector: 'main' },
];
const SETTINGS: RuntimeSettings = {
    repetitions: 4,
    cpuThrottlingRates: [1, 4],
    network: null,
    lcpSettleMs: 8_000,
    maxWaitMs: 40_000,
    bootstrapResamples: 200,
};

const createLoad = (
    overrides: Partial<RuntimeLoad<Variant>> & Pick<RuntimeLoad<Variant>, 'variant'>,
): RuntimeLoad<Variant> => {
    const lcpMs = overrides.variant === 'control' ? 1_000 : 1_200;
    return {
        repetition: 0,
        page: 'home',
        cache: 'cold',
        cpuThrottling: 1,
        ok: true,
        error: null,
        metrics: {
            fcpMs: lcpMs / 2,
            lcpMs,
            scriptMs: lcpMs / 4,
            blockingBeforeLcpMs: 0,
            jsTransferBytes: 1_000,
            jsDecodedBytes: 3_000,
        },
        jsRequests: 2,
        pageErrors: 0,
        failedRequests: 0,
        ...overrides,
    };
};

const getConditionKey = (load: {
    variant: string;
    page: string | RuntimePage;
    cache: string;
    cpuThrottling: number;
}): string => {
    const page = typeof load.page === 'string' ? load.page : load.page.id;
    return `${load.variant}:${page}:${load.cache}:${load.cpuThrottling}`;
};

describe('runtime benchmark plan', () => {
    test('should run every combination once per repetition', () => {
        const plan = planLoads({
            pages: PAGES,
            random: createRandom('seed'),
            settings: SETTINGS,
            variants: VARIANTS,
        });
        // 2 variants, 2 pages, 2 cache states and 2 CPU rates.
        const perRepetition = 16;

        expect(plan).toHaveLength(SETTINGS.repetitions * perRepetition);
        for (let repetition = 0; repetition < SETTINGS.repetitions; repetition++) {
            const loads = plan.slice(repetition * perRepetition, (repetition + 1) * perRepetition);
            const keys = new Set(loads.map(getConditionKey));
            expect(loads.every((load) => load.repetition === repetition)).toBe(true);
            expect(keys.size).toBe(perRepetition);
        }
    });

    test('should interleave cold and warm loads in a new order every repetition', () => {
        const plan = planLoads({
            pages: PAGES,
            random: createRandom('seed'),
            settings: SETTINGS,
            variants: VARIANTS,
        });
        const orders = new Set<string>();
        for (let repetition = 0; repetition < SETTINGS.repetitions; repetition++) {
            const loads = plan.filter((load) => load.repetition === repetition);
            const order = loads.map(getConditionKey).join(',');
            orders.add(order);
            const caches = loads.map((load) => load.cache).join(',');
            // Not one block of cold loads followed by one of warm loads.
            expect(caches).not.toMatch(/^(cold,){7}cold,(warm,){7}warm$/);
        }
        expect(orders.size).toBe(SETTINGS.repetitions);
    });

    test('should plan the same order from the same seed', () => {
        const options = { pages: PAGES, settings: SETTINGS, variants: VARIANTS };
        const first = planLoads({ ...options, random: createRandom('run') });
        const second = planLoads({ ...options, random: createRandom('run') });
        expect(first).toEqual(second);
    });
});

describe('runtime benchmark summary', () => {
    const settings: RuntimeSettings = { ...SETTINGS, cpuThrottlingRates: [1] };
    const pages = [PAGES[0]];

    test('should summarize each condition and compare each variant to control', () => {
        const loads = [0, 1, 2, 3].flatMap((repetition) => [
            createLoad({ repetition, variant: 'control' }),
            createLoad({ repetition, variant: 'instrumented' }),
            createLoad({ repetition, variant: 'control', cache: 'warm' }),
            createLoad({ repetition, variant: 'instrumented', cache: 'warm' }),
        ]);
        const conditions = summarizeLoads({
            controlVariant: 'control',
            loads,
            pages,
            random: createRandom('seed'),
            settings,
            variants: VARIANTS,
        });

        expect(
            conditions.map(({ cache, cpuThrottling, page }) => [page, cache, cpuThrottling]),
        ).toEqual([
            ['home', 'cold', 1],
            ['home', 'warm', 1],
        ]);
        const [cold] = conditions;
        expect(cold.variants.map((summary) => summary.variant)).toEqual(VARIANTS);
        expect(cold.variants[1]).toMatchObject({
            loads: 4,
            failedLoads: 0,
            metrics: { lcpMs: { median: 1_200, p75: 1_200, n: 4 } },
        });
        expect(cold.comparisons).toHaveLength(1);
        expect(cold.comparisons[0].variant).toBe('instrumented');
        expect(cold.comparisons[0].metrics.lcpMs).toEqual({
            control: 1_000,
            instrumented: 1_200,
            delta: 200,
            deltaPercent: 20,
            deltaCi95Low: 200,
            deltaCi95High: 200,
            deltaPercentCi95Low: 20,
            deltaPercentCi95High: 20,
        });
        // Every blocking time is 0, so there's no percentage.
        expect(cold.comparisons[0].metrics.blockingBeforeLcpMs?.deltaPercent).toBeNull();
    });

    test('should count failed loads and leave them out of the statistics', () => {
        const loads = [
            ...[0, 1, 2].map((repetition) => createLoad({ repetition, variant: 'control' })),
            ...[0, 1, 2].map((repetition) => createLoad({ repetition, variant: 'instrumented' })),
            createLoad({
                repetition: 3,
                variant: 'instrumented',
                ok: false,
                error: 'Timed out.',
                metrics: {
                    fcpMs: 99_000,
                    lcpMs: null,
                    scriptMs: null,
                    blockingBeforeLcpMs: null,
                    jsTransferBytes: null,
                    jsDecodedBytes: null,
                },
            }),
        ];
        const [cold] = summarizeLoads({
            controlVariant: 'control',
            loads,
            pages,
            random: createRandom('seed'),
            settings,
            variants: VARIANTS,
        });

        expect(cold.variants[1]).toMatchObject({ loads: 3, failedLoads: 1 });
        expect(cold.variants[1].metrics.fcpMs).toEqual({ median: 600, p75: 600, n: 3 });
    });

    test('should report a condition without loads as empty', () => {
        const [cold, warm] = summarizeLoads({
            controlVariant: 'control',
            loads: [],
            pages,
            random: createRandom('seed'),
            settings,
            variants: VARIANTS,
        });
        expect(cold.variants[0]).toMatchObject({ loads: 0, failedLoads: 0 });
        expect(cold.variants[0].metrics.lcpMs).toBeNull();
        expect(warm.comparisons[0].metrics.lcpMs).toBeNull();
    });

    const insufficientCases = [
        {
            description: 'blame control first when it loaded too rarely',
            controlLoads: 2,
            controlFailed: 0,
            instrumentedLoads: 0,
            instrumentedFailed: 0,
            expected: { variant: 'control', loads: 2, failedLoads: 0, cache: 'warm' },
        },
        {
            description: 'name the variant that loaded too rarely after control',
            controlLoads: 3,
            controlFailed: 0,
            instrumentedLoads: 1,
            instrumentedFailed: 0,
            expected: { variant: 'instrumented', loads: 1, failedLoads: 0, cache: 'warm' },
        },
        {
            description: 'accept 3 successful loads of every variant',
            controlLoads: 3,
            controlFailed: 0,
            instrumentedLoads: 3,
            instrumentedFailed: 0,
            expected: undefined,
        },
        {
            description: 'accept up to 10% failed loads',
            controlLoads: 9,
            controlFailed: 1,
            instrumentedLoads: 9,
            instrumentedFailed: 1,
            expected: undefined,
        },
        {
            description: 'name the variant that failed more than 10% of its loads',
            controlLoads: 10,
            controlFailed: 0,
            instrumentedLoads: 8,
            instrumentedFailed: 2,
            expected: { variant: 'instrumented', loads: 8, failedLoads: 2, cache: 'warm' },
        },
        {
            description: 'blame control first when it failed too often',
            controlLoads: 8,
            controlFailed: 2,
            instrumentedLoads: 5,
            instrumentedFailed: 5,
            expected: { variant: 'control', loads: 8, failedLoads: 2, cache: 'warm' },
        },
    ];

    test.each(insufficientCases)(
        'should $description',
        ({ controlLoads, controlFailed, instrumentedLoads, instrumentedFailed, expected }) => {
            const createWarmLoads = (variant: Variant, ok: number, failed: number) =>
                Array.from({ length: ok + failed }, (_, repetition) =>
                    createLoad({
                        repetition,
                        variant,
                        cache: 'warm',
                        ok: repetition < ok,
                        error: repetition < ok ? null : 'Timed out.',
                    }),
                );
            const loads = [
                ...createWarmLoads('control', controlLoads, controlFailed),
                ...createWarmLoads('instrumented', instrumentedLoads, instrumentedFailed),
            ];
            // Cold loads are fine, so only the warm condition can be short.
            for (let repetition = 0; repetition < 3; repetition++) {
                loads.push(createLoad({ repetition, variant: 'control' }));
                loads.push(createLoad({ repetition, variant: 'instrumented' }));
            }
            const conditions = summarizeLoads({
                controlVariant: 'control',
                loads,
                pages,
                random: createRandom('seed'),
                settings,
                variants: VARIANTS,
            });
            const insufficient = findInsufficientVariant(conditions, 'control');
            const found = insufficient && {
                variant: insufficient.variant,
                loads: insufficient.loads,
                failedLoads: insufficient.failedLoads,
                cache: insufficient.condition.cache,
            };

            expect(found).toEqual(expected);
        },
    );

    test('should say how often a variant failed', () => {
        const loads: RuntimeLoad<Variant>[] = [];
        for (let repetition = 0; repetition < 10; repetition++) {
            const ok = repetition >= 2;
            const error = ok ? null : 'Timed out.';
            loads.push(createLoad({ repetition, variant: 'instrumented', ok, error }));
            loads.push(createLoad({ repetition, variant: 'instrumented', cache: 'warm' }));
            loads.push(createLoad({ repetition, variant: 'control' }));
            loads.push(createLoad({ repetition, variant: 'control', cache: 'warm' }));
        }
        const conditions = summarizeLoads({
            controlVariant: 'control',
            loads,
            pages: [PAGES[0]],
            random: createRandom('seed'),
            settings: { ...SETTINGS, cpuThrottlingRates: [1] },
            variants: VARIANTS,
        });
        const insufficient = findInsufficientVariant(conditions, 'control');

        expect(insufficient?.message).toBe(
            'instrumented failed 2 of 10 loads of home (cold cache, CPU 1x), more than 10%.',
        );
    });
});

// What a page that loads at once answers: its ready selector is visible, LCP has
// settled, and nothing is on the network.
const evaluateInFakePage = (expression: string): unknown => {
    if (expression.includes('getBoundingClientRect')) {
        return true;
    }
    if (expression.includes('lastLcpMs')) {
        return { now: 10_000, lastLcpMs: 100 };
    }
    return { fcpMs: 50, lcpMs: 100, blockingBeforeLcpMs: 0, visibility: 'visible' };
};

const createFakePage = (): ChromePage => ({
    send: async (method, params) => {
        if (method === 'Runtime.evaluate') {
            const expression = typeof params?.expression === 'string' ? params.expression : '';
            return { result: { value: evaluateInFakePage(expression) } };
        }
        if (method === 'Performance.getMetrics') {
            return { metrics: [{ name: 'ScriptDuration', value: 0.1 }] };
        }
        return {};
    },
    on: () => () => undefined,
    waitFor: async () => ({}),
    close: async () => undefined,
});

describe('runtime benchmark failures', () => {
    // Priming opens 3 pages per variant: 2 warm visits and 1 cold one, control
    // first. 12 measured loads follow.
    const PRIMING_PAGES = 3 * VARIANTS.length;
    const MEASURED_LOADS = 12;
    const variants: RuntimeVariantTarget<Variant>[] = VARIANTS.map((id) => ({
        id,
        origin: 'http://127.0.0.1:9',
    }));

    const runWithFakeChrome = ({
        closeChrome = async () => undefined,
        openPage,
        signal,
    }: {
        closeChrome?: () => Promise<void>;
        // Gets the page's number, from 1.
        openPage: (pageNumber: number) => Promise<ChromePage>;
        signal?: AbortSignal;
    }) => {
        let openedPages = 0;
        const chrome: Chrome = {
            version: 'HeadlessChrome/1',
            newPage: () => {
                openedPages += 1;
                return openPage(openedPages);
            },
            close: closeChrome,
        };
        mockLaunchChrome.mockResolvedValue(chrome);
        return runRuntimeBenchmark({
            chromeFlags: [],
            chromePath: '/fake/chrome',
            controlVariant: 'control',
            log: () => undefined,
            pages: [PAGES[0]],
            seed: 'seed',
            settings: { ...SETTINGS, repetitions: 3, cpuThrottlingRates: [1], maxWaitMs: 1_000 },
            signal,
            variants,
        });
    };

    // Every page after the first `after` fails to open with failure().
    const failPagesAfter = (after: number, failure: () => Error) => async (pageNumber: number) => {
        if (pageNumber > after) {
            throw failure();
        }
        return createFakePage();
    };

    const connectionClosed = () => new ChromeConnectionError('The DevTools connection closed.');

    test('should stop on a Chrome failure instead of counting failed loads', async () => {
        const run = runWithFakeChrome({
            openPage: failPagesAfter(PRIMING_PAGES, connectionClosed),
        });
        await expect(run).rejects.toBeInstanceOf(ChromeConnectionError);
    });

    test("should not blame the variant that's priming when Chrome fails", async () => {
        // The instrumented variant's first priming visit, after control's three.
        const run = runWithFakeChrome({ openPage: failPagesAfter(3, connectionClosed) });
        await expect(run).rejects.toBeInstanceOf(ChromeConnectionError);
    });

    test("should treat Chrome failing to open a page as Chrome's failure", async () => {
        // The instrumented variant's first priming visit, which would otherwise be
        // blamed on the variant.
        const failure = () => new Error('Target.createTarget: Not attached.');
        const run = runWithFakeChrome({ openPage: failPagesAfter(3, failure) });
        await expect(run).rejects.toBeInstanceOf(ChromeConnectionError);
    });

    test("should count a page's own failures as failed loads and keep going", async () => {
        const result = await runWithFakeChrome({
            openPage: async (pageNumber) => {
                const page = createFakePage();
                if (pageNumber <= PRIMING_PAGES) {
                    return page;
                }
                return {
                    ...page,
                    send: async (method, params) =>
                        method === 'Page.navigate'
                            ? { errorText: 'net::ERR_CONNECTION_REFUSED' }
                            : page.send(method, params),
                };
            },
        });
        expect(result.loads).toHaveLength(MEASURED_LOADS);
        expect(result.loads.every((load) => !load.ok)).toBe(true);
        expect(result.loads[0].error).toContain('net::ERR_CONNECTION_REFUSED');
        expect(result.conditions[0].variants[0]).toMatchObject({ loads: 0, failedLoads: 3 });
    });

    test('should stop instead of returning a result when stopped after the last load', async () => {
        const controller = new AbortController();
        const run = runWithFakeChrome({
            // The last load's page aborts as it closes, after the load succeeded.
            openPage: async (pageNumber) => {
                const page = createFakePage();
                if (pageNumber < PRIMING_PAGES + MEASURED_LOADS) {
                    return page;
                }
                return {
                    ...page,
                    close: async () => {
                        controller.abort();
                    },
                };
            },
            signal: controller.signal,
        });
        await expect(run).rejects.toThrow('The runtime benchmark was stopped.');
    });

    test('should stop instead of returning a result when stopped while Chrome closes', async () => {
        const controller = new AbortController();
        const run = runWithFakeChrome({
            closeChrome: async () => {
                controller.abort();
            },
            openPage: async () => createFakePage(),
            signal: controller.signal,
        });
        await expect(run).rejects.toThrow('The runtime benchmark was stopped.');
    });
});
