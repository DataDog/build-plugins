// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LOCAL_REPLY, getLocalReply } from './nockResetShared';

test('Should reach a local server after a file that left a nock behind', async () => {
    const reply = getLocalReply();
    await expect(reply).resolves.toBe(LOCAL_REPLY);
});
