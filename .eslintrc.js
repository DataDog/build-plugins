const extensions = ['.json', '.ts', '.js', '.md'];
// Test runs start with CI secrets in their env, so a whole-env copy can carry any the setup scrub
// misses into failure output.
const PROCESS_ENV_IN_TESTS_MESSAGE =
    "Don't use process.env as a whole value in tests (reassign, replace, alias, spread, pass, or assert on it). Read, set, or delete single keys, write keys with an `Object.assign(process.env, { ... });` statement, check for one with `'KEY' in process.env`, list names with Object.keys(process.env), reset Datadog keys with clearDatadogEnv() from @dd/tests/_jest/helpers/datadogEnv, and give child processes an env built from only the keys they need.";
const envStringKey = (path) =>
    `[${path}.value='env'], [${path}.type='TemplateLiteral'][${path}.expressions.length=0][${path}.quasis.0.value.cooked='env']`;
// A computed identifier is a variable holding some other key, so only a plain name counts.
const matchesEnvKey = (path) =>
    `:matches([computed=false][${path}.name='env'], ${envStringKey(path)})`;
const matchesEnvString = (path) => `:matches(${envStringKey(path)})`;
const matchesProcess = (path) =>
    `:matches([${path}.name='process'], [${path}.type='MemberExpression'][${path}.object.name=/^(global|globalThis)$/][${path}.property.name='process'], [${path}.type='CallExpression'][${path}.callee.name='require'][${path}.arguments.0.value=/^(node:)?process$/])`;
const KEY_CHECK_CALLEE =
    '[callee.object.name=/^(Object|Reflect)$/][callee.property.name=/^(hasOwn|has)$/]';
const isEnvArgument = (callee) =>
    `CallExpression${callee} > MemberExpression.arguments:first-child`;
