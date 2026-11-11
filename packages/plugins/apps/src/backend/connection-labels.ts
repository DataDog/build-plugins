// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AppsManifestConnectionLabelFallback } from '../types';

import type { ConnectionLabelCallSite } from './types';

export interface ConnectionLabelFields {
    connectionLabels: string[];
    connectionLabelFallbacks: AppsManifestConnectionLabelFallback[];
}

/** The fields a query carries so the server resolves its labels, in the manifest and in previews alike. */
export function toConnectionLabelFields(
    callSites: ConnectionLabelCallSite[],
): ConnectionLabelFields {
    const labels = callSites.map(({ label }) => label);
    const connectionLabelFallbacks: AppsManifestConnectionLabelFallback[] = [];
    for (const { label, fallbackConnectionId } of callSites) {
        if (fallbackConnectionId !== undefined) {
            connectionLabelFallbacks.push({ label, fallbackConnectionId });
        }
    }
    return { connectionLabels: [...new Set(labels)], connectionLabelFallbacks };
}
