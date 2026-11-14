# Review rules

Every project that installs this plugin runs these prompts and this gate, so a mistake here spreads.

## What failure looks like in this project

- The gate fails open: a commit merges without the approvals its tier needs, or an approval or sign-off counts for a different commit.
- A workflow gives content from a pull request write access, secrets, or a way to run code, including through `${{ }}` in `run:` or through files Claude Code loads.
- A prompt makes the reviewer miss real bugs, post noise, approve, or follow instructions found in a diff.
- A template still contains a `__PLACEHOLDER__` after `setup`, or `setup` overwrites a file in the target project.
- The README or a skill describes behavior the code does not have. For docs, failure is "it lies".

## Always check

- Every new path through `decide` and `runGate` has a test, including the path where an API call fails.
- Workflow permissions are the minimum each job needs.
- Skills and workflows agree on argument names and output formats.

## Skip these paths

- `assets/**`

## How to report

- Cite a file and line as evidence. Do not infer behavior from a name.
- Report at most 3 nits per review.
- Start the summary with a count. If there is nothing to fix, say so plainly.
- Write comments in English.
