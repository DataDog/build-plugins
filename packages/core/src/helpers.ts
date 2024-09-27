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
    return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
        seconds ? `${seconds}s ` : ''
    }${milliseconds}ms`.trim();
};

export const getResolvedPath = (filepath: string) => {
    try {
        return require.resolve(filepath);
    } catch (e) {
        return filepath;
    }
};

