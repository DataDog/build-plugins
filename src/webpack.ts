// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */
import c from 'chalk';

import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';
import {
    Options,
    LocalOptions,
    LocalHook,
    Compilation,
    HOOKS,
    WRAPPED_HOOKS,
    HooksContext,
    Report,
    Compiler,
    Stats,
} from './types';

export class BuildPlugin {
    name: string;
    hooks: LocalHook[];
    hooksContext: any;
    options: LocalOptions;

    constructor(options: Options = {}) {
        this.name = this.constructor.name;
        this.hooks = [
            // eslint-disable-next-line global-require
            require('./hooks/renderer'),
            // eslint-disable-next-line global-require
            require('./hooks/datadog'),
            // eslint-disable-next-line global-require
            require('./hooks/outputFiles'),
        ];
        // Add custom hooks
        if (options.hooks && options.hooks.length) {
            try {
                this.hooks.push(
                    ...options.hooks
                        .map((hookPathInput) =>
                            require.resolve(hookPathInput, {
                                paths: [process.cwd()],
                            })
                        )
                        // eslint-disable-next-line global-require,import/no-dynamic-require
                        .map((hookPath) => require(hookPath))
                );
            } catch (e) {
                this.log(`Couldn't add custom hook.`, 'error');
                this.log(e);
            }
        }

        this.hooksContext = {};
        this.options = {
            disabled: options.disabled,
            output: options.output,
            datadog: options.datadog,
            context: options.context,
        };
    }

    log(text: string, type: 'log' | 'error' | 'warn' = 'log') {
        const PLUGIN_NAME = this.constructor.name;
        let color = c;
        if (type === 'error') {
            color = c.red;
        } else if (type === 'warn') {
            color = c.yellow;
        }

        console[type](`[${c.bold(PLUGIN_NAME)}] ${color(text)}`);
    }

    addContext(context: HooksContext) {
        this.hooksContext = {
            ...this.hooksContext,
            ...context,
        };
    }

    // Will apply hooks for prehookName, hookName and posthookName
    async applyHooks(hookName: HOOKS) {
        const applyHook = (name: WRAPPED_HOOKS) => {
            const proms = [];
            for (const hook of this.hooks) {
                if (hook.hooks && typeof hook.hooks[name] === 'function') {
                    const hookCall = hook.hooks[name]!.call(this, this.hooksContext);
                    if (hookCall && typeof hookCall.then === 'function') {
                        proms.push(hookCall.then(this.addContext.bind(this)));
                    } else if (hookCall) {
                        this.addContext(hookCall);
                    }
                }
            }
            return Promise.all(proms);
        };

        await applyHook(`pre${hookName}` as WRAPPED_HOOKS);
        await applyHook(hookName as WRAPPED_HOOKS);
        await applyHook(`post${hookName}` as WRAPPED_HOOKS);
    }

    apply(compiler: Compiler) {
        if (this.options.disabled) {
            return;
        }

        const PLUGIN_NAME = this.constructor.name;
        const HOOK_OPTIONS = { name: PLUGIN_NAME };

        const modules = new Modules();
        const tapables = new Tapables();
        const loaders = new Loaders();

        tapables.throughHooks(compiler);

        compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, (compilation: Compilation) => {
            this.options.context = this.options.context || compilation.options.context;
            tapables.throughHooks(compilation);

            compilation.hooks.buildModule.tap(HOOK_OPTIONS, (module) => {
                loaders.buildModule(module, this.options.context!);
            });

            compilation.hooks.succeedModule.tap(HOOK_OPTIONS, (module) => {
                loaders.succeedModule(module, this.options.context!);
            });

            compilation.hooks.afterOptimizeTree.tap(HOOK_OPTIONS, (chunks, mods) => {
                modules.afterOptimizeTree(chunks, mods, this.options.context!, compilation);
            });
        });

        compiler.hooks.done.tapPromise(HOOK_OPTIONS, async (stats: Stats) => {
            const start = Date.now();
            const { timings: tapableTimings } = tapables.getResults();
            const { loaders: loadersTimings, modules: modulesTimings } = loaders.getResults();
            const { modules: modulesDeps } = modules.getResults();

            const report: Report = {
                timings: {
                    tapables: tapableTimings,
                    loaders: loadersTimings,
                    modules: modulesTimings,
                },
                dependencies: modulesDeps,
            };

            this.addContext({
                start,
                report,
                stats,
            });

            await this.applyHooks('output');
            this.log('Work done.');
        });
    }
}
