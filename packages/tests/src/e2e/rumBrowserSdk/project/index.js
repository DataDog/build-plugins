// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global DD_RUM:readonly */
/* eslint-env browser */

DD_RUM.setViewName('custom_view');
DD_RUM.startSessionReplayRecording();

const $ = document.querySelector.bind(document);

$('#click_btn').addEventListener('click', () => {
    DD_RUM.addAction('custom_click', {
        bundler: '{{bundler}}',
    });
    // End the session to flush the data.
    DD_RUM.stopSession();
});
