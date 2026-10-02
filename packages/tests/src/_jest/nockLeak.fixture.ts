// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import https from 'https';
import nock from 'nock';
import path from 'path';

import {
    FAILED,
    FETCH_REQUEST,
    GATE_FILE_NAME,
    HTTPS_REQUEST,
    LEAKED_REQUESTS,
    SETTLED,
    pollUntil,
} from './nockLeakShared';

// Not named `*.test.*`: nockInterceptors.test.ts spawns it in its own Jest process. Both replies
// wait for a gate file that the globalTeardown only creates after this file's own teardown, so the
// requests are guaranteed to still be in flight when Jest cleans up this file's globals.
const leakDir: unknown = Reflect.get(global, 'NOCK_LEAK_DIR');
if (typeof leakDir !== 'string') {
    throw new Error('The NOCK_LEAK_DIR global is required.');
}
const gatePath = path.join(leakDir, GATE_FILE_NAME);
const writeMarker = (name: string, content: string) => {
    const markerPath = path.join(leakDir, name);
    fs.writeFileSync(markerPath, content);
};
const MATCH_TIMEOUT_MS = 5000;
const waitForGate = () => pollUntil(() => fs.existsSync(gatePath), Number.POSITIVE_INFINITY);

test('Should leave fetch and https requests in flight when this file ends', async () => {
    const scope = nock('https://example.com')
        .get(`/${FETCH_REQUEST}`)
        .reply(async () => {
            await waitForGate();
            return [200, 'ok'];
        })
        .get(`/${HTTPS_REQUEST}`)
        .reply(async () => {
            await waitForGate();
            return [200, 'ok'];
        });
    let matchedRequests = 0;
    const bothMatched = new Promise<void>((resolve) => {
        scope.on('request', () => {
            matchedRequests += 1;
            if (matchedRequests === LEAKED_REQUESTS.length) {
                resolve();
            }
        });
    });

    fetch(`https://example.com/${FETCH_REQUEST}`)
        .then((response) => response.text())
        .then(() => writeMarker(FETCH_REQUEST, SETTLED))
        .catch(() => writeMarker(FETCH_REQUEST, FAILED));
    https
        .get(`https://example.com/${HTTPS_REQUEST}`, (response) => {
            response.resume();
            response.on('end', () => writeMarker(HTTPS_REQUEST, SETTLED));
        })
        .on('error', () => writeMarker(HTTPS_REQUEST, FAILED));

    const timedOut = new Promise<void>((resolve) => {
        const matchTimer = setTimeout(resolve, MATCH_TIMEOUT_MS);
        bothMatched.then(() => clearTimeout(matchTimer));
    });
    await Promise.race([bothMatched, timedOut]);
    expect(matchedRequests).toBe(LEAKED_REQUESTS.length);
});
