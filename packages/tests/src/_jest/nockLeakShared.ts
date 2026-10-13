// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// The leak test, its fixture, and its teardown talk to each other through files named here.
export const FETCH_REQUEST = 'fetch';
export const HTTPS_REQUEST = 'https';
export const LEAKED_REQUESTS = [FETCH_REQUEST, HTTPS_REQUEST];
export const GATE_FILE_NAME = 'gate';
export const SETTLED = 'settled';
export const FAILED = 'failed';

const POLL_INTERVAL_MS = 20;

export const pollUntil = (isDone: () => boolean, deadline: number) =>
    new Promise<void>((resolve) => {
        const check = () => {
            if (isDone() || Date.now() >= deadline) {
                resolve();
                return;
            }
            setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
    });
