---
name: pre-pr
description: Gets a change ready for a pull request. Runs the project's checks and shows their output, runs local bug and security review in fresh context, and drafts the PR description. Use before opening a PR or when asked if a change is ready.
argument-hint: "[quick|standard|deep]"
---

# Prepare a change for review

Arguments: `$ARGUMENTS`

## 1. Run the checks

Find the project's checks in the `Checks` section of `CLAUDE.md`, or in its CI configuration if that section is missing. Run all of them: tests, types, lint and build.

Show each command with its real output or exit status. "It should pass" is not evidence. If a check fails, fix the cause and run it again. Do not skip, weaken or delete a check to get a pass. If you cannot fix it, stop and report it.

For UI changes, open the page, compare it with the project's design guidelines if it has any, and capture a screenshot for the PR.

## 2. Review in fresh context

Run the `review-flow:review` skill with the requested mode, default `standard`. Then run `review-flow:security`. Both use subagents that have not seen how the change was written.

Fix what they confirm, then run step 1 again. If a finding looks wrong, leave the code as it is and report the finding with your reasoning.

## 3. Draft the PR description

Fill in `.github/pull_request_template.md`:

- **Testing:** the commands that ran and what they returned.
- **Risk:** what could break, who it affects, and what the checks would not catch.
- **How to revert:** the exact steps, including anything a plain revert will not undo.

## 4. Hand over

Show the description to the person who asked for the change. They sign off on it, so do not tick the sign-off box for them.

Open or push a PR only if they asked you to.
