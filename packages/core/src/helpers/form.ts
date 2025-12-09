// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Readable } from 'stream';
import { createGzip } from 'zlib';
import type { Gzip } from 'zlib';

export type GzipFormData = {
    data: Gzip;
    headers: Record<string, string>;
};

export type FormBuilder = (form: FormData) => Promise<void> | void;

export const createGzipFormData = async (
    builder: FormBuilder,
    defaultHeaders: Record<string, string> = {},
): Promise<GzipFormData> => {
    const form = new FormData();
    await builder(form);

    const gz = createGzip();
    // Serialize FormData through Request to get a streaming body and auto-generated headers
    // (boundary) that we can forward while piping through gzip.
    const req = new Request('fake://url', { method: 'POST', body: form });
    const formStream = Readable.fromWeb(req.body!);
    const data = formStream.pipe(gz);

    const headers = {
        'Content-Encoding': 'gzip',
        ...defaultHeaders,
        ...Object.fromEntries(req.headers.entries()),
    };

    return { data, headers };
};
