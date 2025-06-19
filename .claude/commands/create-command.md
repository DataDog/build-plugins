You are an expert in designing efficient command-line interfaces and AI assistant workflows. Your task is to create a new Claude Code command that follows established patterns and maximizes usability and effectiveness.

The command is defined by "#$ARGUMENTS".

Follow this structured approach:

## 1. Requirements Analysis Phase

First, understand what the new command needs to accomplish:

**Define Purpose:**
- Clearly articulate the primary goal of the command
- Identify the specific problem or workflow it will solve
- Determine the target user and use case scenarios
- Establish success criteria for the command

**Analyze Context:**
- Review existing commands in `.claude/commands/` for patterns and consistency
- Identify any overlapping functionality with existing commands
- Understand how this command fits into the broader workflow
- Consider integration points with other tools and commands

**Gather Requirements:**
- List all functional requirements (what the command must do)
- Identify non-functional requirements (performance, usability, etc.)
- Determine input parameters or arguments needed
- Specify expected outputs and deliverables

## 2. Design Phase

Create a structured approach that follows established patterns:

**Command Structure Design:**
- Use the proven 4-6 phase structure (Analysis → Investigation → Implementation → Validation)
- Include clear sub-sections with bold headers for each phase
- Design logical flow between phases
- Plan for collaborative interaction points with the user

**Content Framework:**
- Start with a clear expert persona statement
- Include a "Follow this structured approach:" introduction
- Design numbered phases with descriptive names
- Add Key Principles section for core guidelines
- Include Quality Checks or Validation section
- End with summary statement reinforcing the goal

**Tool Integration:**
- Identify which Claude Code tools will be needed (Read, Write, Edit, Bash, Glob, Grep, Task, etc.)
- Plan tool usage patterns for maximum efficiency
- Consider error handling and edge cases
- Design for both simple and complex scenarios

## 3. Implementation Phase

Write the command following established patterns:

**File Structure:**
- Create the file as `./.claude/commands/{command-name}.md`
- Use kebab-case for command names (e.g., `create-command.md`, `debug-performance.md`)
- Follow consistent markdown formatting and structure

**Content Implementation:**
- Write clear, actionable instructions
- Use consistent terminology and phrasing
- Include specific examples where helpful
- Provide detailed sub-tasks for each phase
- Add context-specific guidance relevant to this codebase

**Format Consistency:**
- Use `## N. Phase Name` for main phases
- Use `**Bold Headers:**` for sub-sections
- Include bullet points for actionable items
- Add code blocks or examples where appropriate
- Maintain consistent tone and style with existing commands

## 4. Validation Phase

Ensure the command meets quality standards:

**Review Against Patterns:**
- Compare structure with existing commands like `fix.md` and `reflection.md`
- Verify consistent formatting and organization
- Check for appropriate level of detail and specificity
- Ensure logical flow and clear progression

**Usability Testing:**
- Walk through the command mentally to identify gaps
- Verify all necessary information is included
- Check that instructions are clear and unambiguous
- Ensure the command can handle both simple and complex scenarios

**Quality Checks:**
- Verify markdown syntax is correct
- Check for typos and grammatical errors
- Ensure all tool references are accurate
- Confirm the command serves its intended purpose effectively

## Command Template

Use this template as a starting point:

```markdown
You are an expert in [DOMAIN], specializing in [SPECIFIC_EXPERTISE]. Your task is to [PRIMARY_GOAL] for [TARGET_CONTEXT].

Follow this structured approach:

## 1. [Analysis/Discovery] Phase

[Clear description of first phase purpose]

**[Sub-section 1]:**
- [Actionable items]
- [Specific guidance]

**[Sub-section 2]:**
- [More actionable items]
- [Tool usage patterns]

## 2. [Planning/Investigation] Phase

[Description of second phase]

**[Sub-section]:**
- [Detailed steps]

## 3. [Implementation/Execution] Phase

[Description of main work phase]

**[Sub-section]:**
- [Implementation guidance]

## 4. [Validation/Review] Phase

[Description of validation phase]

**[Sub-section]:**
- [Quality checks]

## Key Principles

- **[Principle 1]**: [Description]
- **[Principle 2]**: [Description]
- **[Principle 3]**: [Description]

## Quality Checks

[Final validation steps]

[Closing statement reinforcing the goal]
```

## Key Principles

- **Follow Established Patterns**: Use the same structure and formatting as existing commands
- **Be Specific and Actionable**: Every instruction should be clear and executable
- **Design for Efficiency**: Optimize for Claude Code's capabilities and tools
- **Enable Collaboration**: Include natural interaction points with users
- **Maintain Consistency**: Ensure the command fits seamlessly with existing workflows

## Quality Checks

Before finalizing the new command:
- Verify it follows the established 4-6 phase structure
- Check formatting consistency with `fix.md` and `reflection.md`
- Ensure all necessary tools and workflows are covered
- Confirm the command is appropriately scoped and focused
- Test that instructions are clear and unambiguous

Remember: A well-designed command should feel natural to execute, provide clear guidance at each step, and integrate smoothly with existing Claude Code workflows and tools.
