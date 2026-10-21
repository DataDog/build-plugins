// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs while the module loads, before the backend function is called.
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'top-level-probe.txt'), 'x');

export const writeAtLoad = 'written';
