# Tests

All the workspaces are tested in this workspace.<br/>
It helps us have a better control over the test specific dependencies.

Especially useful for having mock projects, built with specific bundlers and run the real thing.

## Build everything & Run

```bash
yarn test
```

## Only build tests

```bash
yarn build:tests
```

## Only Run

```bash
yarn workspace @dd/tests test
```
