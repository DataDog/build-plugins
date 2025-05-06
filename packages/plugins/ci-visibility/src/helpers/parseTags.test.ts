import { BUILD_PLUGIN_SPAN_PREFIX } from '../constants';

import { parseTags } from './parseTags';

const testCases = [
    {
        description: 'return an empty object when no tags are provided',
        input: { spanTags: {}, tags: [] },
        expected: {},
    },
    {
        description: 'add prefix to tags without it',
        input: { spanTags: {}, tags: ['tag:value'] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value' },
    },
    {
        description: 'not add prefix to tags that already have it',
        input: { spanTags: {}, tags: [`${BUILD_PLUGIN_SPAN_PREFIX}.tag:value`] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value' },
    },
    {
        description: 'merge values for the same tag',
        input: { spanTags: {}, tags: ['tag:value1', 'tag:value2'] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value1,value2' },
    },
    {
        description: 'deduplicate values for the same tag',
        input: { spanTags: {}, tags: ['tag:value', 'tag:value'] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value' },
    },
    {
        description: 'handle tags with multiple colons in value',
        input: { spanTags: {}, tags: ['tag:value:with:colons'] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value:with:colons' },
    },
    {
        description: 'preserve existing tags from spanTags',
        input: {
            spanTags: { existing: 'existingValue' },
            tags: ['tag:value'],
        },
        expected: {
            existing: 'existingValue',
            [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value',
        },
    },
    {
        description: 'merge new tag values with existing tag values',
        input: {
            spanTags: { tag: 'existingValue' },
            tags: ['tag:newValue'],
        },
        expected: { tag: 'existingValue,newValue' },
    },
    {
        description: 'handle tags with spaces around the separator',
        input: { spanTags: {}, tags: ['tag : value'] },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value' },
    },
    {
        description: 'skip empty values when converting sets to string',
        input: { spanTags: { [`${BUILD_PLUGIN_SPAN_PREFIX}.empty`]: '' }, tags: [] },
        expected: {},
    },
    {
        description: 'parse comma-separated values in existing tags',
        input: {
            spanTags: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value1,value2' },
            tags: ['tag:value3'],
        },
        expected: { [`${BUILD_PLUGIN_SPAN_PREFIX}.tag`]: 'value1,value2,value3' },
    },
];

describe('parseTags', () => {
    test.each(testCases)('Should $description', ({ input, expected }) => {
        const result = parseTags(input.spanTags, input.tags);
        expect(result).toEqual(expected);
    });
});
