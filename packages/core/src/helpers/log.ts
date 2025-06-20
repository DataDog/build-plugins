import type { GlobalContext } from '../types';

import { doRequest } from './request';

export const INTAKE_PATH = 'v1/input/pub44d5f4eb86e1392037b7501f7adc540e';
export const INTAKE_HOST = 'browser-http-intake.logs.datadoghq.com';

type LogOptions = {
    message: string;
    context: GlobalContext;
    rest?: Record<string, string | number | boolean>;
};

export const submitLog = ({ message, context, rest }: LogOptions) => {
    return doRequest({
        // Don't delay the build too much on error.
        retries: 2,
        minTimeout: 100,
        url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
        method: 'POST',
        type: 'json',
        getData: async () => {
            const data = {
                ddsource: `@datadog/${context.bundler.name}-plugin`,
                env: context.env,
                message,
                service: 'build-plugins',
                bundler: {
                    name: context.bundler.name,
                    version: context.bundler.version,
                },
                metadata: context.build.metadata,
                plugins: context.pluginNames,
                version: context.version,
                team: 'language-foundations',
                ...rest,
            };
            return {
                data: JSON.stringify(data),
                headers: {
                    'Content-Type': 'application/json',
                },
            };
        },
    });
};
