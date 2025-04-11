import { doRequest } from '@dd/core/helpers/request';
import type { AuthOptions } from '@dd/core/types';

import { INTAKE_PATH, INTAKE_HOST } from '../constants';
import type { CustomSpanPayload } from '../types';

export const sendSpans = async (auth: AuthOptions, spans: CustomSpanPayload) => {
    const result = await doRequest({
        url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
        method: 'POST',
        type: 'json',
        auth,
        getData: () => {
            const data = {
                data: {
                    type: 'ci_app_custom_spans',
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
