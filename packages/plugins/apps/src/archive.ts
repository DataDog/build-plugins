// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fsp from 'fs/promises';
import fs from 'fs';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';

import type { Asset } from './assets';
import { ARCHIVE_FILENAME } from './constants';

export type Archive = {
    archivePath: string;
    size: number;
    assets: Asset[];
};

export const createArchive = async (assets: Asset[]): Promise<Archive> => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-'));
    const archivePath = path.join(tempDir, ARCHIVE_FILENAME);

    const zip = new JSZip();
    for (const asset of assets) {
        zip.file(asset.relativePath, fs.createReadStream(asset.absolutePath), {
            binary: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
        });
    }

    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(archivePath);
        const stream = zip.generateNodeStream({
            type: 'nodebuffer',
            streamFiles: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
        });
        stream.on('error', reject);
        output.on('error', reject);
        output.on('close', resolve);
        stream.pipe(output);
    });

    // Compute the size for logging purpose.
    const { size } = await fsp.stat(archivePath);

    return {
        archivePath,
        size,
        assets,
    };
};
