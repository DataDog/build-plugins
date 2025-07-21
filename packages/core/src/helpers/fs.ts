// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { File } from 'buffer';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import type { FileValidity, LocalAppendOptions } from '../types';

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

// Read a file.
export const readFile = (filepath: string) => {
    return fsp.readFile(filepath, { encoding: 'utf-8' });
};

export const readFileSync = (filepath: string) => {
    return fs.readFileSync(filepath, { encoding: 'utf-8' });
};

export const existsSync = (filepath: string) => {
    try {
        return fs.existsSync(filepath);
    } catch (error: any) {
        // If the file does not exist, return false.
        if (error.code === 'ENOENT') {
            return false;
        }
        // If some other error occurs, rethrow it.
        throw error;
    }
};

// Some other more specific helpers.

// From a path, returns a File to use with native FormData and fetch.
export const getFile = async (filepath: string, options: LocalAppendOptions) => {
    if (typeof fs.openAsBlob === 'function') {
        // Support NodeJS 19+
        const blob = await fs.openAsBlob(filepath, { type: options.contentType });
        return new File([blob], options.filename);
    } else {
        // Support NodeJS 18-
        const stream = Readable.toWeb(fs.createReadStream(filepath));
        const blob = await new Response(stream).blob();
        const file = new File([blob], options.filename, { type: options.contentType });
        return file;
    }
};

// Verify that every files are available.
export const checkFile = async (filePath: string): Promise<FileValidity> => {
    const validity: FileValidity = {
        empty: false,
        exists: true,
    };

    try {
        const { size } = await fsp.stat(filePath);
        if (size === 0) {
            validity.empty = true;
        }
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            validity.exists = false;
        } else {
            // Other kind of error
            throw error;
        }
    }

    return validity;
};
