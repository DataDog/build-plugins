# Tools

A simple CLI to run some meta tool on the repo.

## Run

```bash
# Print all the commands
yarn cli --help

# Run a specific command
yarn cli <command> [args]
```

## Commands

- `create-plugin`: A wizard to create a new plugin in the repository.
- `dashboard`: Generate a new dashboard configuration to be imported in Datadog.
- `oss`: Make the code compliant with our Open Source rules.
- `integrity`: Automate the verification of the repository. (Also runs `oss` command).
