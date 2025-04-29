// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { AuthOptions } from '@dd/core/types';

import { INTAKE_PATH, INTAKE_HOST } from '../constants';
import type { CustomSpanPayload } from '../types';

export const sendSpans = async (auth: AuthOptions, spans: CustomSpanPayload) => {
    const result = await doRequest({
        url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
        method: 'POST',
        auth,
        getData: () => {
            const data = {
                data: {
                    type: 'ci_app_custom_span',
                    attributes: spans,
                },
            };

            return {
                data: JSON.stringify(data),
                headers: {
                    'Content-Type': 'application/json',
                },
            };
        },
    });

    return result;
};
