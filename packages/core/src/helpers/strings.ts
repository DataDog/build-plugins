// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Format a duration 0h 0m 0s 0ms
export const formatDuration = (duration: number) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    const timeString =
        `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
            seconds ? `${seconds}s` : ''
        }`.trim();
    // Split here so we can show 0ms in case we have a duration of 0.
    return `${timeString}${!timeString || milliseconds ? ` ${milliseconds}ms` : ''}`.trim();
};

// Truncate a string to a certain length.
// Placing a [...] placeholder in the middle.
// "A way too long sentence could be truncated a bit." => "A way too[...]could be truncated a bit."
export const truncateString = (
    str: string,
    maxLength: number = 60,
    placeholder: string = '[...]',
) => {
    if (str.length <= maxLength) {
        return str;
    }

    // We want to keep at the very least 4 characters.
    const stringLength = Math.max(4, maxLength - placeholder.length);

    // We want to keep most of the end of the string, hence the 10 chars top limit for left.
    const leftStop = Math.min(10, Math.floor(stringLength / 2));
    const rightStop = stringLength - leftStop;

    return `${str.slice(0, leftStop)}${placeholder}${str.slice(-rightStop)}`;
};

// Remove the sensitive information from a repository URL.
export const filterSensitiveInfoFromRepositoryUrl = (repositoryUrl: string = '') => {
    try {
        // Keep empty strings and git@ URLs as they are.
        if (!repositoryUrl || repositoryUrl.startsWith('git@')) {
            return repositoryUrl;
        }

        const url = new URL(repositoryUrl);

        // Construct clean URL with protocol, host and pathname (if not root)
        const cleanPath = url.pathname === '/' ? '' : url.pathname;
        const protocol = url.protocol ? `${url.protocol}//` : '';
        return `${protocol}${url.host}${cleanPath}`;
    } catch {
        return repositoryUrl;
    }
};

let index = 0;
export const getUniqueId = () => `${Date.now()}.${performance.now()}.${++index}`;
