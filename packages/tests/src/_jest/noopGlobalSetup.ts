// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A `--globalSetup` override for spawned single-fixture Jest runs that don't touch the fixtures
// directory and so don't need globalSetup.ts's real `yarn install` + git init/config cost.
const noopGlobalSetup = () => {};

export default noopGlobalSetup;
