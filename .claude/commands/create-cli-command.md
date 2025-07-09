You are an expert in creating CLI commands for the Datadog Build Plugins project.
Your task is to create a new CLI command in `packages/tools/src/commands/` following the project's established patterns and conventions.

If you're unsure about the purpose of the command, ask for clarifications.

## Overview

The project uses [Clipanion framework](https://mael.dev/clipanion/docs/) for CLI commands.
Each command should be self-contained in its own directory under `packages/tools/src/commands/` with proper TypeScript implementation.

## Step-by-Step Implementation

### 1. Create Command Directory Structure

First, create the directory structure for your new command:

```bash
mkdir -p packages/tools/src/commands/<command-name>
```

The command name should be kebab-case (e.g., `verify-links`, `create-plugin`, `check-deps`).

### 2. Create the Command Implementation

Create `packages/tools/src/commands/<command-name>/index.ts` with this template:

```typescript
import { Command, Option } from 'clipanion';
import path from 'path';
import fs from 'fs';

import { ROOT } from '@dd/core/constants';

class YourCommandName extends Command {
    static paths = [['<command-name>']];

    static usage = Command.Usage({
        category: 'The category of the command',
        description: 'Brief description of what this command does in one sentence',
        details: `
            Detailed description of the command's purpose and behavior.
        `,
        examples: [
            ['Basic usage', 'yarn cli <command-name>'],
            ['With options', 'yarn cli <command-name> --fix'],
        ],
    });

    // Define command options using Clipanion helpers
    fix = Option.Boolean('--fix', false, {
        description: 'Automatically fix issues when possible',
    });

    async execute() {
        // Implementation of the command's logic.
        // For the dependencies, import the non native ones in the function that needs it:
        const { green } = await import('@dd/tools/helpers');
        console.log(`Executing ${green('<command-name>')} command...`);
    }
}

export default [YourCommandName];
```

### 3. Common Patterns to Follow

#### Dependencies

Only import native modules at the top of the file.

For non-native dependencies, import them inside the method that needs it.
This helps reduce the initial load time and avoids unnecessary imports when the command is not executed.

```typescript
const { green } = await import('@dd/tools/helpers');
console.log(`Executing ${green('<command-name>')} command...`);
```

#### Error Handling

Prefer gathering errors and reporting them at the end of the command execution to avoid breaking the flow.

If the command is grouping multiple workflows or operations, collect errors in a consistent format and throw one at the end listing everything.

```typescript
const errors: string[] = [];

// Collect errors in a non blocking/breaking way, with consistent formatting
errors.push(`[${red('Error|Category')}] ${file}:${line} - ${dim(message)}`);

// Report all errors at the end of the execution
if (errors.length > 0) {
    throw new Error(`Found ${errors.length} error${errors.length > 1 ? 's' : ''}`);
}
```

#### Progress Indicators
```typescript
console.log(`  Processing ${green(files.length.toString())} files...`);

// For long operations
for (const [index, file] of files.entries()) {
    console.log(`    [${index + 1}/${files.length}] ${dim(file)}...`);
    // Process file
}
```

### 4. Testing Your Command

Test your command locally:

```bash
# Run your command
yarn cli <command-name>
yarn cli <command-name> --help
yarn cli <command-name> --fix
```

### 5. Code Quality Checks

Before finalizing:

```bash
# Format your code
yarn format packages/tools/src/commands/<command-name>

# Check types
yarn typecheck:all
```

### 6. Documentation

Update the main documentation:

1. Add command to README.md if it's user-facing
2. Update CONTRIBUTING.md if it's a development tool
3. Add inline comments for complex logic

## Example Commands for Reference

Look at these existing commands for patterns:
- `integrity/index.ts` - Complex multi-phase command
- `create-plugin/index.ts` - Interactive command with prompts
- `bump/index.ts` - Command with external tool integration

## Best Practices

1. **Keep it focused**: Each command should do one thing well
2. **Use existing utilities**: Leverage `@dd/core` helpers
3. **Consistent output**: Use colors consistently (green for success, red for errors, yellow for warnings) available in `@dd/tools/helpers`
4. **Graceful errors**: Always catch and report errors clearly
5. **Progress feedback**: Show users what's happening during long operations
6. **Exit codes**: Return 0 for success, 1 for errors

Remember: CLI commands are the primary interface for developers. Make them intuitive, fast, and reliable.
