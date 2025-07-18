// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
const globalAny: any = globalThis;
globalAny.$DD_ALLOW = new Set();

const $DD_ADD_TO_DICTIONARY = (newValues: string[] | TemplateStringsArray) => {
    const initialSize = globalAny.$DD_ALLOW.size;
    if ((newValues as unknown as TemplateStringsArray).raw) {
        // We're being used as a template tag function. The invocation will look like this:
        //   const D = $('foo', $`bar${0}`, 'baz');
        // In this context, our only role is to extract the TemplateStringsArray array so that
        // the top-level call to $ can make use of it. So, we just need to return our first
        // argument.
        return newValues;
    }

    newValues
        .flatMap((value) => {
            if (Array.isArray(value)) {
                return value;
            }
            return value;
        })
        .forEach((value) => {
            globalAny.$DD_ALLOW.add(value);
        });

    if (globalAny.$DD_ALLOW.size !== initialSize) {
        if (globalAny.$DD_ALLOW_OBSERVERS) {
            globalAny.$DD_ALLOW_OBSERVERS.forEach((cb: () => void) => cb());
        }
    }

    return newValues;
};

// Process any queued items and set up the queue mechanism
(() => {
    const queueName = '$DD_A_Q';
    const global = globalThis as any;
    const addToDictionary = $DD_ADD_TO_DICTIONARY;

    // Initialize queue if it doesn't exist
    global[queueName] = global[queueName] || [];

    // Process all existing items in the queue
    global[queueName].forEach(addToDictionary);

    // Clear the queue
    global[queueName].length = 0;

    // Replace push method with our add function
    global[queueName].push = addToDictionary;
})();
