// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { FULL_NAME_BUNDLERS } from '@dd/core/constants';
import type { BundlerFullName } from '@dd/core/types';
import { bgYellow, dim, green, red } from '@dd/tools/helpers';

import { NEED_BUILD, NO_CLEANUP, REQUESTED_BUNDLERS } from './constants';

export const logTips = () => {
    if (NO_CLEANUP) {
        console.log(bgYellow(" Won't clean up "));
    }

    if (NEED_BUILD) {
        console.log(bgYellow(' Will also build used plugins '));
    }

    if (REQUESTED_BUNDLERS.length) {
        if (
            !(REQUESTED_BUNDLERS as BundlerFullName[]).every((bundler) =>
                FULL_NAME_BUNDLERS.includes(bundler),
            )
        ) {
            throw new Error(
                `Invalid "${red(`--bundlers ${REQUESTED_BUNDLERS.join(',')}`)}".\nValid bundlers are ${FULL_NAME_BUNDLERS.map(
                    (b) => green(b),
                )
                    .sort()
                    .join(', ')}.`,
            );
        }
        const bundlersList = REQUESTED_BUNDLERS.map((bundler) => green(bundler)).join(', ');
        console.log(`Running ${bgYellow(' ONLY ')} for ${bundlersList}.`);
    }

    if (!NO_CLEANUP || !NEED_BUILD || REQUESTED_BUNDLERS.length) {
        const tips: string[] = [];
        if (!NO_CLEANUP) {
            tips.push(`  ${green('--cleanup=0')} to keep the built artifacts.`);
        }
        if (!NEED_BUILD) {
            tips.push(`  ${green('--build=1')} to force the build of the used plugins.`);
        }
        if (!REQUESTED_BUNDLERS.length) {
            tips.push(`  ${green('--bundlers=webpack4,esbuild')} to only use specified bundlers.`);
        }
        console.log(dim(`\nYou can also use : \n${tips.join('\n')}\n`));
    }
};
