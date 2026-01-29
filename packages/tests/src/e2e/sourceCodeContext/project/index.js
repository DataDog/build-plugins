// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

const $ = document.querySelector.bind(document);

$('#trigger_entry_error').addEventListener('click', () => {
    window.DD_RUM?.addError(new Error('entry_error'));
});

$('#trigger_entry_action').addEventListener('click', () => {
    window.DD_RUM?.addAction('entry_action');
});

$('#trigger_entry_fetch').addEventListener('click', () => {
    fetch('https://fakeurl.com/entry_fetch');
});

$('#trigger_entry_xhr').addEventListener('click', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://fakeurl.com/entry_xhr');
    xhr.send();
});

$('#trigger_entry_loaf').addEventListener('click', () => {
    const end = performance.now() + 55;
    while (performance.now() < end) {
        // block the handler for ~55ms to trigger a long task
    }
});

$('#load_chunk').addEventListener('click', async () => {
    await import('./chunk.js');
});
