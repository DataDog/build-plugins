// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import password from '@inquirer/password';

// Secret values are never accepted as CLI arguments (visible in shell history and via
// ps/proc to other users on the host) — they're always collected one at a time through a
// masked prompt. Sequential, not Promise.all, so prompts don't interleave on the terminal.
export const promptSecretValues = async (
    names: string[],
): Promise<{ name: string; value: string }[]> => {
    const tokens: { name: string; value: string }[] = [];
    for (const name of names) {
        const value = await password({ message: `Enter value for ${name}:`, mask: true });
        tokens.push({ name, value });
    }
    return tokens;
};
