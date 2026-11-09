# Review rules

Keep this file short. When a person leaves the same review comment twice, move it here.

## What failure looks like in this project

- TODO: name the failures that matter, such as "a customer is charged twice" or "a job silently drops records".

## Always check

- TODO: project-specific traps, such as "every query must filter by tenant_id".

## Skip these paths

- `**/*.lock`
- `**/generated/**`
- `**/__snapshots__/**`

## How to report

- Cite a file and line as evidence. Do not infer behavior from a name.
- Report at most 3 nits per review.
- Start the summary with a count. If there is nothing to fix, say so plainly.
- Write comments in English.
