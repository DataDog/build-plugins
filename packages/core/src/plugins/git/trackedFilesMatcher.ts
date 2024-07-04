// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';

// TrackedFilesMatcher can compute the list of tracked files related to a particular sourcemap.
// The current implementation simply returns all tracked files whose filename is found inside
// the sourcemap 'sources' field.
// It is used so that we don't send every tracked files to the backend since most won't be of any use
// for a particular sourcemap.
export class TrackedFilesMatcher {
    // A map with tracked filenames as key and the related tracked file paths as value.
    private trackedFilenames: Map<string, string[]>;

    constructor(trackedFiles: string[]) {
        this.trackedFilenames = new Map<string, string[]>();
        for (const f of trackedFiles) {
            const filename = this.getFilename(f);
            const list = this.trackedFilenames.get(filename);
            if (list) {
                list.push(f);
            } else {
                this.trackedFilenames.set(filename, new Array<string>(f));
            }
        }
    }

    // Looks up the sources declared in the sourcemap and return a list of related tracked files.
    public matchSourcemap(
        srcmapPath: string,
        onSourcesNotFound: (reason: string) => void,
    ): string[] | undefined {
        const buff = fs.readFileSync(srcmapPath, 'utf8');
        const srcmapObj = JSON.parse(buff);
        if (!srcmapObj.sources) {
            onSourcesNotFound(`Missing 'sources' field in sourcemap.`);
            return undefined;
        }
        const sources = srcmapObj.sources as string[];
        if (sources.length === 0) {
            onSourcesNotFound(`Empty 'sources' field in sourcemap.`);
            return undefined;
        }
        const filtered = this.matchSources(sources);
        if (filtered.length === 0) {
            onSourcesNotFound(`Sources not in the tracked files.`);
            return undefined;
        }

        return filtered;
    }

    public matchSources(sources: string[]): string[] {
        let filtered: string[] = [];
        const filenameAlreadyMatched = new Set<string>();
        for (const source of sources) {
            const filename = this.getFilename(source);
            if (filenameAlreadyMatched.has(filename)) {
                continue;
            }
            filenameAlreadyMatched.add(filename);
            const trackedFiles = this.trackedFilenames.get(filename);
            if (trackedFiles) {
                filtered = filtered.concat(trackedFiles);
            }
        }

        return filtered;
    }

    // Return a list of all tracked files
    public rawTrackedFilesList() {
        let rawList: string[] = [];
        this.trackedFilenames.forEach((value) => {
            rawList = rawList.concat(value);
        });

        return rawList;
    }

    // Extract the filename from a path.
    //
    // We are removing any suffix that is after the character '?'. The only reason this is done
    // is because we noticed that a non-negligible (~5%) amount of source paths from our customers
    // source maps contained query parameters.
    // We are assuming that the files may not actually be named with the interrogation mark but that
    // it is only an artifact of the build process. The query parameters look random. It looks
    // like it may be used as a trick to force a web browser to reload the file content.
    // The only side effect of doing that operation is that more tracked files paths may be sent
    // alongside the sourcemap which is not a problem.
    // Example: webpack:///./src/folder/ui/select.vue?821e
    private getFilename(s: string): string {
        let start = s.lastIndexOf('/');
        if (start === -1) {
            start = 0;
        } else {
            start++;
        }
        let end = s.lastIndexOf('?');
        if (end === -1 || end <= start) {
            end = s.length;
        }

        return s.substring(start, end);
    }
}
