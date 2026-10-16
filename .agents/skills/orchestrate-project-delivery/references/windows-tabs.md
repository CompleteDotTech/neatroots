# Interactive PowerShell task tabs

Discover the installed Codex CLI and read its local help before adapting commands.
The established invocation shape is:

```powershell
codex -C $worktree -m gpt-6-luna -c model_reasoning_effort=max -c service_tier=fast $prompt
# Recovery: resume the recorded worker instead of creating a duplicate.
codex resume $sessionId -C $worktree -m gpt-6-luna -c model_reasoning_effort=max -c service_tier=fast $prompt
# Review handoff, after checking local queue help:
codex queue --thread $parentSessionId --message $reviewRequest
```

Use the project's/session's permitted sandbox and approval settings. Do not add
blanket bypass flags or alter global configuration to make a worker start.
Do not use `codex exec` when the user expects the interactive TUI. Avoid
`--strict-config` unless the installed configuration has been checked: unrelated
legacy keys previously caused startup failure. Handle trust prompts explicitly;
do not silently trust unknown hooks.

## Identify the correct window without taking focus

1. Discover the running WindowsTerminal executable and actual settings location.
   The WindowsApps `wt.exe` alias may be broken; use the verified installed binary.
   A terminal process may own multiple windows, so PID alone is insufficient.
2. Use passive UI Automation or session metadata to locate the window containing this conversation's tab.
   Record its HWND and identify the parent tab. Never hardcode a previous HWND,
   executable version, or assume `-w 1` means the current window.
3. Check installed terminal help for explicit window targeting and background
   launch support. Use a verified window ID or name; an HWND is not automatically
   a CLI window ID. Do not activate a window to use current-window targeting.
   If launch cannot preserve focus, coordinate through an existing session or
   request permission for the specific desktop interaction before launching.
4. Launch `pwsh -NoLogo -NoExit -File <task-wrapper>` in a task-owned profile,
   with a short fixed title and the task worktree as starting directory. The
   wrapper reads the assignment from a file and invokes interactive Codex.
5. Verify window membership, worktree, effective Luna/max/Fast settings, and
   fresh useful activity through session/process records, logs, and passive UI
   inspection. Do not rely only on the launch exit code or profile metadata.
   Report visual details that cannot be verified without taking focus.

UI Automation may enumerate TabItem descendants and read available TextPattern
content only without selecting or focusing controls. Do not activate windows,
select tabs (including restoring the parent tab), move the mouse, send keystrokes,
or modify the clipboard without explicit permission for that interaction.

## Deliver prompts in the background

Prefer supported session queues/APIs and assignment files. Check local queue
help and address the recorded session ID. A queue receipt proves submission,
not consumption: confirm the worker acknowledges the assignment revision or
produces matching fresh progress. Avoid duplicate submissions while waiting.
If delivery stalls, inspect process state and logs and reconcile ownership before
using a supported resume route. Never press Escape, paste, or type into a tab as
an automatic fallback. Preserve active sessions and user drafts; report a missing
background control route and continue independent work.

## Color and ownership

Use a unique task-owned terminal profile with a short tab title and application
title suppression. Prefer profile `tabColor` over a permanent launch override,
so status can change later:

| State | Color |
| --- | --- |
| Running, recovering, parent review pending | Yellow `#FFFF00` |
| Needs a user response | Orange `#FFA500` |
| Parent review completed | Remove task color override |

Before editing terminal settings, back up the file, lock concurrent task updates,
read the latest content, and preserve unrelated settings. Modify only the owned
profile; fail safely if its identity is missing or ambiguous. Read back settings
and inspect the visible result passively where possible. If visual verification
requires focus, report it as unverified. Do not overwrite another session's
settings changes.

Record task/profile/window/session/process IDs and report paths in the task
ledger. Close or stop only proven task-owned duplicates, after reconciling their
work. Do not kill unrelated PowerShell processes, terminal windows, or WSL.

This is a Windows Terminal adapter, not a requirement to use Herdr. Other runtimes
need an explicitly compatible adapter; do not claim an invisible subagent is the
requested interactive PowerShell tab.
