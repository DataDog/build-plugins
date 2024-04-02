// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console, global-require, import/no-dynamic-require */
import c from 'chalk';

import { Options, LocalOptions, LocalHook, HOOKS, WRAPPED_HOOKS, HooksContext } from './types';

export class BaseClass {
    name: string;
    hooks: LocalHook[];
    hooksContext: any;
    options: LocalOptions;

    constructor(options: Options = {}) {
        this.name = 'BuildPlugin';
        this.hooks = [
            require('./hooks/renderer'),
            require('./hooks/datadog'),
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
                            }),
                        )
                        // no-dd-sa:typescript-node-security/detect-non-literal-require
                        .map((hookPath) => require(hookPath)),
                );
            } catch (e) {
                const error = e instanceof Error ? e.toString() : 'unknown error';
                this.log(`Couldn't add custom hook.`, 'error');
                this.log(error);
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
        const PLUGIN_NAME = this.name;
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
            const proms: Promise<any>[] = [];
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
}
