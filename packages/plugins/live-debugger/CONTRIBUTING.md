# Contributing to Live Debugger <!-- #omit in toc -->

Developer notes for the Live Debugger plugin.

## Table of content <!-- #omit in toc -->

<!-- #toc -->
-   [Development workflow](#development-workflow)
-   [Runtime benchmark](#runtime-benchmark)
    -   [Running it](#running-it)
    -   [What it measures](#what-it-measures)
    -   [How to interpret the results](#how-to-interpret-the-results)
    -   [Methodology](#methodology)
    -   [Caveats](#caveats)
<!-- #toc -->

## Development workflow

Use the [root contributor guide](../../../CONTRIBUTING.md) for repository setup, formatting, and release process. This page covers the Live Debugger-specific checks that are easy to miss when changing the plugin.

Run the focused unit suite while iterating:

```bash
yarn test:unit packages/plugins/live-debugger
```

Run the package typecheck when changing exported types, option handling, or transform internals:

```bash
yarn workspace @dd/live-debugger-plugin typecheck
```

When changing instrumentation output, add or update cases in [`src/transform/index.test.ts`](./src/transform/index.test.ts). If the generated before/after shape changes in a way users or reviewers should understand, update [`EXAMPLES.md`](./EXAMPLES.md) alongside the tests.

Changes that affect source positions, injected wrappers, return rewriting, or error handling should preserve source maps. Cover those cases in [`src/sourcemap.integration.test.ts`](./src/sourcemap.integration.test.ts).

The Babel packages and `magic-string` are optional peer dependencies for consumers. Keep the transform dependencies lazy-loaded and preserve the user-facing missing-dependency error path. Update [`src/transform/lazy-deps.test.ts`](./src/transform/lazy-deps.test.ts) when touching dependency loading.

Generated code should keep the dormant runtime path small: call `$dd_probes(functionId)` first, and only call `$dd_entry`, `$dd_return`, or `$dd_throw` when a probe is active. Preserve the no-SDK fallback injected from [`src/runtime-bootstrap.ts`](./src/runtime-bootstrap.ts).

When adding or changing `liveDebugger` configuration, update [`src/types.ts`](./src/types.ts), [`src/validate.ts`](./src/validate.ts), [`src/validate.test.ts`](./src/validate.test.ts), and the consumer-facing [`README.md`](./README.md).

## Runtime benchmark

The opt-in browser benchmark measures the dormant runtime overhead added by Live Debugger instrumentation. It compares instrumented code against equivalent uninstrumented code, back-to-back in the same browser session, with the real Browser Debugger SDK loaded but dormant (no active probes).

### Running it

Run it locally with:

```bash
yarn workspace @dd/tests bench:live-debugger:runtime
```

For a faster loop, pass a browser project:

```bash
yarn workspace @dd/tests bench:live-debugger:runtime --project chrome
```

The terminal output prints one row per browser and workload (`Tiny`, `Hot`). Browser projects run serially to reduce CPU contention. The benchmark uses one fixed bundler so the report focuses on runtime overhead, not on bundler-to-bundler differences.

### What it measures

Each sample measures three variants:

- **baseline**: the uninstrumented workload.
- **control**: the same baseline function measured a second time. This is an A/A diagnostic for timing noise in the benchmark apparatus.
- **instrumented**: the same workload after Live Debugger instrumentation, with the real Browser Debugger SDK loaded but dormant (no active probes).

The reporter estimates overhead from `instrumented - control`. That direct paired difference avoids the old correlated-interval comparison against the shared baseline sample. The `control - baseline` result is still shown as the A/A diagnostic; it should be centered around zero if the browser session is quiet enough to trust.

There are two workloads because one number cannot describe every runtime shape:

- **Tiny** calls one very small instrumented function. It is the best row for answering: "what is the smallest cost we can measure for one dormant instrumented call?" Since the function does almost no work, its baseline time is tiny too. That means a small nanosecond cost can look like a large percentage.
- **Hot** runs an uninstrumented loop that calls a small instrumented kernel many times. It is the best row for answering: "what happens when an instrumented function sits on a hot path?" This row includes the cost of the dormant hooks and any optimizer disruption from the instrumented function shape, such as losing an inlining opportunity.

Read them together. `Tiny` shows the minimum cost and the measurement floor. `Hot` shows the repeated-call hot-path cost. If `Hot` is higher than `Tiny` in nanoseconds per call, the gap is the extra cost from the hot-path shape in this benchmark. If `Tiny` is higher in percentage, that usually means the denominator is much smaller, not that `Tiny` has a larger absolute cost.

### How to interpret the results

Start with three columns:

- **per-call overhead upper**: the headline number. It is the conservative upper bound for dormant overhead per instrumented function call, reported in nanoseconds.
- **quality**: whether the row is safe to read. `clean` means use the row, `caution` means it is usable but worth rerunning if the number matters, and `unreliable` means rerun before drawing conclusions.
- **overhead upper**: the same result as a workload-level percentage. Use this as context, not as the main comparison between `Tiny` and `Hot`.

Prefer the nanosecond number when comparing workloads. It puts `Tiny` and `Hot` on the same per-call scale. The percentage can look inverted because it divides by the workload's baseline time. `Tiny` does almost no work, so a small absolute cost can become a large percentage. `Hot` does more baseline work, so a larger absolute cost can still be a smaller percentage.

Example: if `Tiny` reports `<= 1.5 ns` and `Hot` reports `<= 5.0 ns`, the benchmark is saying the hot-path shape costs more per instrumented call. If those same rows report `Tiny <= 40%` and `Hot <= 5%`, that does not contradict the nanosecond result. It only means `Tiny` started from a much smaller baseline.

The other diagnostic columns explain why a row got its `quality` verdict:

- **95% CI**: the signed estimate range for `instrumented - control`. If it sits near zero, the overhead was too small to resolve clearly.
- **A/A diag**: `control - baseline`. This is the benchmark checking itself by timing the baseline code twice. A small value is fine; a value as large as the measured effect means the browser session was noisy.
- **Block CI** and **acf(1)**: checks for timing drift across samples. If the block interval tells the same story as the main interval, the row is usually fine even when `acf(1)` is non-zero.
- **Samples**: how many samples were recorded, plus trimming and outlier diagnostics. A few outliers are expected in browser timing. The row only becomes suspect when one side has enough outliers to survive the 20% trim.

The benchmark treats tiny "speed-ups" as measurement noise. Instrumentation only adds work, but separate baseline and instrumented bundles can land in slightly different code layouts. Below about `0.5 ns/call`, that layout noise is roughly the same size as the effect being measured, so the row is reported as clean but unresolved rather than as a real speed-up.

### Methodology

The benchmark tries to make each browser comparison fair and repeatable:

- It serves the page with cross-origin isolation headers so `performance.now()` has better precision.
- It warms up each workload before measuring, then calibrates the batch size, then warms up again with the calibrated size.
- It calibrates against the slowest variant. This keeps the slow instrumented batches from becoming much longer than the baseline batches, which would make the run more vulnerable to JIT warm-up or thermal drift.
- It records `baseline`, `control`, and `instrumented` back-to-back in rotating forward/reverse order. That keeps each variant from always running first, middle, or last.
- It rounds the sample count to a full counterbalancing period, `2 * variantCount`, so every timing position is represented evenly.

The reported point estimate is a trimmed mean of `instrumented - control`: the benchmark drops the noisiest 20% on each side and averages the middle. Confidence intervals are bootstrapped from the same paired samples. The percentage column uses the same paired data, but divides by the baseline workload time.

The benchmark uses the real published Browser Debugger SDK, loaded in a dormant state with no active probes, so the measured runtime path matches what ships.

The code uses more specific statistical machinery than this section describes, but the practical rule is simple: trust `clean` rows, rerun `unreliable` rows, and compare `Tiny` and `Hot` primarily on `per-call overhead upper`.

### Caveats

Do not compare absolute timings across unrelated machines. Treat the report as a back-to-back comparison from one browser session.

The benchmark builds separate baseline and instrumented bundles. That is necessary for the comparison, but it also means the browser may lay out or optimize the two bundles slightly differently. The A/A diagnostic can catch noise in the baseline path, but it cannot see every instrumented-bundle-specific effect. This is why `Tiny` and `Hot` should be read as a bracket rather than as one universal overhead number.

`Tiny` is close to the measurement floor on fast engines. A tiny negative result, especially below about `0.5 ns/call`, should be read as "too small to resolve", not as instrumentation making code faster.

Browser timings can be spiky or coarsely quantized. The trimmed mean handles ordinary spikes, and the `outliers` reason appears only when the spike pattern is large enough to threaten the estimate. If a row says `unreliable (outliers)`, rerun before trusting it.
