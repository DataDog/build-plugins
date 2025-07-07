// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
console.log('Hello, {{bundler}}!');
document.getElementById('btn').addEventListener('click', async () => {
    await import('./display-strings.js');
});

document.getElementById('btn2').addEventListener('click', async () => {
    throw new Error('test');
});
