// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getEnv, logEnv, setupEnv } from './helpers/env';

const globalSetup = () => {
    const env = getEnv(process.argv);
    // Setup the environment.
    setupEnv(env);
    // Log some tips to the console.
    logEnv(env);

};

export default globalSetup;
