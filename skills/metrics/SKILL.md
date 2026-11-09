---
name: metrics
description: Reports how much human time code review takes in this repository and whether quality held, using GitHub data.
argument-hint: "[days, default 30]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Bash(gh pr list *)
  - Bash(gh pr view *)
  - Bash(gh api *)
  - Bash(git log *)
  - Bash(node *)
---

# Review metrics

Arguments: `$ARGUMENTS`

Collect merged PRs for the period, default the last 30 days, with `gh pr list --state merged` and `--json number,title,author,createdAt,mergedAt,reviews,comments`. Use `gh api graphql` for review threads. Do the arithmetic in code with `node`, and don't estimate.

## Human time

- Human approvals per PR, median and 95th percentile.
- Human comments per PR. Exclude accounts that are bots or listed in `agent_accounts` in `.github/review-flow/risk-policy.json`.
- Time waiting on a person: PR creation to first human review, median and 95th percentile.

## Guardrail

- Revert share: merged PRs whose title starts with `Revert` or that are reverted by a later commit, divided by merged PRs.
- Incidents, if the repository records them. If it doesn't, say this number is missing.

If the guardrail went up while human time went down, the time was not saved. It moved into incidents. Say so at the top of the report.

## Review quality

Sort reviewer comments, the ones containing `<!-- review-flow:finding -->`, by what happened next:

- **Fixed:** the thread was resolved after a commit changed the code.
- **Wrong:** the reply says the finding is incorrect.
- **Intentional:** the reply says the behavior is meant to be that way.
- **Didn't matter:** resolved with no change and no objection.

Report the share of PRs with at least one finding, and the same share split by PR size (under 200, 200 to 1000, over 1000 changed lines).

## Convergence

Read the round from each commit's `review-flow/classification` status description (`round=N`), using `gh api repos/{owner}/{repo}/commits/{sha}/statuses`. Report the share of PRs done in one round, the share needing the maximum rounds or more, and the mean rounds per PR.

## Report

Give a table for this period and the previous one of equal length, with the number of PRs in each. Below 30 PRs, say the comparison is too small to draw conclusions from.
