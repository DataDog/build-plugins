exports.getMetric = (metric, opts) => ({
    type: 'gauge',
    tags: [...metric.tags, ...opts.defaultTags],
    metric: `${opts.prefix ? `${opts.prefix}.` : ''}${metric.metric}`,
    points: [[opts.timestamp, metric.value]]
});
