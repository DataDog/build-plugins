// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Meta, Options } from '../types';

import { getGitPlugin } from './git';
import { getGlobalContextPlugins } from './global-context';

export const getInternalPlugins = (options: Options, meta: Meta) => {
    const { globalContext, globalContextPlugins } = getGlobalContextPlugins(options, meta);
    const gitPlugin = getGitPlugin(options, globalContext);

    return { globalContext, internalPlugins: [...globalContextPlugins, gitPlugin] };
};
