module.exports = {
    '*.{ts,tsx}': () => ['yarn typecheck', 'yarn format', 'git add'],
    relative: 'true',
};
