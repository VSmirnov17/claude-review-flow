---
name: evals
description: Maintains an evaluation set for the reviewer. Turns an incident or revert into an expert-confirmed case, and scores the reviewer against all cases.
argument-hint: "add <PR or commit> | add-clean <PR> | run [quick|standard|deep]"
disable-model-invocation: true
---

# Reviewer evals

Arguments: `$ARGUMENTS`

Cases live in `.review-flow/evals/cases/<id>.json`, and results in `.review-flow/evals/results.jsonl`.

## `add <PR or commit>`

Build a case from a change that caused an incident or a revert.

1. Find the change that introduced the bug, and its fix or revert.
2. Record which layer should have caught it: local checks, AI review, security review, CI, human approval, or rollout.
3. Show the proposed case and ask a person who knows the code to confirm the bug and where it lives. Do not save a case without their name.

```json
{
  "id": "2026-11-cart-rounding",
  "kind": "bug",
  "base": "<commit before the change>",
  "head": "<commit that introduced the bug>",
  "bug": { "file": "src/cart.ts", "line": 42, "class": "rounding", "description": "what goes wrong" },
  "source": "PR or incident link",
  "should_have_caught": "AI review",
  "confirmed_by": "name"
}
```

## `add-clean <PR>`

Add a PR that is known to be good, with `"kind": "clean"`, no `bug` field, and the name of the person who vouches for it. These cases measure false alarms.

## `run [mode]`

1. Note the state to score: the plugin version and the mode, default `standard`.
2. For each case, print only `id`, `base` and `head`, for example with `node -e`. Do not read `bug` yet, so the review stays blind.
3. Check out `head` in a temporary `git worktree` and run the `review-flow:review` skill there with `--base` and `--head`. Do not post anything. Save the findings.
4. After every case has been reviewed, read the expected bugs and score:
   - `bug` case: a **hit** if a finding names the same defect at the same place or in the same function. A near miss on the same file does not count.
   - `clean` case: count findings that would have led someone to make a harmful change.
5. Remove the worktrees. Append one line per run to `results.jsonl` with the date, version, mode, hits, total bug cases, harmful false alarms and clean cases.
6. Compare with the previous line for the same mode. Report the score and name the cases that changed.

When the reviewer's prompts, tools or model change, run this before and after. Keep the change only if the score improved, catching real bugs first and fewer review rounds second. With fewer than about 20 cases, a difference of one or two cases is noise, so say so.
