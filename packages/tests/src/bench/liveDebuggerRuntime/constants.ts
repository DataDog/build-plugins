// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ROOT } from '@dd/tools/constants';
import path from 'path';

export const BENCH_BUNDLER = 'rspack';
export const BENCH_BROWSERS = ['chrome', 'firefox', 'safari'] as const;
export const BENCH_DEV_SERVER_PORT = 8001;
export const BENCH_DEV_SERVER_URL = `http://localhost:${BENCH_DEV_SERVER_PORT}`;
export const BENCH_PUBLIC_DIR = path.resolve(
    ROOT,
    'packages/tests/src/bench/liveDebuggerRuntime/public',
);
