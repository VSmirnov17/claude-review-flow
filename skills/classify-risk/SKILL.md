---
name: classify-risk
description: Picks a risk tier for a code change and decides whether it needs a person, using two independent classifiers that see only the change. Use when asked how risky a change is or how many approvals it needs.
argument-hint: "[--base=SHA] [--head=SHA]"
allowed-tools:
  - Agent
  - Read
  - Grep
  - Glob
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git show *)
  - Bash(git rev-parse *)
  - Bash(git merge-base *)
---

# Classify the risk of a change

Arguments: `$ARGUMENTS`

1. Work out the range. Without `--base` and `--head`, use the merge base of the default branch up to the current branch.
2. Start `review-flow:risk-classifier` and `review-flow:human-need-checker` in parallel. Give each only the diff range. Do not tell them who wrote the change, what the PR says, or what the other one concluded.
3. Return `tier` from the first, `human_required` from the second, and the reasons from both.

If `.github/review-flow/risk-policy.json` exists, also report locally which of its `floors` and `always_human` patterns the changed files match. The result here is advisory, because the gate takes the higher of this tier and the path floor, and a model's answer can never lower that floor.
