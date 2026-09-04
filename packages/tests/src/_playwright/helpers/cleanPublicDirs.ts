// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import { glob } from 'glob';
import path from 'path';

export const cleanPublicDirs = async (publicDir: string) => {
    const directories = await glob('*/', { cwd: publicDir });
    await Promise.all(directories.map((directory) => rm(path.resolve(publicDir, directory))));
};
