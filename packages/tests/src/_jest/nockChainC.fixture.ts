// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockedReply } from './nockChainShared';

test('Should get a mocked reply in file c', async () => {
    const reply = getMockedReply('c');
    await expect(reply).resolves.toBe('ok');
});
