// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A `--testSequencer` for spawned fixture runs whose files must run in a fixed order. Plain
// JavaScript because Jest loads it without transforming it.
class PathOrderSequencer {
    sort(tests) {
        return [...tests].sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    cacheResults() {}
}

module.exports = PathOrderSequencer;
