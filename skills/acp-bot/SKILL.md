---
name: acp-bot
description: Manage the local acp-bot service and its Codex or ACP sessions through the acp-bot CLI. Use when a user asks to inspect, start, safely restart, immediately restart, or stop acp-bot; open its console UI; list, inspect, stop, rename, or send a prompt to tasks; check a scheduled restart; or troubleshoot the bot without manually killing worker processes.
---

# ACP Bot

Use the `acp-bot` command as the supported control surface for the local bot. Prefer its structured status and control operations over direct process manipulation or database edits.

## Start with inspection

Verify the CLI and current service state before changing anything:

```powershell
acp-bot --help
acp-bot server status
acp-bot task list
```

Add `--json` to status and list commands when machine-readable output helps. If `acp-bot` is unavailable, report that the CLI is not installed or linked instead of guessing process state.

## Manage the service

Use these commands:

```powershell
acp-bot server start
acp-bot server status
acp-bot server restart --reason "reason for restart"
acp-bot server stop
```

Treat `server restart` as the normal restart path. It schedules a safe restart and waits for active tasks, pending final-message delivery, and a quiet inbound-message window.

Use `acp-bot server restart --immediate` only when the user explicitly requests an immediate restart or accepts interruption. Never use `taskkill`, `Stop-Process`, or equivalent commands for routine acp-bot restart management.

`acp-bot console` opens the console UI only when the service is stopped. Do not use `--force` while the service is live unless the user explicitly accepts concurrent state access.

## Manage tasks

List tasks before resolving a numeric reference because task numbers follow the current list order:

```powershell
acp-bot task list
acp-bot task status <number-or-task-id>
acp-bot task stop <number-or-task-id>
acp-bot task title <number-or-task-id> <new-title>
acp-bot task prompt <number-or-task-id> <prompt>
```

Task IDs may be supplied in full or as an unambiguous prefix. Use `task stop` to ask the running worker to send the Codex Interrupt signal; leave child-process lifecycle management to Codex.

Use `task prompt` to send input to a specific task without changing any chat's current task. The bot first posts the Prompt text to the task's existing Feishu chat, thread, or private-chat route, then submits it to the task. If posting fails, the task is not started or steered. The thinking card and final response continue to the same route; the command line only reports whether the Prompt was accepted.

For a long-running objective in the active Feishu task, use `/goal <objective>`. Use `/goal` to inspect it, `/goal pause` or `/goal resume` to control automatic continuation, `/goal edit <objective>` to revise it, and `/goal clear` to remove it. Stopping a Goal turn through ACP Bot also pauses the Goal before sending Interrupt so it does not immediately continue.

Use `/newgroup [title]` in Feishu to create a private group named `[agent-name] title` and invite the command sender without creating a task. When the title is omitted, ACP Bot uses the local `yy-mm-dd hh:mm` time. The first ordinary message sent later in the new group follows the normal automatic task-creation flow.

When a group body has a current task, renaming the Feishu group to `[agent-name] new title` also renames that current task if the prefix matches the task's configured agent. Malformed names, agent mismatches, empty groups, and thread-specific tasks are ignored.

Use `--context <key>` or `--status <status>` to narrow `task list`. Use `--config <path>` before the command when controlling a non-default acp-bot configuration.

## Apply code changes safely

After changing acp-bot code, run the relevant tests, typecheck, and build. If a running service must pick up the result, schedule:

```powershell
acp-bot server restart --reason "brief description of the completed change"
```

Do not replace the worker immediately while a task is active. A later incoming task must not cancel the pending safe restart; allow the scheduler to wait until the service becomes safely idle again.
