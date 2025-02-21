import type { Env } from '@dd/core/types';

declare global {
    namespace NodeJS {
        interface ProcessEnv {
            [key: string]: string | undefined;
            BUILD_PLUGINS_ENV?: Env;
            NO_CLEANUP?: '1';
            NEED_BUILD?: '1';
            REQUESTED_BUNDLERS?: string;
            JEST_SILENT?: '1';
        }
    }
}
