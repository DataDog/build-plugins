// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
console.log('Hello, {{bundler}}!');
let count = 0;
const foo = (strings, ...values) => {
    return strings.reduce((acc, str, i) => acc + str + (values[i] || ''), '');
};
document.getElementById('btn').addEventListener('click', async () => {
    console.log(foo`clicking${++count}times repeatedly`);
    await import('./display-strings.js');
});
