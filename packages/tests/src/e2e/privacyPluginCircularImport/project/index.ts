// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { processInModuleA } from './moduleA';

console.log('Hello, {{bundler}}!');

document.getElementById('testButton')?.addEventListener('click', () => {
    try {
        const result = processInModuleA('test-value');
        const output = document.getElementById('output');
        if (output) {
            output.textContent = `Result: ${result}`;
        }
    } catch (error) {
        console.error('Error:', error);
    }
});