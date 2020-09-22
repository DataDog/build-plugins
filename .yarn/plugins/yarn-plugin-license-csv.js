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
                for (const [locator, manifest] of miscUtils.sortMap(results, ([locator]) => structUtils.stringifyLocator(locator))) {
                    const m = manifest.raw;
                    const author = typeof m.author === 'object'
                        ? `${m.author.name} <${m.author.email}> (${m.author.url})`
                        : m.author;
                    this.context.stdout.write(`${locator.name},${locator.reference.split(':')[0]},${m.license},${author}\n`);
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
