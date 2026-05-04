// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

import { datadogRum } from '@datadog/browser-rum';

const $ = document.querySelector.bind(document);

$('#trigger_entry_error').addEventListener('click', () => {
    datadogRum.addError(new Error('entry_error'));
});

$('#load_chunk').addEventListener('click', async () => {
    await import('./chunk.js');
});
