const { Cli } = require(`clipanion`);
const { readdirSync } = require(`fs`);

const cli = new Cli({
    binaryName: `yarn cli`
});

const commandPath = `${__dirname}/commands`;
for (const name of readdirSync(commandPath)) {
    const exports = require(`${commandPath}/${name}`);
    for (const command of exports) {
        cli.register(command);
    }
}

cli.runExit(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
});
