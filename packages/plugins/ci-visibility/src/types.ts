// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    GIT_COMMIT_AUTHOR_EMAIL,
    GIT_COMMIT_AUTHOR_NAME,
    GIT_COMMIT_AUTHOR_DATE,
    GIT_COMMIT_MESSAGE,
    GIT_COMMIT_COMMITTER_DATE,
    GIT_COMMIT_COMMITTER_EMAIL,
    GIT_COMMIT_COMMITTER_NAME,
    CI_ENV_VARS,
    CI_NODE_NAME,
    CI_NODE_LABELS,
    GIT_BASE_REF,
    GIT_HEAD_SHA,
    GIT_PULL_REQUEST_BASE_BRANCH,
    GIT_PULL_REQUEST_BASE_BRANCH_SHA,
    SUPPORTED_PROVIDERS,
    GIT_TAG,
    CI_JOB_NAME,
    CI_JOB_URL,
    CI_PIPELINE_ID,
    CI_PIPELINE_NAME,
    CI_PIPELINE_NUMBER,
    CI_PIPELINE_URL,
    CI_PROVIDER_NAME,
    CI_STAGE_NAME,
    CI_WORKSPACE_PATH,
    GIT_BRANCH,
    GIT_REPOSITORY_URL,
    GIT_SHA,
    BUILD_PLUGIN_VERSION,
    BUILD_PLUGIN_ENV,
    BUILD_BUNDLER_NAME,
    BUILD_BUNDLER_VERSION,
} from './constants';

export type CiVisibilityOptions = {
    disabled?: boolean;
};

export interface CustomSpanPayload {
    ci_provider: string;
    span_id: string;
    command: string;
    name: string;
    start_time: string;
    end_time: string;
    error_message: string;
    exit_code: number;
    tags: SpanTags;
    measures: Partial<Record<string, number>>;
}

export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

export type SpanTag =
    | typeof CI_ENV_VARS
    | typeof CI_JOB_NAME
    | typeof CI_JOB_URL
    | typeof CI_NODE_LABELS
    | typeof CI_NODE_NAME
    | typeof CI_PIPELINE_ID
    | typeof CI_PIPELINE_NAME
    | typeof CI_PIPELINE_NUMBER
    | typeof CI_PIPELINE_URL
    | typeof CI_PROVIDER_NAME
    | typeof CI_STAGE_NAME
    | typeof CI_WORKSPACE_PATH
    | typeof GIT_BASE_REF
    | typeof GIT_BRANCH
    | typeof GIT_COMMIT_AUTHOR_DATE
    | typeof GIT_COMMIT_AUTHOR_EMAIL
    | typeof GIT_COMMIT_AUTHOR_NAME
    | typeof GIT_COMMIT_COMMITTER_DATE
    | typeof GIT_COMMIT_COMMITTER_EMAIL
    | typeof GIT_COMMIT_COMMITTER_NAME
    | typeof GIT_COMMIT_MESSAGE
    | typeof GIT_HEAD_SHA
    | typeof GIT_PULL_REQUEST_BASE_BRANCH
    | typeof GIT_PULL_REQUEST_BASE_BRANCH_SHA
    | typeof GIT_REPOSITORY_URL
    | typeof GIT_SHA
    | typeof GIT_TAG
    | typeof BUILD_PLUGIN_VERSION
    | typeof BUILD_PLUGIN_ENV
    | typeof BUILD_BUNDLER_NAME
    | typeof BUILD_BUNDLER_VERSION;

export type SpanTags = Partial<Record<SpanTag, string>>;

export type CiVisibilityOptionsWithDefaults = Required<CiVisibilityOptions>;
