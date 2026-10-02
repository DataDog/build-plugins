// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A `--globalSetup` override for spawned single-fixture Jest runs that need globalSetup.ts's env
// scrub but not its fixture setup, whose `yarn install` would race the parent run's tests.
export { scrubEnv as default } from './helpers/allowedEnv';
