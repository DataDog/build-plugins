// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import http from 'http';
import nock from 'nock';

export const LOCAL_REPLY = 'ok';

// Each nockReset fixture file requests a real local server and then resets the module registry, so
// a later file fails if an earlier file's nock still patches the worker-shared http module.
export const getLocalReply = async () => {
    const server = http.createServer((request, response) => response.end(LOCAL_REPLY));
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected the local server to listen on a TCP port');
        }
        nock.enableNetConnect(`127.0.0.1:${address.port}`);
        return await new Promise<string>((resolve, reject) => {
            http.get(`http://127.0.0.1:${address.port}/`, (response) => {
                let text = '';
                response.on('data', (chunk) => {
                    text += chunk;
                });
                response.on('end', () => resolve(text));
                response.on('error', reject);
            }).on('error', reject);
        });
    } finally {
        nock.disableNetConnect();
        await new Promise((resolve) => server.close(resolve));
    }
};
