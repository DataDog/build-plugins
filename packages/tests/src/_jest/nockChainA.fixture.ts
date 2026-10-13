// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Not named `*.test.*`: nockInterceptors.test.ts runs the nockChain fixtures together in one process.
import { getMockedReply } from './nockChainShared';

test('Should get a mocked reply in file a', async () => {
    const reply = getMockedReply('a');
    await expect(reply).resolves.toBe('ok');
});
