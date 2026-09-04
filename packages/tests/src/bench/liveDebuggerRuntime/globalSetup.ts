// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { setupPlaywrightTests } from '@dd/tests/_playwright/globalSetup';

import { BENCH_PUBLIC_DIR } from './constants';

const globalSetup = () => setupPlaywrightTests(BENCH_PUBLIC_DIR);

export default globalSetup;
