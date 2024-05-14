// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Option, Command } from 'clipanion';

class Dashboard extends Command {
    static paths = [['dashboard']];
    prefix = Option.String(`-p,--prefix`, {
        description: 'What prefix do you use?',
    });

    async execute() {
        const prefix = this.prefix ? `${this.prefix}.` : '';
        const dashboard = await require('@dd/assets/dashboard.json');
        console.log(JSON.stringify(dashboard, null, 2).replace(/\{\{PREFIX\}\}/g, prefix));
    }
}

export default [Dashboard];
