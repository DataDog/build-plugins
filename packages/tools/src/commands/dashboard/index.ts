// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Option, Command } from 'clipanion';

class Dashboard extends Command {
    static paths = [['dashboard']];

    static usage = Command.Usage({
        category: `Reference`,
        description: `Print a basic Datadog dashboard configuration in JSON.`,
        details: `
            This command will output the JSON configuration to import in the Datadog UI.

            It comes with a default set of widget that will cover what's reported by the telemetry plugin.
        `,
        examples: [
            [`Get the basic config`, `$0 dashboard`],
            [
                `If you use a custom prefix with your plugin`,
                `$0 dashboard --prefix "build.metrics"`,
            ],
        ],
    });

    prefix = Option.String(`-p,--prefix`, {
        description: 'What prefix do you use for your metrics?',
    });

    async execute() {
        const prefix = this.prefix ? `${this.prefix}.` : '';
        const dashboard = await require('@dd/assets/dashboard.json');
        console.log(JSON.stringify(dashboard, null, 2).replace(/\{\{PREFIX\}\}/g, prefix));
    }
}

export default [Dashboard];
