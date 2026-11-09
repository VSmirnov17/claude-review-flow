---
name: setup
description: Installs the review-flow process into the current repository, including REVIEW.md, rules, PR template, GitHub workflows, risk policy and branch protection.
argument-hint: "[--dry-run]"
disable-model-invocation: true
---

# Set up review-flow in this repository

Arguments: `$ARGUMENTS`

Templates are in `${CLAUDE_SKILL_DIR}/templates`. With `--dry-run`, report what you would do and change nothing.

## 1. Learn the project

- Get the owner, repository and default branch from `git remote` and `gh repo view`.
- Find the stack and the real commands for tests, types, lint, build and formatting.
- Read any existing `CLAUDE.md`, `REVIEW.md`, `.github/` files and CI workflows. Note the job names of existing CI checks.
- Count people with write access using `gh api repos/{owner}/{repo}/collaborators`. One person means a **solo** repository.
- Find the marketplace source with `claude plugin marketplace list`. If `review-flow` points to a local path, ask for its GitHub `owner/repo`, because CI cannot use a local path.
- Look for sensitive paths: auth, billing, payments, migrations, release and deployment code, installers.

## 2. Confirm the plan

Show one short list: files to add, files to change, proposed `trusted_authors`, proposed `floors` and `always_human` paths, and approvals by tier. Wait for confirmation.

For a solo repository, propose `"high": 1` in `approvals`, because GitHub does not let authors approve their own PRs and no second person exists. Say that this is weaker than the two-person rule.

## 3. Copy the files

Never overwrite an existing file. If a target exists, merge the missing parts into it, or show the difference and ask.

| Template | Target |
|---|---|
| `REVIEW.md` | `REVIEW.md` |
| `CLAUDE.snippet.md` | Append to `CLAUDE.md`, filled in with real values |
| `claude/rules/review-flow.md` | `.claude/rules/review-flow.md` |
| `claude/settings.json` | Merge into `.claude/settings.json` |
| `github/pull_request_template.md` | `.github/pull_request_template.md` |
| `github/CODEOWNERS` | `.github/CODEOWNERS` |
| `github/review-flow/risk-policy.json` | `.github/review-flow/risk-policy.json` |
| `github/review-flow/review-flow.mjs` | `.github/review-flow/review-flow.mjs`, unchanged |
| `github/workflows/review-flow.yml` | `.github/workflows/review-flow.yml` |
| `github/workflows/review-flow-gate.yml` | `.github/workflows/review-flow-gate.yml` |

Replace `__OWNER__` with the repository owner and `__MARKETPLACE_REPO__` with the marketplace's `owner/repo`, including in `claude/settings.json`. Tailor `REVIEW.md` to what failure looks like in this project, and keep it short.

If the project has a formatter or fast linter, add a `PostToolUse` hook on `Write|Edit` to `.claude/settings.json` that runs it on the changed file. The hook receives JSON on stdin with `tool_input.file_path`.

## 4. Things only the person can do

List these and do not attempt them:

1. Add a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` repository secret. `claude setup-token` creates the first.
2. Install the Claude GitHub App, from `/install-github-app` or https://github.com/apps/claude.
3. Merge these files to the default branch before relying on the gate. GitHub reads `pull_request_target` and `issue_comment` workflows from the default branch, and the gate reads its policy from the PR's base, so the PR that adds them cannot be gated by them.

## 5. Branch protection

Apply this only after the workflows are on the default branch and the person confirms, because it changes how the repository accepts merges. Show the exact command first. Branch protection on a private repository needs a paid GitHub plan, so if the API refuses, report that.

Add the names of existing CI jobs to `contexts`.

```bash
gh api -X PUT repos/{owner}/{repo}/branches/{branch}/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["review-flow/gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "required_conversation_resolution": true,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

The approval count is 0 because `review-flow/gate` enforces the number for each tier. `required_conversation_resolution` is what blocks a merge while a finding is open.

## 6. Finish

Report what changed, what is left for the person, and how to try it: open a small PR, wait for `review-flow/gate`, then `/signoff <sha>` if a person is required.
