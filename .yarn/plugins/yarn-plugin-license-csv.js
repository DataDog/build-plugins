const SANIT_RX = /"/g;

module.exports = {
    name: `yarn-plugin-license-csv`,
    factory: require => {
        const {BaseCommand} = require(`@yarnpkg/cli`);
        const {Cache, Configuration, Manifest, Project, miscUtils, structUtils} = require(`@yarnpkg/core`);

        class LicenseCSVCommand extends BaseCommand {
            static paths = [[`licenses-csv`]];
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

                    let author = m.author || (m.maintainers && m.maintainers.shift());
                    if (typeof author === 'object') {
                        const mail = author.email ? ` <${author.email}>` : '';
                        const url = author.url ? ` (${author.url})` : '';
                        author = `${author.name}${mail}${url}`;
                    }

                    let license = m.license || (m.licenses && m.licenses.pop());
                    if (typeof license === 'object') {
                        license = license.type;
                    }

                    dependencies[locator.name] = {
                        ...dependencies[locator.name],
                        name: locator.name,
                        author: author && author.replace(SANIT_RX, ''),
                        reference: locator.reference.split(':')[0],
                        license
                    };
                }

                for (const name of Object.keys(dependencies).sort()) {
                    const dependency = dependencies[name];
                    const reference = dependency.reference || '';
                    const license = dependency.license || '';
                    const author = dependency.author || '';
                    this.context.stdout.write(`${name},${reference},${license},${author}\n`);
                }
            };
        }

        return {
            commands: [
                LicenseCSVCommand,
            ],
        };
    },
}
