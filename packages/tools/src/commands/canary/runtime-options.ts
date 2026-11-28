// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RuntimeNetworkThrottling, RuntimeSettings } from './runtime';

// About 15 minutes for Excalidraw: 6 loads a repetition at roughly 10s each.
export const DEFAULT_RUNTIME_REPETITIONS = '15';
export const DEFAULT_RUNTIME_CPU_THROTTLING = '1';
// A fast home connection: download Mbps, upload Mbps, latency in ms.
export const DEFAULT_RUNTIME_NETWORK = '40:10:20';
// A shorter settle wait cut the LCP of slower builds short in manual runs.
export const DEFAULT_RUNTIME_LCP_SETTLE_MS = '8000';
export const DEFAULT_RUNTIME_MAX_WAIT_MS = '40000';
const BOOTSTRAP_RESAMPLES = 2_000;
const MIN_REPETITIONS = 3;
const NO_NETWORK_THROTTLING = 'none';

export class RuntimeOptionError extends Error {}

const parseNumber = (option: string, value: string, minimum: number): number => {
    const parsed = Number(value.trim());
    if (value.trim() === '' || !Number.isFinite(parsed) || parsed < minimum) {
        throw new RuntimeOptionError(
            `${option} must be a number of at least ${minimum}, not "${value}".`,
        );
    }
    return parsed;
};

const parsePositive = (option: string, value: string): number => {
    const parsed = parseNumber(option, value, 0);
    if (parsed === 0) {
        throw new RuntimeOptionError(`${option} must be more than 0, not "${value}".`);
    }
    return parsed;
};

const parseInteger = (option: string, value: string, minimum: number): number => {
    const parsed = parseNumber(option, value, minimum);
    if (!Number.isInteger(parsed)) {
        throw new RuntimeOptionError(`${option} must be a whole number, not "${value}".`);
    }
    return parsed;
};

// A comma-separated list of CPU slowdown factors, such as "1,4".
export const parseCpuThrottling = (value: string): number[] => {
    const rates = value.split(',').map((rate) => parseNumber('--runtime-cpu-throttling', rate, 1));
    const uniqueRates = new Set(rates);
    if (uniqueRates.size !== rates.length) {
        throw new RuntimeOptionError(`--runtime-cpu-throttling lists a rate twice: "${value}".`);
    }
    return rates;
};

// "<download Mbps>:<upload Mbps>:<latency ms>", or "none".
export const parseNetwork = (value: string): RuntimeNetworkThrottling | null => {
    if (value.trim() === NO_NETWORK_THROTTLING) {
        return null;
    }
    const parts = value.split(':');
    if (parts.length !== 3) {
        throw new RuntimeOptionError(
            `--runtime-network must be "<download Mbps>:<upload Mbps>:<latency ms>" or "${NO_NETWORK_THROTTLING}", not "${value}".`,
        );
    }
    const [download, upload, latency] = parts;
    return {
        downloadMbps: parsePositive('--runtime-network download', download),
        uploadMbps: parsePositive('--runtime-network upload', upload),
        latencyMs: parseNumber('--runtime-network latency', latency, 0),
    };
};

export const parseRuntimeSettings = (options: {
    cpuThrottling: string;
    lcpSettleMs: string;
    maxWaitMs: string;
    network: string;
    repetitions: string;
}): RuntimeSettings => {
    const lcpSettleMs = parseInteger('--runtime-lcp-settle-ms', options.lcpSettleMs, 0);
    const maxWaitMs = parseInteger('--runtime-max-wait-ms', options.maxWaitMs, 1);
    if (maxWaitMs <= lcpSettleMs) {
        throw new RuntimeOptionError(
            '--runtime-max-wait-ms must be longer than --runtime-lcp-settle-ms.',
        );
    }
    return {
        repetitions: parseInteger('--runtime-repetitions', options.repetitions, MIN_REPETITIONS),
        cpuThrottlingRates: parseCpuThrottling(options.cpuThrottling),
        network: parseNetwork(options.network),
        lcpSettleMs,
        maxWaitMs,
        bootstrapResamples: BOOTSTRAP_RESAMPLES,
    };
};
