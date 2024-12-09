// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/_jest/helpers/types';

describe('RUM Plugin', () => {
    const cleanups: CleanupFn[] = [];

    afterAll(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
    });

    test.skip('Should get the clientToken.', async () => {
        cleanups.push(
            await runBundlers({
                auth: {
                    apiKey: process.env.DD_API_KEY,
                    appKey: process.env.DD_APP_KEY,
                },
                rum: {
                    sdk: {
                        applicationId: '54caaabe-a702-4c07-89d8-8b7a064089aa',
                    },
                },
            }),
        );
    });
});
