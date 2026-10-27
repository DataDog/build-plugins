// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LOCAL_REPLY, getLocalReply } from './nockResetShared';

afterEach(() => {
    jest.resetModules();
});

test('Should reach a local server in file b', async () => {
    const reply = getLocalReply();
    await expect(reply).resolves.toBe(LOCAL_REPLY);
});
