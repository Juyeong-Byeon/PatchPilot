# PatchPilot Staged Workflow

## PLAN

Read: ticket, context, policy, and enough repository context to identify likely
files and checks.

Write: `plan.md` to the output path supplied by the prompt.

Do not modify repository files, stage changes, or create commits. If the ticket
needs a human decision, explain that the implement stage should write
`needs-input.json`.

## IMPLEMENT

Read: ticket, context, policy, the plan, and the existing code/tests around the
planned change.

Write: focused repository changes and at least one non-empty local commit.

If blocked by a human decision, write only `needs-input.json` and leave the repo
unchanged. If blocked by policy or infrastructure, write `failure.json` with the
right category.

## REVIEW

Read: the prompt-provided diff command, the trusted base SHA, the ticket, plan,
and actual diff.

Write: `review.md` to the output path. Fix and commit only blocking defects that
are in scope for the ticket. Do not invent findings or broaden the change.

## VERIFY

Read: the final diff, test scripts, package metadata, and relevant project
documentation.

Run the smallest meaningful checks first. Write `qa.json` and `qa.md` to the
output paths. Commit fixes if verification reveals in-scope defects. Do not mark
`passed` true for failed or unrun checks.

## DOCUMENT

Read: the final diff and available stage notes (`plan.md`, `review.md`,
`qa.md`).

Write: `pr-description.md` to the output path. Do not modify repository files or
create commits. If authoring fails, do not fabricate diff details.
