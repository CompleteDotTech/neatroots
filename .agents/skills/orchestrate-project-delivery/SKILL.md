---
name: orchestrate-project-delivery
description: Coordinate substantive project work as the parent orchestrator, using bounded task agents, interactive PowerShell tabs, isolated worktrees, independent review, and separate accurately triaged PRs. Use for implementation and delivery in projects that opt into this workflow, or when explicitly requested.
---

# Project delivery orchestration

Act as the parent orchestrator by default for substantive project work. Own scope, assignments, review, recovery, and authorized publication. The user directs outcomes; workers implement bounded assignments. Explicit user instructions override these defaults.

Answer simple questions and perform trivial edits directly. Do not create agents or PRs merely to inflate activity. If given a bounded worker assignment, execute that assignment without recursively orchestrating or publishing outside it.

## Establish the assignment

1. Read applicable project instructions and current repository state. Check existing agents, worktrees, branches, reports, and remote PR state before starting another run. Preserve unrelated work.
2. Identify the requested endpoint: local work, reviewed changes, published PR, or explicitly authorized merge/deployment. Runtime permissions never expand this authority. Reuse authorization already given; do not ask again for routine authorized steps.
3. Split independent outcomes into separate coherent tasks and PRs. Preserve the user's preference for distinct contributions; do not combine unrelated tasks or artificially fragment one change. Stack only for real dependencies.
4. Give each worker a short name, isolated worktree/branch, explicit scope, acceptance criteria, and review handoff. Base new work on verified current upstream state. Carry this skill and project opt-in into newly created worktrees, preserving existing instructions. Preserve tracked skill files; exclude only local copies in branches where the skill is not tracked.

Use [the assignment template](references/assignment.md). Keep a small durable task ledger outside tracked source with assignment revision, parent/worker session IDs, worktree, branch/base/head, allowed scope, authorization, terminal identity, status, report path, validation, PR receipts, and notification receipts. Never store credentials in it.

## Run workers visibly

The preferred worker is **GPT-6-Luna, max reasoning, Fast mode**, in an **interactive Codex interface in a new PowerShell tab in this conversation's terminal window**. Read [Windows tabs](references/windows-tabs.md) before launch. Verify model availability and effective settings; report unavailable capabilities rather than silently substituting.

Use a concise task title. Yellow means working, recovering, or waiting for parent review. Orange means a response from the user is genuinely required. Restore the normal tab color when parent review is complete. Parent review alone must never turn a tab orange.

Coordinate without disrupting the user's desktop. Use supported session APIs or queues, assignment files, process inspection, and logs for prompts and progress. Visible tabs do not authorize changing window focus, selecting tabs, moving the mouse, sending keystrokes, or changing the clipboard. Obtain explicit permission for the specific interaction before doing any of those operations, including recovery and verification. Preserve the user's active window and drafts. If a background route is unavailable, report the limitation and continue independent work.

Verify the exact window, interactive session, task identity, and useful progress using background evidence and passive UI inspection where available. Successful process creation is not sufficient. State any unverified visual details instead of taking focus to inspect them. Do not substitute a background `codex exec` log for the requested interface. If this runtime cannot expose an interactive tab, report that limitation before claiming this workflow was launched.

Workers produce a review report and send one notification to the parent for each assignment revision/head. They remain available for corrections. Prefer uncommitted changes until parent review; explicitly define any exception. Do not let workers independently publish or merge by default.

## Review and recover

Review the actual diff, applicable project rules, scope, and appropriate validation. Treat worker reports as evidence, not approval. Inspect the exact current head and refresh review after changes. Ask workers for focused corrections; handle routine failures without burdening the user.

On a failure notification, reconcile process/session state, report timestamps, worktree changes, and remote state first. A nonzero wrapper exit can coexist with useful work or a successful later attempt. Resume the existing incomplete assignment where safe; never duplicate an active controller or restart completed work because of a delayed notification. Preserve failure history and task identity.

If a user decision is required, finish independent work, turn only the affected task orange, and ask one precise question. User silence is not approval. Never restart work that the user intentionally stopped. Never terminate the shared WSL VM.

## Publish and triage

When publication is authorized, carry reviewed changes through configured signing, commit, push, PR creation/update, and remote readback. Keep separate task PRs separate. Otherwise leave the reviewed local result and report its location. An instruction to keep work uncommitted takes precedence over every delivery default.

Read [PR triage](references/pr-triage.md) before publishing or changing GitHub metadata. Reviewable PRs should normally be ready rather than draft; an external dependency alone is not a reason to leave a PR draft. Do not merge or deploy without authority for that endpoint.

Conclude with the result, validation and material limitations, PR/file links, and any dependency or user action still needed. Record remote URLs and head SHAs after readback. A running agent, open PR, absent checks, and passing CI are different outcomes; state which was actually observed.
