/* eslint-disable no-console */
const c = require('chalk');

const Tappables = require('./tappables');
const Loaders = require('./loaders');
const Modules = require('./modules');

class BuildPlugin {
    constructor(options = {}) {
        this.name = this.constructor.name;
        this.hooks = [
            // eslint-disable-next-line global-require
            require('./hooks/renderer'),
            // eslint-disable-next-line global-require
            require('./hooks/datadog'),
            // eslint-disable-next-line global-require
            require('./hooks/outputFiles')
        ];
        // Add custom hooks
        if (options.hooks && options.hooks.length) {
            try {
                this.hooks.push(
                    ...options.hooks
                        .map(hookPathInput =>
                            require.resolve(hookPathInput, {
                                paths: [process.cwd()]
                            })
                        )
                        // eslint-disable-next-line global-require,import/no-dynamic-require
                        .map(hookPath => require(hookPath))
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
            datadog: options.datadog
        };
    }

    log(text, type = 'log') {
        const PLUGIN_NAME = this.constructor.name;
        let color = c.default;
        if (type === 'error') {
            color = c.red;
        } else if (type === 'warn') {
            color = c.yellow;
        }

        console[type](`[${c.bold(PLUGIN_NAME)}] ${color(text)}`);
    }

    addContext(context) {
        this.hooksContext = {
            ...this.hooksContext,
            ...context
        };
    }

    // Will apply hooks for prehookName, hookName and posthookName
    async applyHooks(hookName, params) {
        const applyHook = name => {
            const proms = [];
            for (const hook of this.hooks) {
                if (hook.hooks && typeof hook.hooks[name] === 'function') {
                    const hookCall = hook.hooks[name].call(
                        this,
                        this.hooksContext
                    );
                    if (hookCall && typeof hookCall.then === 'function') {
                        proms.push(hookCall.then(this.addContext.bind(this)));
                    } else if (hookCall) {
                        this.addContext(hookCall);
                    }
                }
            }
            return Promise.all(proms);
        };

        await applyHook(`pre${hookName}`);
        await applyHook(hookName);
        await applyHook(`post${hookName}`);
    }

    apply(compiler) {
        if (this.options.disabled) {
            return;
        }

        const PLUGIN_NAME = this.constructor.name;
        const HOOK_OPTIONS = { name: PLUGIN_NAME };

        const modules = new Modules();
        const tappables = new Tappables();
        const loaders = new Loaders();

        tappables.throughHooks(compiler);

        compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, compilation => {
            this.options.context = compilation.options.context;
            tappables.throughHooks(compilation);

            compilation.hooks.buildModule.tap(HOOK_OPTIONS, module => {
                loaders.buildModule(module, this.options.context);
            });

            compilation.hooks.succeedModule.tap(HOOK_OPTIONS, module => {
                loaders.succeedModule(module, this.options.context);
            });

            compilation.hooks.afterOptimizeTree.tap(
                HOOK_OPTIONS,
                async (chunks, mods) => {
                    modules.afterOptimizeTree(
                        chunks,
                        mods,
                        this.options.context
                    );
                }
            );
        });

        compiler.hooks.done.tapPromise(HOOK_OPTIONS, async stats => {
            const start = Date.now();
            const { timings: tappableTimings } = tappables.getResults();
            const {
                loaders: loadersTimings,
                modules: modulesTimings
            } = loaders.getResults();
            const { modules: modulesDeps } = modules.getResults();

            const report = {
                timings: {
                    tappables: tappableTimings,
                    loaders: loadersTimings,
                    modules: modulesTimings
                },
                dependencies: modulesDeps
            };

            this.addContext({
                start,
                report,
                stats
            });

            await this.applyHooks('output');
        });
    }
}

module.exports = BuildPlugin;
