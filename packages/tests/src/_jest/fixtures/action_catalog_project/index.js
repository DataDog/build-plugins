// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getExecuteActionImplementation } from './action-execution.js';

export async function sendSlackMessage(request) {
    const implementation = getExecuteActionImplementation();
    if (!implementation) {
        throw new Error('@datadog/action-catalog fixture: no execute-action implementation registered');
    }
    return implementation('com.datadoghq.slack.chat.postMessage', request);
}
