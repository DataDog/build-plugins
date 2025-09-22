// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Return the environment variable that would be prefixed with either DATADOG_ or DD_.
export const getDDEnvValue = (key: string) => {
    return process.env[`DATADOG_${key}`] || process.env[`DD_${key}`];
};
