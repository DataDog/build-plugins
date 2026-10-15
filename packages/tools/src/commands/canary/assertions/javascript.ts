// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import { transform } from 'esbuild';

import { CanaryCommandError } from '../runner';

// Parse emitted files with an independent parser so instrumentation that
// produces invalid syntax fails the canary. esbuild accepts both ES modules
// and classic scripts, which covers the output of every supported bundler.
export const assertJavaScriptSyntax = async (filePaths: string[]): Promise<void> => {
    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        try {
            await transform(content, { loader: 'js', logLevel: 'silent' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new CanaryCommandError(`${filePath} is not valid JavaScript: ${message}`);
        }
    }
};
