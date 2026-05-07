const vite = require('../../../../node_modules/vite/index.cjs');
const { parseAst, parseAstAsync } = require('rollup/parseAst');

module.exports = new Proxy(vite, {
    get(target, prop, receiver) {
        if (prop === 'parseAst') {
            return parseAst;
        }
        if (prop === 'parseAstAsync') {
            return parseAstAsync;
        }
        return Reflect.get(target, prop, receiver);
    },
});
