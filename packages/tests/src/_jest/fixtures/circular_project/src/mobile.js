// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// circular_project/src/mobile.js

import { cellWithLoader } from './index.js';
import { registry } from './registry.js';

export const COLUMN_ID_APP_VERSION = 'app_version';

export const column = { Cell: cellWithLoader(), width: registry.width };
