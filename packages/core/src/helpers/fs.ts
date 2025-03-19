// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';

// Replacing fs-extra with local helpers.
// Delete folders recursively.
export const rm = async (dir: string) => {
    return fsp.rm(dir, { force: true, maxRetries: 3, recursive: true });
};
export const rmSync = (dir: string) => {
    return fs.rmSync(dir, { force: true, maxRetries: 3, recursive: true });
};

// Mkdir recursively.
export const mkdir = async (dir: string) => {
    return fsp.mkdir(dir, { recursive: true });
};

export const mkdirSync = (dir: string) => {
    return fs.mkdirSync(dir, { recursive: true });
};

// Write a file but first ensure the directory exists.
export const outputFile = async (filepath: string, data: string) => {
    await mkdir(path.dirname(filepath));
    await fsp.writeFile(filepath, data, { encoding: 'utf-8' });
};

export const outputFileSync = (filepath: string, data: string) => {
    mkdirSync(path.dirname(filepath));
    fs.writeFileSync(filepath, data, { encoding: 'utf-8' });
};

// Output a JSON file.
export const outputJson = async (filepath: string, data: any) => {
    // FIXME: This will crash on strings too long.
    const dataString = JSON.stringify(data, null, 4);
    return outputFile(filepath, dataString);
};

export const outputJsonSync = (filepath: string, data: any) => {
    // FIXME: This will crash on strings too long.
    const dataString = JSON.stringify(data, null, 4);
    outputFileSync(filepath, dataString);
};

// Read a JSON file.
export const readJsonSync = (filepath: string) => {
    const data = fs.readFileSync(filepath, { encoding: 'utf-8' });
    return JSON.parse(data);
};
