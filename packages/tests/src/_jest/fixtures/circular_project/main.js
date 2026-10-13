// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// circular_project/main.js

// Importing columns.js first makes it wait on mobile.js and registry.js, which
// both call its function declarations before columns.js is evaluated.
import { assertColumnId, cellWithLoader, getColumnId, getColumnTitle } from './src/columns.js';
import { column } from './src/mobile.js';

globalThis.circularProject = {
    assertColumnId,
    cellWithLoader,
    column,
    getColumnId,
    getColumnTitle,
};
