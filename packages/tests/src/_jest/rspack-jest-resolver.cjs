/**
 * Custom Jest resolver that maps @rspack/core to a CJS-compatible shim.
 *
 * @rspack/core v2 is a pure ESM package. Jest's CJS module runtime cannot
 * require() it directly when --experimental-vm-modules is active (because
 * shouldLoadAsEsm() returns true for packages with "type":"module", causing
 * Jest to throw ERR_REQUIRE_ESM before reaching its transformer).
 *
 * This resolver intercepts require('@rspack/core') and returns the path to
 * rspack-cjs-shim.cjs instead. The .cjs extension makes shouldLoadAsEsm()
 * return false unconditionally, allowing Jest to load the module normally.
 * The shim itself uses Node's native Module._load to load the real rspack
 * (Node >=20.17 supports require(esm) natively).
 */

const path = require('path');

module.exports = (request, options) => {
    if (request === '@rspack/core') {
        return path.resolve(__dirname, 'rspack-cjs-shim.cjs');
    }
    return options.defaultResolver(request, options);
};
