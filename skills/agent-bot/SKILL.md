---
name: agent-bot
description: Use the agentbot CLI to inspect and safely manage Agent Bot, its profiles, service, tasks, groups, settings, Goals, Turns, files, and restarts. Use when running inside Agent Bot or when the user asks to initialize, inspect, control, troubleshoot, or restart Agent Bot.
---

# Agent Bot

Use `agentbot` as the supported control surface. The legacy `agent-bot` command is deprecated.

## What Agent Bot Is

Agent Bot connects Feishu conversations to local coding Agents such as Codex and TraeX. Each Agent Bot task keeps its own Agent, project directory, conversation context, and execution settings, so work can continue from Feishu without direct access to the host computer.

Source code: https://github.com/keyou/agent-bot

Use Agent Bot when the user wants to:

- Continue or monitor a local Agent task from Feishu.
- Keep work for different projects or conversations separate.
- Create a fresh task or fork completed context into parallel work.
- Change an Agent, model, reasoning level, permission mode, Goal, or queued Prompt.
- Browse task files, send a file to Feishu, or run a command in the task directory.
- Inspect, restart, initialize, or troubleshoot the Agent Bot service.

## Detect Agent Bot

Agent Bot sets `AGENT_BOT=1` for every Agent process it starts. Treat that exact value as authoritative:

```powershell
$env:AGENT_BOT -eq "1"
```

Do not infer Agent Bot execution from an installed CLI, a running service, or the presence of `~/.agent-bot`.

## Work Safely

When running inside Agent Bot:

- Use `agentbot` commands instead of killing workers, supervisors, or child processes.
- When hosted by Agent Bot, omit the task target to act on the current task. Use `--task <task>` only to target another task explicitly.
- Use the same `--profile <directory>` on every command when managing an isolated profile.
- Prefer `--json` when another tool or Agent will consume the output.
- Do not edit the Agent Bot SQLite database or runtime files directly.
- Verify code changes before scheduling a restart.

## Inspect First

```powershell
agentbot --version
agentbot server status
agentbot task current --json
agentbot task list
```

`task current` shows details, but other `task` commands resolve the invoking task automatically. If automatic resolution fails, use an explicit ID from `task list` with `--task <task>`.

Task references may be a list number, a full task ID, or an unambiguous ID prefix.

## Manage Tasks

Use these common commands:

```powershell
agentbot task status
agentbot task prompt "<prompt>"
agentbot task queue "<prompt>"
agentbot task stop
agentbot task archive
agentbot task title "<title>"
```

- `prompt` posts the Prompt to the task's Feishu conversation before submitting it.
- `queue` creates a later turn instead of steering the active turn. `nosteer` is an alias.
- `stop` requests an Agent interrupt; it does not kill the Agent process.

Create or branch work in the same conversation:

```powershell
agentbot task new [title] [--agent <name>] [--dir <cwd> | --nodir]
agentbot task fork
agentbot task switch [target-task]
```

Create a separate Feishu group:

```powershell
agentbot task newgroup [title] [--agent <name>] [--dir <cwd> | --nodir]
agentbot task forkgroup [title]
```

Choose `new` or `newgroup` for fresh context. Choose `fork` or `forkgroup` when the new task must retain conversation history through the latest completed Turn. Forking must not interrupt an active source turn.

## Change Settings

```powershell
agentbot task agent [name]
agentbot task provider [provider]
agentbot task model [model]
agentbot task thinking [effort]
agentbot task permissions [auto|confirm]
```

Omit the value to inspect the current setting and available choices. `agent` changes the default Agent for future tasks in that conversation. The other settings affect the specified task from its next request.

## Goals And Turns

```powershell
agentbot task goal
agentbot task goal "<objective>"
agentbot task goal pause|resume|clear
agentbot task goal edit "<objective>"
agentbot task turns
agentbot task reset <turn-id>
```

Use `turns` to obtain a real Turn ID before `reset`. Reset changes conversation context only; it does not revert local files.

## Files And Local Commands

```powershell
agentbot task dir [directory]
agentbot task file <path>
agentbot task shell "<command>"
```

Paths are resolved from the selected task's working directory; `~` means the operating-system user's home directory. `file` sends the file to the task's Feishu conversation. `shell` runs in the task directory.

For group mention-only mode:

```powershell
agentbot task mute on|off
```

## Manage The Service

```powershell
agentbot server start
agentbot server status
agentbot server autostart enable|status|disable
agentbot update --task <task>
agentbot server restart --task <task> --reason "<reason>"
agentbot server stop
```

`update` is only for npm-installed Agent Bot packages. It verifies the new package before waiting for a safe service stop and automatically restores the prior version if activation fails. It refuses source checkouts and `npm link` installations.

Autostart is Profile-specific. Use `server autostart enable` for login startup, `server autostart enable --linger` on Linux only when the user explicitly requests startup before login, and `server autostart disable` to remove registration without stopping the current Server. Disabling Agent Bot autostart must not disable Linux user lingering because other services may use it.

Use safe restart by default. Prefer `agentbot task restart` when hosted so the current task is resolved automatically. Use `--immediate` or `task restart --force` only when the user explicitly accepts interruption.

Never use `taskkill`, `Stop-Process`, or equivalent commands for routine restart management.

## Initialize And Select Profiles

```powershell
agentbot init
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server status
```

Initialization prepares configuration, checks supported Agents, configures Feishu, and starts the server. On first initialization and `init --reset`, let the user choose whether all group messages are accepted or an explicit @ mention is required; only the first choice requests the additional all-group-message permission. Relay authorization links and wait for the user; never choose a response mode, skip authorization, or choose maintenance actions without permission.

Use `init --reset` only for an explicitly requested full reset and always with an explicit `--profile`. It preserves backups under `.reset-backups`.

## After Code Changes

Run the relevant checks, then build:

```powershell
npm run typecheck
npm test
npm run build
```

If the running service must load the changes, schedule a safe restart only after verification:

```powershell
agentbot task restart --reason "<brief reason>"
```

Use `agentbot --help` for less common options and command details.
