// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AlertOptions, CanaryReport, FailureKind } from './types';

// Slack mrkdwn, posted as is by the CI notify job.
const TITLE = ':red_circle: *Live Debugger build canary failed*';
const SHORT_COMMIT_LENGTH = 8;

const KIND_DESCRIPTIONS: Record<FailureKind, string> = {
    plugin: 'the control build passed but an instrumented build failed, so Live Debugger is the suspect.',
    target: "the target, its setup or its control build failed, so Live Debugger wasn't evaluated.",
    interrupted: 'the run was stopped before it finished.',
};

const formatCommit = (commit: string): string => {
    return `\`${commit.slice(0, SHORT_COMMIT_LENGTH)}\``;
};

const formatLinks = (links: AlertOptions['links']): string[] => {
    const formatted = [];
    if (links.job) {
        formatted.push(`<${links.job}|Job log and artifacts>`);
    }
    if (links.pipeline) {
        formatted.push(`<${links.pipeline}|Pipeline>`);
    }
    return formatted.length > 0 ? [formatted.join(' · ')] : [];
};

export const formatRunAlert = (report: CanaryReport, links: AlertOptions['links']): string => {
    const kind = report.failureKind ?? 'target';
    const failure = report.failures[0];
    const lines = [
        `${TITLE}: \`${report.target}\`, phase \`${report.phaseSelection}\``,
        `*Kind:* ${kind}: ${KIND_DESCRIPTIONS[kind]}`,
    ];
    if (failure) {
        lines.push(`*Stage:* \`${failure.stage}\``, `*Error:* ${failure.message}`);
    }
    const buildPluginsCommit = formatCommit(report.repositories.buildPlugins.commit);
    const targetCommit = formatCommit(report.repositories.target.commit);
    lines.push(`*Commits:* build-plugins ${buildPluginsCommit}, ${report.target} ${targetCommit}`);
    const linkLines = formatLinks(links);
    lines.push(...linkLines);
    return `${lines.join('\n')}\n`;
};

export const formatCheckoutAlert = ({
    links,
    message,
    ref,
    repository,
    target,
}: {
    links: AlertOptions['links'];
    message: string;
    ref: string;
    repository: string;
    target: string;
}): string => {
    const lines = [
        `${TITLE}: \`${target}\``,
        `*Kind:* target: checking out ${repository} ${ref} or resolving its toolchain failed, so nothing was built.`,
        `*Error:* ${message}`,
    ];
    const linkLines = formatLinks(links);
    lines.push(...linkLines);
    return `${lines.join('\n')}\n`;
};
