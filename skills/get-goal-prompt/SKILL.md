---
name: get-goal-prompt
description: "Generate a /goal command to execute an ideation project's specs autonomously. Reads the contract, builds a goal prompt with phase ordering and spec paths, copies it to clipboard, and prints it. The user pastes the /goal command to start autonomous execution. Use when the user says 'goal', 'run as goal', 'get goal prompt', 'goal prompt', or wants to execute specs via /goal instead of /ideation:autopilot."
argument-hint: "[path/to/contract.md]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Generate /goal Command for Spec Execution

## Arguments: $ARGUMENTS

Build a `/goal` command that will autonomously execute all specs in an ideation project, then copy it to the user's clipboard.

## Step 1: Find the Contract

- If a path was provided in `$ARGUMENTS`, use it
- Otherwise, glob for `./docs/ideation/*/contract.md`
- If multiple found, pick the most recently modified

Read `contract.md` and extract:

1. **Project name and directory** from the contract path
2. **Phases** — title, spec path, and dependency ordering from the Execution Plan section
3. **Already-completed phases** — run `git log --oneline --grep="spec-phase"` to find commits referencing spec files. Exclude completed phases from the goal.

If no uncompleted phases remain, tell the user and stop.

## Step 2: Build the Goal Prompt

Construct a `/goal` condition under 4000 characters. The condition serves as both the directive (what Claude should do) and the completion check (what the evaluator verifies).

Use this template, filling in the project-specific values:

```
/goal Execute all implementation specs for {project-name} in dependency order. For each phase, read the spec file, implement all changes following the spec's implementation details, run validation commands from the spec, and commit with a descriptive message referencing the spec.

Phases (execute in this order, respecting dependencies):
{numbered list of phases with spec paths and dependency notes}

How to execute each phase:
1. Read the spec file completely before starting
2. Follow the spec's "Implementation Details" section for what to build
3. Use the spec's "Feedback Strategy" inner-loop command after each component
4. Run all "Validation Commands" from the spec before committing
5. Commit only when all validations pass — message format: "feat({slug}): implement phase N — {title}"

Done when: git log shows a commit for every listed phase with passing validation. If a phase's validation fails after 3 attempts, stop and report which phase failed and why.
```

**Phase list format** — one line per phase:

```
1. {title} → {spec-path} (blocking)
2. {title} → {spec-path} (after phase 1)
3. {title} → {spec-path} (after phase 1, parallel with 2)
```

Omit completed phases from the list. If phases were skipped, note: "Phases {list} already committed — starting from phase {N}."

**Keep it under 4000 characters.** If the phase list is long, abbreviate notes. The spec files contain all the detail — the goal prompt just needs ordering and paths.

## Step 3: Output and Copy

1. Copy the full `/goal` command to clipboard:

   ```bash
   echo '<goal command>' | pbcopy    # macOS
   ```

   On Linux, try `xclip -selection clipboard` or `xsel --clipboard`.

2. Print the command to screen so the user can see what they're about to run:

   ```
   Copied to clipboard. Paste to start:

   /goal Execute all implementation specs for ...
   ```

3. Remind the user: "Make sure auto mode is enabled so tool calls don't block each turn. Run `/auto` first if needed."

That's it. The skill's job is done once the command is on the clipboard. `/goal` handles the rest.
