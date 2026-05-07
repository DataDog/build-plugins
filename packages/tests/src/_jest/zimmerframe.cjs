const Module = require('node:module');
const path = require('node:path');

// zimmerframe is ESM-only. The production build can import it directly, but this
// Jest package still executes transformed TypeScript through CommonJS.
module.exports = Module._load(
    path.join(__dirname, '../../../../node_modules/zimmerframe/src/walk.js'),
    module,
    false,
);
