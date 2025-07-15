// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { HOST_NAME } from '../constants';
import type { GlobalData, DdLogOptions } from '../types';

import { doRequest } from './request';

export const INTAKE_PATH = 'v1/input/pub44d5f4eb86e1392037b7501f7adc540e';
export const INTAKE_HOST = 'browser-http-intake.logs.datadoghq.com';

export const getSendLog =
    (data: GlobalData) =>
    ({ message, context }: DdLogOptions): Promise<void> => {
        return doRequest({
            // Don't delay the build too much on error.
            retries: 2,
            minTimeout: 100,
            url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
            method: 'POST',
            type: 'json',
            getData: async () => {
                const payload = {
                    ddsource: data.packageName || HOST_NAME,
                    message,
                    service: 'build-plugins',
                    team: 'language-foundations',
                    env: data.env,
                    version: data.version,
                    bundler: {
                        name: data.bundler.name,
                        version: data.bundler.version,
                    },
                    metadata: data.metadata,
                    ...context,
                };
                return {
                    data: JSON.stringify(payload),
                    headers: {
                        'Content-Type': 'application/json',
                    },
                };
            },
        });
    };
