// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

// Used by Playwright tests to ensure the chunk module has been evaluated.
window.chunkLoaded = true;

const $ = document.querySelector.bind(document);

$('#trigger_chunk_error').addEventListener('click', () => {
    window.DD_RUM?.addError(new Error('chunk_error'));
});

$('#trigger_chunk_action').addEventListener('click', () => {
    window.DD_RUM?.addAction('chunk_action');
});

$('#trigger_chunk_fetch').addEventListener('click', () => {
    fetch('https://fakeurl.com/chunk_fetch');
});

$('#trigger_chunk_xhr').addEventListener('click', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://fakeurl.com/chunk_xhr');
    xhr.send();
});

$('#trigger_chunk_loaf').addEventListener('click', () => {
    const end = performance.now() + 55;
    while (performance.now() < end) {
        // block the handler for ~55ms to trigger a long task
    }
});
