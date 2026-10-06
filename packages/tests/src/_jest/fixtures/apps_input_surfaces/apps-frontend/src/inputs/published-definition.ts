// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type InputDefinition = {
    identifier: string;
    surfaces: readonly string[];
};

const publishedInputs = new WeakSet<object>();
const buildMarkers = new WeakMap<object, string>();

// Side effects keep bundlers from dropping a consumer unless its call is PURE-annotated.
export function createDatadogAppInputConsumer(definition: InputDefinition): InputDefinition {
    const consumer = Object.freeze({ ...definition });
    publishedInputs.add(consumer);
    return consumer;
}

// Must use `marker`: Rollup tree-shakes arguments a callee ignores, which would drop the marker
// from a used consumer.
export function withInputBuildMarker<T extends object>(input: T, marker: string): T {
    buildMarkers.set(input, marker);
    return input;
}

export function isPublishedInput(value: object): boolean {
    return publishedInputs.has(value);
}
