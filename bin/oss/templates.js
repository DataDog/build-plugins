module.exports = {
    header: `// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
`,
    notice: name => `Datadog ${name}
Copyright ${(new Date()).getFullYear()}-present Datadog, Inc.

This product includes software developed at Datadog (https://www.datadoghq.com/).
`,
    licenses: {
        'Apache 2': 'apache-2.txt',
        'BSD 3-Clause': 'bsd-3-clause.txt',
        'MIT': 'mit.txt'
    }
};
