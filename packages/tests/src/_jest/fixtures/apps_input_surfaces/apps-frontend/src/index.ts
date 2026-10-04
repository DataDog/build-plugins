// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A second public entry sharing the input consumers, so a splitting build
// moves them into a shared chunk instead of the schema barrel itself.
export * from './inputs/schemas/index';
export { isPublishedInput } from './inputs/published-definition';
