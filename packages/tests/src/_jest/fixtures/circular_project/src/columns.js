// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// circular_project/src/columns.js

import { COLUMN_ID_APP_VERSION } from './mobile.js';

// Called through the barrel by mobile.js, before this module is evaluated.
export function cellWithLoader(cellRenderer) {
    return ({ cell }) => (cellRenderer ? cellRenderer({ cell }) : cell.value);
}

// Called by registry.js, before this module is evaluated.
export function withFallback(value, fallback) {
    return value ?? fallback;
}

export function getColumnTitle() {
    return 'App version';
}

export function getColumnId() {
    return COLUMN_ID_APP_VERSION;
}

export function assertColumnId(columnId) {
    if (columnId !== COLUMN_ID_APP_VERSION) {
        throw new Error('Unknown column');
    }
    return columnId;
}
