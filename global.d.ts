import type { Env } from '@dd/core/types';

interface CustomMatchers<R> {
    toBeWithinRange(floor: number, ceiling: number): R;
    toRepeatStringTimes(st: string | RegExp, occurences: number | [number, number]): R;
}

interface NonCustomMatchers {
    toBeWithinRange(floor: number, ceiling: number): number;
    toRepeatStringTimes(st: string | RegExp, occurences: number | [number, number]): string;
}

declare global {
    namespace NodeJS {
        interface ProcessEnv extends NodeJS.ProcessEnv {
            /**
             * If '1', we will build the projects using @datadog/rollup-plugin as a plugin.
             */
            ADD_BUILD_PLUGINS?: '1';
            /**
             * The environment in which the plugins will execute.
             *
             * For instance, we only submit logs to Datadog when the environment is `production`.
             */
            BUILD_PLUGINS_ENV?: Env;
            /**
             * Defined in github actions when running in CI.
             */
            CI?: '1';
            /**
             * Defined in github actions when running in CI.
             *
             * The commit SHA that triggered the workflow.
             */
            GITHUB_SHA?: string;
            /**
             * Run jest in silent mode.
             */
            JEST_SILENT?: '1';
            /**
             * To also build the plugins before running the tests when using `yarn test:unit`.
             */
            NEED_BUILD?: '1';
            /**
             * To skip the cleanup of the temporary working dirs where we build `runBundlers()`.
             */
            NO_CLEANUP?: '1';
            /**
             * To skip the generation of *.d.ts files in the build.
             */
            NO_TYPES?: '1';
            /**
             * Defined by yarn and targets the root of the project.
             */
            PROJECT_CWD?: string;
            /**
             * The list of bundlers to use in our tests.
             */
            REQUESTED_BUNDLERS?: string;
        }
    }
    // Extend Jest's expect with custom matchers defined
    // and injected from @dd/tests/src/_jest/setupAfterEnv.ts
    namespace jest {
        interface Expect extends NonCustomMatchers {}
        interface Matchers<R> extends CustomMatchers<R> {}
        interface InverseAsymmetricMatchers extends NonCustomMatchers {}
        interface AsymmetricMatchers extends NonCustomMatchers {}
    }
}
