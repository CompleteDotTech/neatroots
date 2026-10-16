# GitHub PR triage

Inspect live repository labels, related issues/PRs, maintainer comments, head/base,
draft state, checks, and viewer permissions. Do not infer current state from a
saved report. Apply only metadata supported by the change and existing taxonomy.

- Title and body: lead with the concrete problem and resulting behavior. Include
  relevant validation and limitations. Avoid conversational history.
- Labels: apply accurate existing labels when permitted. If denied, report the
  permission limit and requested label; never claim it was applied.
- Issues: use closing keywords only when the PR actually resolves that issue.
  Otherwise use a related link. Do not invent an issue solely to add metadata.
- Comments: link the exact motivating maintainer comment. A replacement for a
  closed PR should link that PR and respect the newly narrowed scope. Do not
  reopen the closed PR without instruction.
- Dependencies: distinguish shared subject matter from a true prerequisite.
  State blocking PRs, merge/rebase order, and what reviewers can review now.
  Update parent/child links where useful and authorized. Do not assign arbitrary
  reviewers, milestones, projects, or priorities.
- Separate contributions: retain one coherent PR per task. Do not combine tasks
  to simplify orchestration. Do not create artificial subdivisions for counts.

For a stack, verify that the hosting repository can use the proposed base branch.
An upstream PR cannot necessarily target a branch that exists only in a fork.
When necessary, target upstream main, explicitly describe the dependency, and
provide a current comparison isolating the child change. After a squash merge,
replay only the child's own commits onto updated main; inspect the resulting diff
and rerun affected checks. Branch ancestry alone does not establish a dependency.

After publishing, read back URL, title, body, labels, base/head, draft/open state,
and check status. Distinguish checks awaiting maintainer approval from passing
checks; no reported CI is not passing CI. Bot quota failures are not code findings.
Record permission limitations and remaining maintainer actions precisely.

Never merge merely because review passed. Preserve configured signing and verify
remote head identity. Use an existing authorized authentication route if one
transport lacks permission; do not broaden account scopes as a routine workaround.
