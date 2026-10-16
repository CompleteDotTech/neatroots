# Bounded worker assignment

Provide the following in the worker's initial prompt, using concrete values:

```text
You are the worker for <short task name>, assignment <id/revision>.
Parent: <session ID and notification mechanism>.
Worktree: <absolute path>. Branch: <branch>. Base: <ref and SHA>.
Read project AGENTS instructions. Your bounded role overrides the default
orchestrator role: do not spawn workers or take over other assignments.

Outcome: <user-visible result>.
Source request: <exact relevant instruction/comment URL>.
Allowed scope: <files/behavior>. Exclusions: <specific adjacent work>.
Dependencies: <actual prerequisites, or none>.
Acceptance and validation: <proportionate checks and expected evidence>.
Authority: <local edits only, or specifically authorized endpoints>.
Stop/escalate for: <genuinely missing input or authority>.

Write <report path> with assignment revision, changed files, diff/base/head,
validation results and limitations, dependency assessment, and remaining work.
Leave changes uncommitted for parent review unless expressly told otherwise.
Send one review request to the parent containing task ID, revision, worktree,
report path, and head SHA; then remain available for corrections.
Keep the tab yellow while awaiting parent review. Orange is only for a user
decision, not for parent review. Do not publish or merge on your own.
```

For a resumed task, include the existing session ID, previous failure evidence,
already completed actions, and the precise remaining scope. Deduplicate review
notifications by assignment revision and reviewed head/diff, not just task name.
