const extensions = [".json", ".ts", ".tsx", ".jsx", ".js"];
module.exports = {
    "root": true,
    "rules": {
        "block-scoped-var": "error",
        "curly": ["error", "all"],
        "eqeqeq": [
            "error",
            "always",
            {
                "null": "ignore"
            }
        ],
        "guard-for-in": "error",
        "no-alert": "warn",
        "no-caller": "error",
        "no-case-declarations": "error",
        "no-empty-function": [
            "error",
            {
                "allow": ["arrowFunctions", "functions", "methods"]
            }
        ],
        "no-empty-pattern": "error",
        "no-eval": "error",
        "no-extend-native": "error",
        "no-extra-bind": "error",
        "no-extra-label": "error",
        "no-fallthrough": "error",
        "no-global-assign": [
            "error",
            {
                "exceptions": []
            }
        ],
        "no-implied-eval": "error",
        "no-iterator": "error",
        "no-labels": [
            "error",
            {
                "allowLoop": false,
                "allowSwitch": false
            }
        ],
        "no-lone-blocks": "error",
        "no-loop-func": "error",
        "no-multi-str": "error",
        "no-new": "error",
        "no-new-func": "error",
        "no-new-wrappers": "error",
        "no-octal": "error",
        "no-octal-escape": "error",
        "no-param-reassign": [
            "error",
            {
                "props": false
            }
        ],
        "no-proto": "error",
        "no-redeclare": "error",
        "no-restricted-properties": [
            "error",
            {
                "object": "arguments",
                "property": "callee",
                "message": "arguments.callee is deprecated"
            },
            {
                "object": "global",
                "property": "isFinite",
                "message": "Please use Number.isFinite instead"
            },
            {
                "object": "self",
                "property": "isFinite",
                "message": "Please use Number.isFinite instead"
            },
            {
                "object": "window",
                "property": "isFinite",
                "message": "Please use Number.isFinite instead"
            },
            {
                "object": "global",
                "property": "isNaN",
                "message": "Please use Number.isNaN instead"
            },
            {
                "object": "self",
                "property": "isNaN",
                "message": "Please use Number.isNaN instead"
            },
            {
                "object": "window",
                "property": "isNaN",
                "message": "Please use Number.isNaN instead"
            },
            {
                "property": "__defineGetter__",
                "message": "Please use Object.defineProperty instead."
            },
            {
                "property": "__defineSetter__",
                "message": "Please use Object.defineProperty instead."
            },
            {
                "object": "Math",
                "property": "pow",
                "message": "Use the exponentiation operator (**) instead."
            }
        ],
        "no-return-assign": ["error", "always"],
        "no-return-await": "error",
        "no-script-url": "error",
        "no-self-assign": [
            "error",
            {
                "props": true
            }
        ],
        "no-self-compare": "error",
        "no-sequences": "error",
        "no-throw-literal": "error",
        "no-unused-expressions": [
            "error",
            {
                "allowShortCircuit": false,
                "allowTernary": false,
                "allowTaggedTemplates": false
            }
        ],
        "no-unused-labels": "error",
        "no-useless-catch": "error",
        "no-useless-concat": "error",
        "no-useless-escape": "error",
        "no-useless-return": "error",
        "no-void": "error",
        "no-with": "error",
        "vars-on-top": "error",
        "yoda": "error",
        "for-direction": "error",
        "getter-return": [
            "error",
            {
                "allowImplicit": true
            }
        ],
        "no-async-promise-executor": "error",
        "no-await-in-loop": "warn",
        "no-compare-neg-zero": "error",
        "no-cond-assign": ["error", "always"],
        "no-console": [
            "error",
            {
                "allow": ["warn", "error", "info"]
            }
        ],
        "no-constant-condition": "warn",
        "no-control-regex": "error",
        "no-debugger": "error",
        "no-dupe-args": "error",
        "no-dupe-keys": "error",
        "no-duplicate-case": "error",
        "no-empty": "error",
        "no-empty-character-class": "error",
        "no-ex-assign": "error",
        "no-extra-boolean-cast": "error",
        "no-func-assign": "error",
        "no-inner-declarations": "error",
        "no-invalid-regexp": "error",
        "no-irregular-whitespace": "error",
        "no-misleading-character-class": "error",
        "no-obj-calls": "error",
        "no-prototype-builtins": "error",
        "no-regex-spaces": "error",
        "no-sparse-arrays": "error",
        "no-template-curly-in-string": "error",
        "no-unreachable": "error",
        "no-unsafe-finally": "error",
        "no-unsafe-negation": "error",
        "use-isnan": "error",
        "valid-typeof": [
            "error",
            {
                "requireStringLiterals": true
            }
        ],
        "global-require": "error",
        "no-buffer-constructor": "error",
        "no-new-require": "error",
        "no-path-concat": "error",
        "func-names": "warn",
        "lines-around-directive": [
            "error",
            {
                "before": "always",
                "after": "always"
            }
        ],
        "no-array-constructor": "error",
        "no-bitwise": "error",
        "no-lonely-if": "error",
        "no-multi-assign": ["error"],
        "no-new-object": "error",
        "no-underscore-dangle": [
            "error",
            {
                "allowAfterThis": true,
                "allowAfterSuper": false,
                "enforceInMethodNames": false,
                "allow": ["_chunks"]
            }
        ],
        "no-unneeded-ternary": [
            "error",
            {
                "defaultAssignment": false
            }
        ],
        "one-var": ["error", "never"],
        "operator-assignment": ["error", "always"],
        "spaced-comment": [
            "error",
            "always",
            {
                "line": {
                    "exceptions": ["-", "+"],
                    "markers": ["=", "!"]
                },
                "block": {
                    "exceptions": ["-", "+"],
                    "markers": ["=", "!", ":", "::"],
                    "balanced": true
                }
            }
        ],
        "no-delete-var": "error",
        "no-label-var": "error",
        "no-shadow": "error",
        "no-shadow-restricted-names": "error",
        "no-undef": "error",
        "no-undef-init": "error",
        "constructor-super": "error",
        "no-class-assign": "error",
        "no-const-assign": "error",
        "no-dupe-class-members": "error",
        "no-new-symbol": "error",
        "no-this-before-super": "error",
        "no-useless-computed-key": "error",
        "no-useless-rename": [
            "error",
            {
                "ignoreDestructuring": false,
                "ignoreImport": false,
                "ignoreExport": false
            }
        ],
        "no-var": "error",
        "object-shorthand": ["warn", "always"],
        "prefer-const": [
            "error",
            {
                "destructuring": "any",
                "ignoreReadBeforeAssign": true
            }
        ],
        "prefer-numeric-literals": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
        "prefer-template": "error",
        "require-yield": "error",
        "symbol-description": "error",
        "import/no-unresolved": [
            "error",
            {
                "commonjs": true,
                "caseSensitive": true
            }
        ],
        "import/export": "error",
        "import/no-extraneous-dependencies": [
            "error",
            {
                "devDependencies": []
            }
        ],
        "import/no-mutable-exports": "error",
        "import/no-amd": "error",
        "import/first": "error",
        "import/no-duplicates": "error",
        "import/newline-after-import": "error",
        "import/no-absolute-path": "error",
        "import/no-dynamic-require": "error",
        "import/no-webpack-loader-syntax": "error",
        "import/no-named-default": "error",
        "import/no-self-import": "error",
        "import/no-useless-path-segments": "error",
        "strict": ["error", "never"],
        "@typescript-eslint/no-unused-vars": [
            "error",
            {
                "args": "none",
                "ignoreRestSiblings": true
            }
        ],
        "prettier/prettier": [
            "error",
            {},
            {
                "fileInfoOptions": {
                    "ignorePath": ".eslintignore"
                }
            }
        ]
    },
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "ecmaFeatures": {
            "globalReturn": true,
            "generators": false,
            "objectLiteralDuplicateProperties": false,
            "jsx": true
        },
        "ecmaVersion": 2018,
        "sourceType": "module"
    },
    "plugins": [
        "import",
        "prettier",
        "@typescript-eslint"
    ],
    "settings": {
        "import/extensions": extensions,
        "import/resolver": {
            "node": {
                "extensions": extensions
            }
        },
    },
    "env": {
        "es6": true,
        "node": true
    },
    "overrides": [
        {
            "files": [
                'packages/tests/**/*.*'
            ],
            "env": {
                "jest": true
            },
            "rules": {
                "global-require": 0,
                "import/no-dynamic-require": 0,
                "import/no-extraneous-dependencies": 0,
                "no-new": 0
            }
        },
        {
            "files": [
                'packages/tools/**/*.*'
            ],
            "env": {
                "node": true
            },
            "rules": {
                "global-require": 0,
                "import/no-dynamic-require": 0,
                "import/no-extraneous-dependencies": 0,
                "no-console": 0
            }
        }
    ]
};
