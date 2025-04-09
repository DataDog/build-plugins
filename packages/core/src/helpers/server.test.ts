// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type http from 'http';
import { vol } from 'memfs';
import nock from 'nock';

import { prepareFile, runServer } from './server';

// Use mock files.
jest.mock('fs', () => require('memfs').fs);
jest.mock('fs/promises', () => require('memfs').fs.promises);

const PORT = 3000;

describe('Server', () => {
    describe('prepareFile', () => {
        beforeAll(() => {
            vol.fromJSON(
                {
                    '/system/sensitive.txt': 'sensitive data',
                    '/root/index.html': '<html>Hello World</html>',
                    '/root/styles.css': 'body { color: red; }',
                },
                '/',
            );
        });

        afterAll(() => {
            vol.reset();
        });

        test('Should return the correct file.', async () => {
            const file = await prepareFile('/root', '/styles.css');
            expect(file.found).toBe(true);
            expect(file.ext).toBe('css');
            expect(file.content).toBe('body { color: red; }');
        });

        test('Should handle missing files.', async () => {
            const file = await prepareFile('/root', '/nonexistent.txt');
            expect(file.found).toBe(false);
            expect(file.content).toBe('');
        });

        test('Should append index.html when path ends with /', async () => {
            const file = await prepareFile('/root', '/');
            expect(file.found).toBe(true);
            expect(file.ext).toBe('html');
            expect(file.content).toBe('<html>Hello World</html>');
        });

        test('Should prevent path traversal attacks', async () => {
            const file = await prepareFile('/root', '/../system/sensitive.txt');
            expect(file.found).toBe(false);
        });
    });

    describe('runServer', () => {
        let server: http.Server;

        beforeAll(() => {
            // Allow local server.
            nock.enableNetConnect('127.0.0.1');

            // Add one file.
            vol.fromJSON({
                '/root/index.html': '<html>Hello World</html>',
            });
        });

        afterAll(() => {
            vol.reset();
            nock.cleanAll();
            nock.disableNetConnect();
        });

        afterEach(() => {
            if (!server) {
                return;
            }

            server.close();
            server.closeAllConnections();
            server.closeIdleConnections();
        });

        test('Should start the server', async () => {
            server = runServer({
                port: PORT,
                root: '/root',
            });
            expect(server).toBeDefined();
            expect(server.listening).toBe(true);
        });

        test('Should handle routes', async () => {
            const getHandler = jest.fn((req, res) => {
                res.end('Hello World');
            });

            const routes = {
                '/route': {
                    get: getHandler,
                },
            };

            server = runServer({
                port: PORT,
                root: '/root',
                routes,
            });

            const response = await fetch(`http://127.0.0.1:${PORT}/route`);
            expect(response.ok).toBe(true);
            expect(await response.text()).toBe('Hello World');
            expect(getHandler).toHaveBeenCalled();
        });

        test("Should fallback to files when routes doesn't hit", async () => {
            const routes = {
                '/route': {
                    get: jest.fn(),
                },
            };

            server = runServer({
                port: PORT,
                root: '/root',
                routes,
            });

            const response = await fetch(`http://127.0.0.1:${PORT}/`);
            expect(response.ok).toBe(true);
            expect(await response.text()).toBe('<html>Hello World</html>');
        });

        test('Should use middleware', async () => {
            const middleware = jest.fn((response) => {
                return {
                    statusCode: 201,
                    headers: {
                        'Content-Type': 'text/plain',
                    },
                    body: `Content was: ${response.body}`,
                };
            });

            server = runServer({
                port: PORT,
                root: '/root',
                middleware,
            });

            const response = await fetch(`http://127.0.0.1:${PORT}/`);
            expect(response.ok).toBe(true);
            expect(response.status).toBe(201);
            expect(response.headers.get('Content-Type')).toBe('text/plain');
            expect(await response.text()).toBe('Content was: <html>Hello World</html>');
            expect(middleware).toHaveBeenCalled();
        });
    });
});
