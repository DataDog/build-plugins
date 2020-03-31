/* eslint-disable no-console */
const Tappables = require('./src/tappables');
const Loaders = require('./src/loaders');
const Modules = require('./src/modules');

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
        this.hooksContext = {};
        this.options = {
            timestamp: Math.floor((options.timestamp || Date.now()) / 1000),
            hashRegex: options.hashRegex,
            apiKey: options.apiKey,
            defaultTags: options.tags || [],
            disabled: options.disabled,
            endPoint: options.endPoint || 'app.datadoghq.com',
            prefix: options.prefix || '',
            output: options.output,
            filters: options.filters || []
        };
    }

    addContext(context) {
        this.hooksContext = {
            ...context,
            ...this.hooksContext
        };
    }

    // Will apply hooks for prehookName, hookName and posthookName
    async applyHooks(hookName, params) {
        const applyHook = name => {
            const proms = [];
            for (const hook of this.hooks) {
                if (hook.hooks && typeof hook.hooks[name] === 'function') {
                    proms.push(
                        hook.hooks[name]
                            .call(this, this.hooksContext)
                            .then(this.addContext.bind(this))
                    );
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
