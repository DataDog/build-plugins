// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ExecuteActionRequest, ExecuteActionResponse } from '../../protocol';
import type { BackendFunctionTransport } from '../types';
import { BackendFunctionError } from '../types';

const ENDPOINT = '/__dd/executeAction';

export const devServerTransport: BackendFunctionTransport = async <TData>(
    functionName: string,
    args: unknown[],
): Promise<TData> => {
    const request: ExecuteActionRequest = {
        functionName,
        args,
    };

    let response: Response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });
    } catch (error) {
        throw new BackendFunctionError(
            `Network error while executing backend function "${functionName}": ${
                error instanceof Error ? error.message : String(error)
            }`,
            functionName,
        );
    }

    if (!response.ok) {
        let errorMessage = `Backend function "${functionName}" failed with status ${response.status}`;
        try {
            const errorBody = await response.text();
            if (errorBody) {
                errorMessage += `: ${errorBody}`;
            }
        } catch {
            // Ignore errors reading error body
        }
        throw new BackendFunctionError(errorMessage, functionName, response.status);
    }

    let executeActionResponse: ExecuteActionResponse<TData>;
    try {
        executeActionResponse = await response.json();
    } catch (error) {
        throw new BackendFunctionError(
            `Failed to parse response from backend function "${functionName}": ${
                error instanceof Error ? error.message : String(error)
            }`,
            functionName,
            response.status,
        );
    }

    if (!executeActionResponse.success) {
        throw new BackendFunctionError(
            `Backend function "${functionName}" returned an error: ${executeActionResponse.error}`,
            functionName,
            response.status,
        );
    }

    return executeActionResponse.result.data;
};
