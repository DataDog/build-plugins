// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    CSP_VIOLATION_LOGGER_SOURCE,
    CSP_VIOLATION_MESSAGE,
    getCspViolationLoggerTags,
} from '@dd/apps-plugin/vite/dev-server-csp-violations';
import { runInNewContext } from 'vm';

type Violation = { effectiveDirective: string; blockedURI: string };

// Runs the logger as the browser would, against a document that only dispatches violations.
const runLogger = () => {
    const document = new EventTarget();
    const warn = jest.fn();
    runInNewContext(CSP_VIOLATION_LOGGER_SOURCE, { document, console: { warn } });
    const dispatch = ({ effectiveDirective, blockedURI }: Violation) => {
        const violation = new Event('securitypolicyviolation');
        const event = Object.assign(violation, {
            effectiveDirective,
            blockedURI,
        });
        document.dispatchEvent(event);
    };
    return { dispatch, warn };
};

describe('dev-server-csp-violations — the violation logger', () => {
    const cases: { description: string; violation: Violation; expected: string[] }[] = [
        {
            description: 'name the directive and the blocked URL',
            violation: { effectiveDirective: 'connect-src', blockedURI: 'http://example.com/' },
            expected: ['connect-src', 'http://example.com/'],
        },
        {
            description: 'name what the browser reports for blocked inline code',
            violation: { effectiveDirective: 'script-src-elem', blockedURI: 'inline' },
            expected: ['script-src-elem', 'inline'],
        },
    ];

    test.each(cases)('Should $description', ({ violation, expected }) => {
        const { dispatch, warn } = runLogger();
        dispatch(violation);

        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        for (const text of expected) {
            expect(message).toContain(text);
        }
    });

    test('Should say the policy would block the URL, with the directive', () => {
        const { dispatch, warn } = runLogger();
        const violation = {
            effectiveDirective: 'connect-src',
            blockedURI: 'http://a.example/$&{url}',
        };
        dispatch(violation);

        const expected = CSP_VIOLATION_MESSAGE.replace(
            '{directive}',
            () => violation.effectiveDirective,
        ).replace('{url}', () => violation.blockedURI);
        expect(warn).toHaveBeenCalledWith(expected);
    });

    test('Should warn once for a violation that repeats', () => {
        const { dispatch, warn } = runLogger();
        const violation = { effectiveDirective: 'img-src', blockedURI: 'https://a.example/x.png' };
        dispatch(violation);
        dispatch(violation);
        dispatch({ effectiveDirective: 'img-src', blockedURI: 'https://b.example/y.png' });

        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe('dev-server-csp-violations — getCspViolationLoggerTags', () => {
    test('Should prepend a classic script, so it listens before the page runs', () => {
        const [tag, ...others] = getCspViolationLoggerTags(true);

        expect(others).toEqual([]);
        expect(tag.tag).toBe('script');
        expect(tag.injectTo).toBe('head-prepend');
        expect(tag.attrs).not.toHaveProperty('type');
        expect(tag.attrs?.src).toMatch(/^\/@id\//);
    });

    test('Should add nothing outside the dev server', () => {
        expect(getCspViolationLoggerTags(false)).toEqual([]);
    });
});
