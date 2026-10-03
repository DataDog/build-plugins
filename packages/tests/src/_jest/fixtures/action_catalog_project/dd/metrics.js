// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Mirrors the real package's layout: an integration module importing the shared execution state.
import { getExecuteActionImplementation } from '../action-execution.js';

export async function queryTimeseriesData(request) {
    const implementation = getExecuteActionImplementation();
    if (!implementation) {
        throw new Error(
            '@datadog/action-catalog fixture: no execute-action implementation registered',
        );
    }
    return implementation('com.datadoghq.dd.metrics.queryTimeseriesData', request);
}
