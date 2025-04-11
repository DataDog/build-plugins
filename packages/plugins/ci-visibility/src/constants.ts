// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'ciVisibility' as const;
export const PLUGIN_NAME: PluginName = 'datadog-ci-visibility-plugin' as const;

export const CI_ENGINES = {
    APPVEYOR: 'appveyor',
    AWSCODEPIPELINE: 'awscodepipeline',
    AZURE: 'azurepipelines',
    BITBUCKET: 'bitbucket',
    BITRISE: 'bitrise',
    BUDDY: 'buddy',
    BUILDKITE: 'buildkite',
    CIRCLECI: 'circleci',
    CODEFRESH: 'codefresh',
    GITHUB: 'github',
    GITLAB: 'gitlab',
    JENKINS: 'jenkins',
    TRAVIS: 'travisci',
    TEAMCITY: 'teamcity',
};

export const SUPPORTED_PROVIDERS = [
    CI_ENGINES.GITHUB,
    CI_ENGINES.GITLAB,
    CI_ENGINES.JENKINS,
    CI_ENGINES.CIRCLECI,
    CI_ENGINES.AWSCODEPIPELINE,
    CI_ENGINES.AZURE,
    CI_ENGINES.BUILDKITE,
] as const;

// Tags
// For the CI provider.
export const CI_PIPELINE_URL = 'ci.pipeline.url';
export const CI_PROVIDER_NAME = 'ci.provider.name';
export const CI_PIPELINE_ID = 'ci.pipeline.id';
export const CI_PIPELINE_NAME = 'ci.pipeline.name';
export const CI_PIPELINE_NUMBER = 'ci.pipeline.number';
export const CI_WORKSPACE_PATH = 'ci.workspace_path';
export const GIT_REPOSITORY_URL = 'git.repository_url';
export const CI_JOB_URL = 'ci.job.url';
export const CI_JOB_NAME = 'ci.job.name';
export const CI_STAGE_NAME = 'ci.stage.name';
export const CI_NODE_NAME = 'ci.node.name';
export const CI_NODE_LABELS = 'ci.node.labels';
export const CI_ENV_VARS = '_dd.ci.env_vars';

// For Git.
export const GIT_BRANCH = 'git.branch';
export const GIT_COMMIT_AUTHOR_DATE = 'git.commit.author.date';
export const GIT_COMMIT_AUTHOR_EMAIL = 'git.commit.author.email';
export const GIT_COMMIT_AUTHOR_NAME = 'git.commit.author.name';
export const GIT_COMMIT_COMMITTER_DATE = 'git.commit.committer.date';
export const GIT_COMMIT_COMMITTER_EMAIL = 'git.commit.committer.email';
export const GIT_COMMIT_COMMITTER_NAME = 'git.commit.committer.name';
export const GIT_COMMIT_MESSAGE = 'git.commit.message';
export const GIT_SHA = 'git.commit.sha';
export const GIT_TAG = 'git.tag';
export const GIT_HEAD_SHA = 'git.commit.head_sha';
export const GIT_BASE_REF = 'git.commit.base_ref';
export const GIT_PULL_REQUEST_BASE_BRANCH_SHA = 'git.pull_request.base_branch_sha';
export const GIT_PULL_REQUEST_BASE_BRANCH = 'git.pull_request.base_branch';

// For the plugin.
export const BUILD_PLUGIN_VERSION = 'build.plugin.version';
export const BUILD_PLUGIN_ENV = 'build.plugin.env';
export const BUILD_BUNDLER_NAME = 'build.bundler.name';
export const BUILD_BUNDLER_VERSION = 'build.bundler.version';

// Intake
export const INTAKE_HOST = 'app.datadoghq.com';
export const INTAKE_PATH = 'api/intake/ci/custom_spans';
