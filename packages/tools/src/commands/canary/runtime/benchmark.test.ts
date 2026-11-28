// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { findInsufficientVariant, planLoads, summarizeLoads } from './benchmark';
import { createRandom } from './random';
import type { RuntimeLoad, RuntimePage, RuntimeSettings } from './types';

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
            instrumentedLoads: 0,
            expected: { variant: 'control', loads: 2, cache: 'warm' },
        },
        {
            description: 'name the variant that loaded too rarely after control',
            controlLoads: 3,
            instrumentedLoads: 1,
            expected: { variant: 'instrumented', loads: 1, cache: 'warm' },
        },
        {
            description: 'accept 3 successful loads of every variant',
            controlLoads: 3,
            instrumentedLoads: 3,
            expected: undefined,
        },
    ];

    test.each(insufficientCases)(
        'should $description',
        ({ controlLoads, instrumentedLoads, expected }) => {
            const loads = [
                ...Array.from({ length: controlLoads }, (_, repetition) =>
                    createLoad({ repetition, variant: 'control', cache: 'warm' }),
                ),
                ...Array.from({ length: instrumentedLoads }, (_, repetition) =>
                    createLoad({ repetition, variant: 'instrumented', cache: 'warm' }),
                ),
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
                cache: insufficient.condition.cache,
            };

            expect(found).toEqual(expected);
        },
    );
});
