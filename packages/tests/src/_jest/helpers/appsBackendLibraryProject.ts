// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';

const fsp = fs.promises;

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'apps_backend_library_project');
const ACTION_CATALOG_DIR = path.join(FIXTURES_DIR, 'action_catalog_project');

/** How the app gets `@fixtures/viz-lib`, the package that opts in to providing backend functions. */
export type BackendLibraryLayout = 'installed' | 'linked';

/**
 * Assembles the `apps_backend_library_project` app in a temp dir, with a real `node_modules`
 * layout. `installed` copies every package into `node_modules`, as npm or a tarball install would.
 * `linked` symlinks the viz library from its own checkout, which has its own development copy of
 * `@datadog/action-catalog` (as `npm link` or a `file:` dependency would). In both, the non-opted
 * `linked-plain-backend-lib` is symlinked from a checkout beside the app.
 */
export async function assembleBackendLibraryApp(
    layout: BackendLibraryLayout,
): Promise<{ appRoot: string; cleanup: () => Promise<void> }> {
    const tempPrefix = path.join(os.tmpdir(), 'dd-apps-library-');
    const tempDir = fs.realpathSync(await fsp.mkdtemp(tempPrefix));
    const appRoot = path.join(tempDir, 'app');
    const copy = (from: string, to: string) => fsp.cp(from, to, { recursive: true });
    const install = (from: string, name: string) =>
        copy(from, path.join(appRoot, 'node_modules', name));

    await copy(path.join(PROJECT_DIR, 'app'), appRoot);
    await install(ACTION_CATALOG_DIR, '@datadog/action-catalog');
    await install(path.join(PROJECT_DIR, 'packages/plain-lib'), 'plain-backend-lib');
    await install(path.join(PROJECT_DIR, 'packages/banned-lib'), '@fixtures/banned-lib');
    await install(path.join(PROJECT_DIR, 'packages/hooks-lib'), '@fixtures/hooks-lib');
    await install(path.join(PROJECT_DIR, 'packages/viz-lib'), 'viz-alias');

    const link = async (checkout: string, name: string) => {
        const linkPath = path.join(appRoot, 'node_modules', name);
        await fsp.mkdir(path.dirname(linkPath), { recursive: true });
        await fsp.symlink(checkout, linkPath, 'dir');
    };
    const linkedPlainCheckout = path.join(tempDir, 'linked-plain-lib');
    await copy(path.join(PROJECT_DIR, 'packages/linked-plain-lib'), linkedPlainCheckout);
    await link(linkedPlainCheckout, 'linked-plain-backend-lib');

    const vizLibSource = path.join(PROJECT_DIR, 'packages/viz-lib');
    if (layout === 'installed') {
        await install(vizLibSource, '@fixtures/viz-lib');
    } else {
        const checkout = path.join(tempDir, 'viz-lib');
        await copy(vizLibSource, checkout);
        await copy(ACTION_CATALOG_DIR, path.join(checkout, 'node_modules/@datadog/action-catalog'));
        await link(checkout, '@fixtures/viz-lib');
    }

    return { appRoot, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
}
