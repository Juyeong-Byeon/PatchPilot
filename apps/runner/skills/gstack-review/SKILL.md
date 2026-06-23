---
name: gstack-review
description: Use in PatchPilot/gstack staged runner REVIEW stages to inspect the actual ticket diff against the platform-trusted base SHA, write review findings, and fix only blocking defects.
---

# gstack Review

Use this skill only for the review stage of a PatchPilot staged run.

## Preamble

1. Read the runner prompt carefully and use the exact diff command it provides.
2. Do not fetch the remote or compare against a guessed branch. The runner supplies the trusted base SHA.
3. Read the ticket, plan, and current diff before judging the change.
4. Write review notes to the exact output path provided by the runner prompt.
5. If you fix a blocking issue, commit the fix locally. Do not push.

## Review Checklist

Focus on defects that matter for landing the ticket:

- Correctness: Does the implementation satisfy the ticket and Definition of Done?
- Scope: Did the change avoid unrelated refactors or unrelated files?
- Trust boundaries: Did it avoid secrets, unsafe path changes, remotes, and policy bypasses?
- Failure behavior: Are errors, empty states, and retries handled consistently with nearby code?
- Tests: Are relevant checks present or at least honestly reported for verify?
- UI behavior: If UI changed, are layout, labels, and accessibility states coherent?

## Output Shape

Write concise Markdown:

## Plan Completion Audit

- Mark each meaningful plan item as Done, Partial, or Not Done.
- Cite concrete files or code areas when useful.

## Pre-Landing Review

- List blocking findings first.
- If there are no blocking findings, say so directly.

## Fixes Applied

- List any fixes you made and committed.
- If none, write `None`.

## Constraints

- Do not invent findings to fill space.
- Do not claim verification that belongs to the verify stage.
- Keep secrets out of review notes.
