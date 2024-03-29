// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const { Command } = require(`clipanion`);
const fs = require('fs-extra');
const path = require('path');

const JSON_PATH = path.resolve(path.join(__dirname, '../../../assets/dashboard.json'));

class Dashboard extends Command {
    async execute() {
        const prefix = this.prefix ? `${this.prefix}.` : '';
        // no-dd-sa:javascript-node-security/detect-non-literal-fs-filename
        const content = await fs.readFile(JSON_PATH, 'utf-8');
        console.log(content.replace(/\{\{PREFIX\}\}/g, prefix));
    }
}

Dashboard.addPath(`dashboard`);
Dashboard.addOption(
    `prefix`,
    Command.String(`-p,--prefix`, {
        description: 'What prefix do you use?',
    }),
);

module.exports = [Dashboard];
