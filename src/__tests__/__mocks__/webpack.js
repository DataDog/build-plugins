// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const webpack = jest.requireActual('webpack');

let version = '4';

module.exports = webpack;
module.exports.mockSetVersion = (newVersion) => {
    version = newVersion;
};
module.exports.version = version;
