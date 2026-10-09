// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Frontend code calling backend functions: two imported statically, sharing the entry's chunk,
// and one lazily, which gets a chunk of its own.
import { plainEcho } from './getRuntimeUsers.backend';
import { noSdkFunction } from './noSdk.backend';

export const callsBackend = async () => {
    const { usesHelper } = await import('./viaHelper.backend');
    console.log(await plainEcho('static'), await noSdkFunction(), await usesHelper('lazy'));
};

callsBackend();
