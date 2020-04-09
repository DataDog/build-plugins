// Unless explicitly stated otherwise all files in this repository are licensed
// under the Apache License Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

exports.getMetric = (metric, opts) => ({
    type: 'gauge',
    tags: [...metric.tags, ...opts.tags],
    metric: `${opts.prefix ? `${opts.prefix}.` : ''}${metric.metric}`,
    points: [[opts.timestamp, metric.value]]
});
