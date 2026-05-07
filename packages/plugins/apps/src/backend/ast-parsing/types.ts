// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type BackendExport = BackendLocalExport | BackendReExport;

export interface BackendLocalExport {
    kind: 'local';
    name: string;
    localName: string;
}

export interface BackendReExport {
    kind: 're-export';
    name: string;
    localName: string;
    source: string;
}
