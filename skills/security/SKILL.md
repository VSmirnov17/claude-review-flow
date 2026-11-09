---
name: security
description: Security review of a branch or pull request, separate from the bug review. A security reviewer searches and independent verifiers vote. Use when asked for a security check of a change.
argument-hint: "[--pr=N] [--base=SHA] [--head=SHA] [--since=SHA] [--post]"
allowed-tools:
  - Agent
  - Read
  - Grep
  - Glob
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git show *)
  - Bash(git blame *)
  - Bash(git rev-parse *)
  - Bash(git merge-base *)
  - Bash(gh pr view *)
  - Bash(gh pr diff *)
  - Bash(gh pr comment *)
  - Bash(gh api graphql *)
  - mcp__github_inline_comment__create_inline_comment
---

# Security review

Arguments: `$ARGUMENTS`

Never approve a pull request.

1. Settle the scope and rules exactly as steps 1 and 2 of the `review-flow:review` skill describe: the range, `--since` handling, reading rules from the base commit with `--post`, the already-posted list, and resolving threads the code has fixed.
2. Start one `review-flow:security-reviewer` agent with the diff range and the review rules.
3. If it returns candidates, assign IDs and start 3 `review-flow:finding-verifier` agents in parallel with the full list, leaving out `evidence`. Keep a finding only with at least 2 `real` votes.
4. Report as in step 6 of `review-flow:review`, with the summary starting with a count. Tag each finding `[Important]` or `[Pre-existing]`, and start its claim with `Security:`. End each posted comment body with `<!-- review-flow:finding -->`.
