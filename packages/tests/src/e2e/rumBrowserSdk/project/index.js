// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global DD_RUM:readonly */
/* eslint-env browser */
DD_RUM.init({
    applicationId: 'xxx',
    clientToken: 'xxx',
    // `site` refers to the Datadog site parameter of your organization
    // see https://docs.datadoghq.com/getting_started/site/
    site: 'datad0g.com',
    service: 'test-service',
    // Specify a version number to identify the deployed version of your application in Datadog
    version: '0.0.1',
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: 'mask-user-input',
});

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
