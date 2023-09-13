// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

module.exports = {
    '*.{ts,tsx}': () => ['yarn typecheck', 'yarn format', 'git add'],
    relative: 'true',
};
