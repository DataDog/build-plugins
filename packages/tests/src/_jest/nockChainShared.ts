// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import https from 'https';
import nock from 'nock';

export const CHAIN_FILE_COUNT = 3;

// Each nockChain fixture file mocks and makes one request, so running them in one worker shows
// whether an earlier file's nock still patches the shared https module.
export const getMockedReply = (name: string) => {
    nock('https://chain.test').get(`/${name}`).reply(200, 'ok');
    return new Promise<string>((resolve, reject) => {
        https
            .get(`https://chain.test/${name}`, (response) => {
                let text = '';
                response.on('data', (chunk) => {
                    text += chunk;
                });
                response.on('end', () => resolve(text));
            })
            .on('error', reject);
    });
};
