/**
 * CJS shim for @rspack/core v2 (which is pure ESM).
 *
 * @rspack/core v2 is a pure ESM package. Jest's CJS module runtime cannot
 * require() it directly when --experimental-vm-modules is active (because
 * shouldLoadAsEsm() returns true for packages with "type":"module", causing
 * Jest to throw ERR_REQUIRE_ESM before reaching its transformer).
 *
 * This shim is resolved by the Jest custom resolver (rspack-jest-resolver.cjs)
 * for any require('@rspack/core') call. It re-exports rspack using Node's
 * createRequire(), which bypasses Jest's module interception entirely and
 * uses Node's native loader that supports require(esm) in Node >=20.17.
 *
 * The shim file uses the .cjs extension so that shouldLoadAsEsm() returns
 * false unconditionally, bypassing the ESM guard in Jest's requireModule().
 */

const { createRequire } = require('module');

// Create a require function anchored to this file's location.
// Unlike module.require (which Jest patches), createRequire() returns Node's
// native loader function, allowing it to load ESM packages via require(esm).
const nativeRequire = createRequire(__filename);
const rspack = nativeRequire('@rspack/core');

module.exports = rspack;
