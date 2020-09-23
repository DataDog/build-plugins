// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

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
