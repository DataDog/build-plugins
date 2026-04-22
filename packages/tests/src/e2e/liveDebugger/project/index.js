// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */

import {
    add,
    addWithLocal,
    double,
    getObj,
    sideEffect,
    abs,
    earlyExit,
    sign,
    thrower,
} from './patterns.js';

const appState = {
    count: 0,
    chunkLoaded: false,
};

const status = document.getElementById('status');
const count = document.getElementById('count');
const chunkStatus = document.getElementById('chunk-status');
const incrementButton = document.getElementById('increment');
const loadChunkButton = document.getElementById('load_chunk');

const render = () => {
    status.textContent = appState.count === 0 ? 'Ready' : `Clicked ${appState.count} times`;
    count.textContent = String(appState.count);
    chunkStatus.textContent = appState.chunkLoaded ? 'Chunk loaded' : 'Chunk not loaded';
};

function incrementCounter() {
    appState.count += 1;
    render();
}

async function loadChunk() {
    const { markChunkLoaded } = await import('./chunk.js');
    markChunkLoaded(appState);
    render();
}

incrementButton.addEventListener('click', () => {
    incrementCounter();
});

loadChunkButton.addEventListener('click', async () => {
    await loadChunk();
});

render();

function runPatterns() {
    let throwerResult;
    try {
        thrower();
        throwerResult = 'no-error';
    } catch (e) {
        throwerResult = e.message;
    }

    const sideEffectArr = [];
    sideEffect(sideEffectArr, 'ok');

    const results = {
        add: add(2, 3),
        addWithLocal: addWithLocal(2, 3),
        double: double(7),
        getObj: getObj('hello'),
        sideEffect: sideEffectArr[0],
        abs: `${abs(-5)},${abs(3)}`,
        earlyExit: `${earlyExit(0)},${earlyExit(42)}`,
        sign: `${sign(10)},${sign(-10)}`,
        thrower: throwerResult,
    };

    for (const [name, value] of Object.entries(results)) {
        const el = document.getElementById(`pattern-${name}`);
        if (el) {
            el.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }
}

runPatterns();

// Expose pattern functions so the E2E spec can re-invoke them
// after overriding $dd_probes to simulate active probes.
globalThis.ddTestPatterns = {
    add,
    addWithLocal,
    double,
    getObj,
    sideEffect,
    abs,
    earlyExit,
    sign,
    thrower,
};
