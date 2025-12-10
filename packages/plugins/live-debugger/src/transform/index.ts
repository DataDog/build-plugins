// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-nocheck - Babel type conflicts between @babel/parser and @babel/types versions
// Use require for better CommonJS/ESM compatibility with Babel packages
import { SKIP_INSTRUMENTATION_COMMENT } from '../constants';

import { generateFunctionId } from './functionId';
import { canInstrumentFunction, instrumentFunction, shouldSkipFunction } from './instrumentation';

const generate = require('@babel/generator').default;
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

export interface TransformOptions {
    code: string;
    filePath: string;
    buildRoot: string;
    skipHotFunctions: boolean;
}

export interface TransformResult {
    code: string;
    map?: any;
    instrumentedCount: number;
    totalFunctions: number;
}

/**
 * Transform JavaScript code to add Dynamic Instrumentation
 * Uses Babel to parse, transform, and generate code
 */
export function transformCode(options: TransformOptions): TransformResult {
    const { code, filePath, buildRoot, skipHotFunctions } = options;

    let instrumentedCount = 0;
    let totalFunctions = 0;

    // Parse the code
    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
        sourceFilename: filePath,
    });

    // Traverse and instrument functions
    traverse(ast, {
        Function(path) {
            totalFunctions++;

            // Check if we should skip this function
            if (!canInstrumentFunction(path)) {
                return;
            }

            if (skipHotFunctions && shouldSkipFunction(path, SKIP_INSTRUMENTATION_COMMENT)) {
                return;
            }

            // Generate function ID
            const functionId = generateFunctionId(filePath, buildRoot, path);

            // Instrument the function
            try {
                instrumentFunction(path, functionId);
                instrumentedCount++;
            } catch (error) {
                // Skip functions that fail to instrument
                // Errors are logged in debug mode
            }
        },
    });

    // Generate the transformed code
    const output = generate(
        ast,
        {
            sourceMaps: true,
            sourceFileName: filePath,
        },
        code,
    );

    return {
        code: output.code,
        map: output.map,
        instrumentedCount,
        totalFunctions,
    };
}
