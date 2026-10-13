// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// circular_project/identity-source-map-loader.cjs

// Stand-in for the loader producing a source map (swc, babel, ts...) that runs
// before the Datadog plugins in real webpack and rspack builds. Without an
// input source map, unplugin drops the source maps of their transforms.
module.exports = function identitySourceMapLoader(source) {
    const lines = source.split('\n');
    const mappings = lines.map((_, index) => (index === 0 ? 'AAAA' : 'AACA')).join(';');
    this.callback(null, source, {
        version: 3,
        sources: [this.resourcePath],
        sourcesContent: [source],
        names: [],
        mappings,
    });
};