// Consumers that only read, write, or check single keys or names of process.env.
const SINGLE_KEY_ENV_USES = [
    'MemberExpression > MemberExpression.object',
    'MemberExpression > TSNonNullExpression.object > MemberExpression.expression',
    'MemberExpression > TSAsExpression.object > MemberExpression.expression',
    "BinaryExpression[operator='in'] > MemberExpression.right",
    'ForInStatement > MemberExpression.right',
    isEnvArgument("[callee.object.name='Object'][callee.property.name='keys']"),
    isEnvArgument(KEY_CHECK_CALLEE),
    isEnvArgument("[callee.property.name='call'][callee.object.property.name='hasOwnProperty']"),
    isEnvArgument("[callee.object.name='jest'][callee.property.name='replaceProperty']"),
    `ExpressionStatement > ${isEnvArgument("[callee.object.name='Object'][callee.property.name='assign']")}`,
    "VariableDeclarator[id.type='ObjectPattern']:not(:has(RestElement)) > MemberExpression.init",
    "ExpressionStatement > AssignmentExpression[left.type='ObjectPattern']:not(:has(RestElement)) > MemberExpression.right",
    "AssignmentPattern[left.type='ObjectPattern']:not(:has(RestElement)) > MemberExpression.right",
];
const singleKeyEnvUse = SINGLE_KEY_ENV_USES.map((use) => `:not(${use})`).join('');
module.exports = {
    root: true,
    rules: {
        'block-scoped-var': 'error',
        curly: ['error', 'all'],
        eqeqeq: [
            'error',
            'always',
            {
                null: 'ignore',
            },
        ],
        'guard-for-in': 'error',
        'no-alert': 'warn',
        'no-caller': 'error',
        'no-case-declarations': 'error',
        'no-empty-function': [
            'error',
            {
                allow: ['arrowFunctions', 'functions', 'methods'],
            },
        ],
        'no-empty-pattern': 'error',
        'no-eval': 'error',
        'no-extend-native': 'error',
        'no-extra-bind': 'error',
        'no-extra-label': 'error',
        'no-fallthrough': 'error',
        'no-global-assign': [
            'error',
            {
                exceptions: [],
            },
        ],
        'no-implied-eval': 'error',
        'no-iterator': 'error',
        'no-labels': [
            'error',
            {
                allowLoop: false,
                allowSwitch: false,
            },
        ],
        'no-lone-blocks': 'error',
        'no-loop-func': 'error',
        'no-multi-str': 'error',
        'no-new': 'error',
        'no-new-func': 'error',
        'no-new-wrappers': 'error',
        'no-octal': 'error',
        'no-octal-escape': 'error',
        'no-param-reassign': [
            'error',
            {
                props: false,
            },
        ],
        'no-proto': 'error',
        'no-redeclare': 'error',
        'no-restricted-properties': [
            'error',
            {
                object: 'arguments',
                property: 'callee',
                message: 'arguments.callee is deprecated',
            },
            {
                object: 'global',
                property: 'isFinite',
                message: 'Please use Number.isFinite instead',
            },
            {
                object: 'self',
                property: 'isFinite',
                message: 'Please use Number.isFinite instead',
            },
            {
                object: 'window',
                property: 'isFinite',
                message: 'Please use Number.isFinite instead',
            },
            {
                object: 'global',
                property: 'isNaN',
                message: 'Please use Number.isNaN instead',
            },
            {
                object: 'self',
                property: 'isNaN',
                message: 'Please use Number.isNaN instead',
            },
            {
                object: 'window',
                property: 'isNaN',
                message: 'Please use Number.isNaN instead',
            },
            {
                property: '__defineGetter__',
                message: 'Please use Object.defineProperty instead.',
            },
            {
                property: '__defineSetter__',
                message: 'Please use Object.defineProperty instead.',
            },
            {
                object: 'Math',
                property: 'pow',
                message: 'Use the exponentiation operator (**) instead.',
            },
        ],
        'no-return-assign': ['error', 'always'],
        'no-return-await': 'error',
        'no-script-url': 'error',
        'no-self-assign': [
            'error',
            {
                props: true,
            },
        ],
        'no-self-compare': 'error',
        'no-sequences': 'error',
        'no-throw-literal': 'error',
        'no-unused-expressions': [
            'error',
            {
                allowShortCircuit: false,
                allowTernary: false,
                allowTaggedTemplates: false,
            },
        ],
        'no-unused-labels': 'error',
        'no-useless-catch': 'error',
        'no-useless-concat': 'error',
        'no-useless-escape': 'error',
        'no-useless-return': 'error',
        'no-void': 'error',
        'no-with': 'error',
        'vars-on-top': 'error',
        yoda: 'error',
        'for-direction': 'error',
        'getter-return': [
            'error',
            {
                allowImplicit: true,
            },
        ],
        'no-async-promise-executor': 'error',
        'no-await-in-loop': 'warn',
        'no-compare-neg-zero': 'error',
        'no-cond-assign': ['error', 'always'],
        'no-constant-condition': 'warn',
        'no-control-regex': 'error',
        'no-debugger': 'error',
        'no-dupe-args': 'error',
        'no-dupe-keys': 'error',
        'no-duplicate-case': 'error',
        'no-empty': 'error',
        'no-empty-character-class': 'error',
        'no-ex-assign': 'error',
        'no-extra-boolean-cast': 'error',
        'no-func-assign': 'error',
        'no-inner-declarations': 'error',
        'no-invalid-regexp': 'error',
        'no-irregular-whitespace': 'error',
        'no-misleading-character-class': 'error',
        'no-obj-calls': 'error',
        'no-prototype-builtins': 'error',
        'no-regex-spaces': 'error',
        'no-sparse-arrays': 'error',
        'no-template-curly-in-string': 'error',
        'no-unreachable': 'error',
        'no-unsafe-finally': 'error',
        'no-unsafe-negation': 'error',
        'use-isnan': 'error',
        'valid-typeof': [
            'error',
            {
                requireStringLiterals: true,
            },
        ],
        'global-require': 'error',
        'no-buffer-constructor': 'error',
        'no-new-require': 'error',
        'no-path-concat': 'error',
        'func-names': 'warn',
        'lines-around-directive': [
            'error',
            {
                before: 'always',
                after: 'always',
            },
        ],
        'no-array-constructor': 'error',
        'no-bitwise': 'error',
        'no-lonely-if': 'error',
        'no-multi-assign': ['error'],
        'no-new-object': 'error',
        'no-underscore-dangle': [
            'error',
            {
                allowAfterThis: true,
                allowAfterSuper: false,
                enforceInMethodNames: false,
                allow: ['_chunks'],
            },
        ],
        'no-unneeded-ternary': [
            'error',
            {
                defaultAssignment: false,
            },
        ],
        'one-var': ['error', 'never'],
        'operator-assignment': ['error', 'always'],
        'spaced-comment': [
            'error',
            'always',
            {
                line: {
                    exceptions: ['-', '+'],
                    markers: ['=', '!'],
                },
                block: {
                    exceptions: ['-', '+'],
                    markers: ['=', '!', ':', '::'],
                    balanced: true,
                },
            },
        ],
        'no-delete-var': 'error',
        'no-label-var': 'error',
        'no-shadow': 'off',
        '@typescript-eslint/no-shadow': ['error'],
        'no-shadow-restricted-names': 'error',
        'no-undef': 'error',
        'no-undef-init': 'error',
        'constructor-super': 'error',
        'no-class-assign': 'error',
        'no-const-assign': 'error',
        'no-dupe-class-members': 'error',
        'no-new-symbol': 'error',
        'no-this-before-super': 'error',
        'no-useless-computed-key': 'error',
        'no-useless-rename': [
            'error',
            {
                ignoreDestructuring: false,
                ignoreImport: false,
                ignoreExport: false,
            },
        ],
        'no-var': 'error',
        'object-shorthand': ['warn', 'always'],
        'prefer-const': [
            'error',
            {
                destructuring: 'any',
                ignoreReadBeforeAssign: true,
            },
        ],
        'prefer-numeric-literals': 'error',
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
        'prefer-template': 'error',
        'require-yield': 'error',
        'symbol-description': 'error',
        'import/no-unresolved': [
            'error',
            {
                commonjs: true,
                caseSensitive: true,
            },
        ],
        'import/export': 'error',
        'import/no-extraneous-dependencies': [
            'error',
            {
                devDependencies: [],
            },
        ],
        'import/no-mutable-exports': 'error',
        'import/no-amd': 'error',
        'import/first': 'error',
        'import/no-duplicates': 'error',
        'import/newline-after-import': 'error',
        'import/no-absolute-path': 'error',
        'import/no-dynamic-require': 'error',
        'import/no-webpack-loader-syntax': 'error',
        'import/no-named-default': 'error',
        'import/no-self-import': 'error',
        'import/no-useless-path-segments': 'error',
        strict: ['error', 'never'],
        '@typescript-eslint/no-unused-vars': [
            'error',
            {
                args: 'none',
                ignoreRestSiblings: true,
            },
        ],
        '@typescript-eslint/consistent-type-imports': [
            'error',
            {
                prefer: 'type-imports',
                fixStyle: 'separate-type-imports',
                disallowTypeAnnotations: false,
            },
        ],
        'arca/import-ordering': ['error', { sections: ['^\\.\\./', '^\\./'] }],
        'arca/newline-after-import-section': ['error', { sections: ['^\\.\\./', '^\\./'] }],
        'prettier/prettier': [
            'error',
            {},
            {
                fileInfoOptions: {
                    ignorePath: '.eslintignore',
                },
            },
        ],
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaFeatures: {
            globalReturn: true,
            generators: false,
            objectLiteralDuplicateProperties: false,
            jsx: true,
        },
        ecmaVersion: 2018,
        sourceType: 'module',
    },
    plugins: ['arca', 'import', 'prettier', '@typescript-eslint'],
    settings: {
        'import/parsers': {
            '@typescript-eslint/parser': ['.ts', '.tsx'],
        },
        'import/extensions': extensions,
        'import/resolver': {
            node: {
                extensions,
            },
            typescript: {
                alwaysTryTypes: true,
                project: ['./tsconfig.json', './packages/*/tsconfig.json'],
            },
        },
        jest: {
            version: require('jest/package.json').version,
        },
    },
    env: {
        node: true,
    },
    overrides: [
        {
            files: ['packages/tests/src/_jest/**/*.*', '**/*.test.ts'],
            plugins: ['jest'],
            extends: ['plugin:jest/recommended'],
            env: {
                jest: true,
                'jest/globals': true,
            },
            rules: {
                'global-require': 'off',
                'import/no-dynamic-require': 'off',
                'import/no-extraneous-dependencies': 'off',
                'no-new': 'off',
                'jest/no-disabled-tests': 'warn',
                'jest/no-focused-tests': 'error',
                'jest/no-identical-title': 'error',
                'jest/prefer-to-have-length': 'warn',
                'jest/valid-expect': 'warn',
            },
        },
        {
            files: [
                'packages/tests/src/_jest/**/*.*',
                'packages/tests/src/_playwright/**/*.*',
                'packages/tests/src/e2e/**/*.*',
                '**/*.test.*',
                '**/*.fixture.*',
                '**/*.fixtures.*',
                '**/*.spec.*',
                '**/*.bench.*',
                'packages/tests/src/bench/**/*.*',
                'packages/plugins/*/scripts/benchmark*.js',
                'packages/tests/jest.config.ts',
                'packages/tests/playwright*.config.ts',
            ],
            // The preflight CLI scripts run in a job without credentials.
            excludedFiles: [
                'packages/tests/src/bench/**/preflight.js',
                'packages/tests/src/bench/**/preflight-build.js',
            ],
            rules: {
                'no-restricted-syntax': [
                    'error',
                    {
                        selector: `MemberExpression${matchesProcess('object')}${matchesEnvKey('property')}${singleKeyEnvUse}`,
                        message: PROCESS_ENV_IN_TESTS_MESSAGE,
                    },
                    {
                        selector: `:matches(VariableDeclarator${matchesProcess('init')} > ObjectPattern.id, AssignmentExpression${matchesProcess('right')} > ObjectPattern.left, AssignmentPattern${matchesProcess('right')} > ObjectPattern.left) > Property${matchesEnvKey('key')}:not(:matches([value.type='ObjectPattern'], [value.left.type='ObjectPattern']):not(:has(RestElement)))`,
                        message: PROCESS_ENV_IN_TESTS_MESSAGE,
                    },
                    {
                        selector: `CallExpression${matchesProcess('arguments.0')}${matchesEnvString('arguments.1')}:not(${KEY_CHECK_CALLEE})`,
                        message: PROCESS_ENV_IN_TESTS_MESSAGE,
                    },
                    {
                        selector:
                            "ImportDeclaration[importKind!='type'][source.value=/^(node:)?process$/] > ImportSpecifier[importKind!='type'][imported.name='env']",
                        message: PROCESS_ENV_IN_TESTS_MESSAGE,
                    },
                ],
            },
        },
        {
            files: ['packages/tests/src/_jest/*.*'],
            rules: {
                'no-restricted-imports': [
                    'error',
                    {
                        patterns: [
                            {
                                group: ['@dd/*', '@datadog/*'],
                                message:
                                    '\nTo avoid any conflict with mocks,\nuse `jest.requireActual` instead.\n',
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ['packages/tools/**/*.*'],
            rules: {
                'global-require': 'off',
                'import/no-dynamic-require': 'off',
                'import/no-extraneous-dependencies': 'off',
                'no-await-in-loop': 'off',
            },
        },
        {
            files: [
                'rollup.config.mjs',
                'packages/core/**/*',
                'packages/published/**/*',
                'packages/plugins/**/built/*',
                'packages/plugins/**/scripts/**/*',
                'packages/tests/src/_jest/**/*',
                'packages/tests/src/_playwright/**/*',
                'packages/tests/src/bench/**/*',
                'packages/tests/src/e2e/**/*',
            ],
            rules: {
                'import/no-extraneous-dependencies': 'off',
            },
        },
        {
            files: ['packages/core/**/*', 'packages/plugins/**/*', 'packages/published/**/*'],
            rules: {
                'no-console': ['error', { allow: ['time', 'timeEnd'] }],
            },
        },
        {
            files: ['packages/core/src/log.ts'],
            rules: {
                'no-console': 'off',
            },
        },
        {
            files: ['.eslintrc.js'],
            rules: {
                'import/no-extraneous-dependencies': 'off',
                'global-require': 'off',
            },
        },
    ],
};
