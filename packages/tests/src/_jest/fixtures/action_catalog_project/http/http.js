// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getExecuteActionImplementation } from '../action-execution.js';

export function request(request) {
    return getExecuteActionImplementation()('com.datadoghq.http.request', request);
}
