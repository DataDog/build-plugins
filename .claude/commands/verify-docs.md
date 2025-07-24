You are an expert in technical documentation management and quality assurance. Your task is to efficiently verify the consistency of documentation in the project.

## Execution Strategy

### Phase 1: Parallel Discovery & Initial Checks

Run these operations concurrently using multiple agents:

**Agent 1 - Documentation Discovery:**

- Find all *.md files using `find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.yarn/*" -not -path "*/dist/*" -not -path "*/.claude/*" -not -path "*/.github/*"`
- Group by type: project-level, package-specific, commands

**Agent 2 - Overall Verification:**

- Run `yarn cli integrity` for an overall check (more details in `CONTRIBUTING.md#integrity`)
- Parse output for broken links and other errors
- Note which files have issues

**Agent 3 - Critical File Check:**

- Verify at the root the existence and accuracy of: README.md, CONTRIBUTING.md, LICENSE.md
- In `./packages/published`, check for essential `package.json` fields: `name`, `version`, `description`, `keywords`, `homepage`, `repository`

### Phase 2: Comprehensive Validation

Using the list of markdown files found earlier.

**Command Verification:**
- Check configuration examples against types and implementations
- Validate CLI commands documentation against actual implementation

**Content Analysis:**
- Check for outdated feature documentation
- Validate workflow descriptions
- Verify code snippets examples against types and implementations

### Phase 3: Intelligent Reporting

**Error Prioritization:**
1. **Critical**: Broken links, missing files, invalid commands
3. **Minor**: Formatting issues, style inconsistencies

**Fix Suggestions:**
- For broken links found by the integrity command, update the targets
- For missing READMEs: Provide a template following the project's style and suggest the content to add to it

## Integration Points

1. **Leverage existing tools:**
   - Use `yarn cli integrity` for an overall check (more details in `CONTRIBUTING.md#integrity`), it includes:
     - `yarn install` for lock files update
     - `yarn oss` for Open Source compliance
     - `yarn typecheck:all` for type validation
     - `yarn format` for linting, formatting and automatic fixes
   - Use git for change detection
   - Use `yarn build:all` to ensure all packages are not broken

2. **Avoid duplication:**
   - Don't re-implement things that exist already in the repository
   - Focus on documentation-specific issues

Remember: Speed comes from doing less work, not doing work faster. Focus on high-value validations and leverage existing tools wherever possible.
