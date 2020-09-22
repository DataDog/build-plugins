const { Cli } = require(`clipanion`);
const { readdirSync } = require(`fs`);

const cli = new Cli({
    binaryName: `yarn cli`
});

const commandPath = `${__dirname}`;
for (const file of readdirSync(commandPath, { withFileTypes: true })) {
    if (!file.isDirectory()) {
        continue;
    }
    const exports = require(`${commandPath}/${file.name}`);
    for (const command of exports) {
        cli.register(command);
    }
}

cli.runExit(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
});
