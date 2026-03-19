// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import fs from 'fs';
import path from 'path';

export interface BackendFunction {
    name: string;
    entryPath: string;
}

const EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];

/**
 * Discover backend functions in the backend directory (sync).
 * Must be sync because it runs in getPlugins() before the build starts.
 *
 * Supports two patterns:
 *   - Single file module: backend/functionName.{ts,js,tsx,jsx}
 *   - Directory module: backend/functionName/index.{ts,js,tsx,jsx}
 */
export function discoverBackendFunctions(backendDir: string, log: Logger): BackendFunction[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(backendDir);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            log.debug(`No backend directory found at ${backendDir}`);
            return [];
        }
        throw error;
    }

    const functions: BackendFunction[] = [];

    for (const entry of entries) {
        const entryPath = path.join(backendDir, entry);
        const entryStat = fs.statSync(entryPath);

        if (entryStat.isDirectory()) {
            for (const ext of EXTENSIONS) {
                const indexPath = path.join(entryPath, `index${ext}`);
                try {
                    fs.statSync(indexPath);
                    functions.push({ name: entry, entryPath: indexPath });
                    break;
                } catch {
                    // Try next extension
                }
            }
        } else if (entryStat.isFile()) {
            const ext = path.extname(entry);
            if (EXTENSIONS.includes(ext)) {
                const name = path.basename(entry, ext);
                functions.push({ name, entryPath });
            }
        }
    }

    log.debug(
        `Discovered ${functions.length} backend function(s): ${functions.map((f) => f.name).join(', ')}`,
    );
    return functions;
}
