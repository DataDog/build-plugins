module.exports = {
    name: `yarn-plugin-license-csv`,
    factory: require => {
        const {BaseCommand} = require(`@yarnpkg/cli`);
        const {Cache, Configuration, Manifest, Project, miscUtils, structUtils} = require(`@yarnpkg/core`);

        class LicenseCSVCommand extends BaseCommand {
            async execute() {
                const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
                const {project, workspace} = await Project.find(configuration, this.context.cwd);
                const cache = await Cache.find(configuration, {immutable: true});

                await project.restoreInstallState();

                const fetcher = configuration.makeFetcher();
                const fetchOptions = {project, cache, checksums: project.storedChecksums, fetcher};

                const seen = new Set();
                const results = [];

                const traverse = async descriptor => {
                    const resolution = project.storedResolutions.get(descriptor.descriptorHash);

                    if (seen.has(resolution)) {
                        return;
                    } else {
                        seen.add(resolution);
                    }

                    const pkg = project.storedPackages.get(resolution);

                    await process(pkg);

                    for (const dep of pkg.dependencies.values()) {
                        await traverse(dep);
                    }
                };

                const process = async locator => {
                    const fetchResult = await fetcher.fetch(locator, fetchOptions);

                    let manifest;
                    try {
                        manifest = await Manifest.find(fetchResult.prefixPath, {baseFs: fetchResult.packageFs});
                    } catch {
                        manifest = null;
                    } finally {
                        if (fetchResult.releaseFs) {
                            fetchResult.releaseFs();
                        }
                    }

                    if (manifest) {
                        results.push([locator, manifest]);
                    }
                };

                await traverse(workspace.anchoredDescriptor);
                this.context.stdout.write(`Component,Origin,Licence,Copyright\n`);
                const dependencies = {};
                for (const [locator, manifest] of miscUtils.sortMap(results, ([locator]) => structUtils.stringifyLocator(locator))) {
                    const m = manifest.raw;
                    const author = typeof m.author === 'object'
                        ? `${m.author.name} <${m.author.email}> (${m.author.url})`
                        : m.author;
                    dependencies[locator.name] = {
                        ...dependencies[locator.name],
                        name: locator.name,
                        author,
                        reference: locator.reference.split(':')[0],
                        license: m.license
                    };
                }

                for (const name of Object.keys(dependencies).sort()) {
                    const dependency = dependencies[name];
                    this.context.stdout.write(`${dependency.name},${dependency.reference},${dependency.license},${dependency.author}\n`);
                }
            };
        }

        LicenseCSVCommand.addPath(`licenses-csv`);

        return {
            commands: [
                LicenseCSVCommand,
            ],
        };
    },
}
