// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile } from '@dd/core/helpers/fs';

import { CanaryCommandError } from './runner';

export type JsonObject = Record<string, unknown>;

export const isJsonObject = (value: unknown): value is JsonObject => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const parseJsonObject = (content: string, filePath: string): JsonObject => {
    const value: unknown = JSON.parse(content);
    if (!isJsonObject(value)) {
        throw new CanaryCommandError(`${filePath} does not contain a JSON object.`);
    }
    return value;
};

export const readJsonObject = async (filePath: string): Promise<JsonObject> => {
    const content = await readFile(filePath);
    return parseJsonObject(content, filePath);
};

export const readFiles = async (filePaths: string[]): Promise<Map<string, string>> => {
    const files = new Map<string, string>();
    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        files.set(filePath, content);
    }
    return files;
};

export const restoreSnapshots = async (snapshots: Map<string, string>): Promise<void> => {
    for (const [filePath, expected] of snapshots) {
        const actual = await readFile(filePath);
        if (actual !== expected) {
            await outputFile(filePath, expected);
        }
    }
};
