---
name: agent-bot
description: Initialize Agent Bot, detect and work safely inside its runtime, and manage the local service and its Codex or ACP sessions through the agent-bot CLI. Use when an agent needs to adapt its behavior while running under Agent Bot, or when a user asks to initialize, inspect, start, safely restart, immediately restart, or stop Agent Bot; open its console UI; list, inspect, stop, rename, or send a prompt to tasks; check a scheduled restart; or troubleshoot the bot without manually killing worker processes.
---

# Agent Bot

Use the `agent-bot` command as the supported control surface for Agent Bot. Prefer its structured status and control operations over direct process manipulation or database edits.

## Detect the Agent Bot runtime

Agent Bot injects `AGENT_BOT=1` into every Codex and ACP agent process it starts. Test for the exact value `1`:

```powershell
if ($env:AGENT_BOT -eq "1") { "running in Agent Bot" }
```

```sh
if [ "${AGENT_BOT:-}" = "1" ]; then echo "running in Agent Bot"; fi
```

```js
const runningInAgentBot = process.env.AGENT_BOT === "1";
```

```python
import os

running_in_agent_bot = os.environ.get("AGENT_BOT") == "1"
```

Treat this environment marker as authoritative. Do not infer Agent Bot execution merely because the CLI is installed, `~/.agent-bot` exists, or an Agent Bot process is running elsewhere. Configured agent environment variables cannot override the marker. Child processes normally inherit it, so the marker identifies the Agent Bot-started process tree unless a child explicitly replaces its environment.

## Behave safely inside Agent Bot

When `AGENT_BOT=1`:

- Do not kill Agent Bot, its supervisor, or agent workers directly. For code changes that must be loaded by the running service, finish verification first and schedule a safe restart; never use an immediate restart from an active hosted task unless the user explicitly accepts interruption.
- Keep repository contents limited to source and examples. Read user configuration and runtime state from the root selected by `AGENT_BOT_HOME`, defaulting to `~/.agent-bot`.

## Initialize after installation

Run initialization once after installing or linking the CLI:

```powershell
agent-bot init
```

Initialization creates the Agent Bot home, `config.yaml`, `.env`, `data/`, and `logs/` from the bundled examples. It is idempotent and never overwrites existing configuration or environment files. It respects `AGENT_BOT_HOME`, `AGENT_BOT_CONFIG`, and `--config <path>`. Use `agent-bot init --json` when structured output helps.

## Start with inspection

Verify the CLI and current service state before changing anything:

```powershell
agent-bot --help
agent-bot server status
agent-bot task list
```

Add `--json` to status and list commands when machine-readable output helps. If `agent-bot` is unavailable, report that the CLI is not installed or linked instead of guessing process state.

By default Agent Bot stores user-owned configuration and runtime state in `~/.agent-bot`: config at `~/.agent-bot/config.yaml`, environment variables at `~/.agent-bot/.env`, SQLite state at `~/.agent-bot/data/agent-bot.sqlite`, logs at `~/.agent-bot/logs/agent-bot.log`, and inbound image cache next to the SQLite database. `AGENT_BOT_HOME` changes this root. Use `--config <path>` only when controlling a non-default configuration.

## Manage the service

Use these commands:

```powershell
agent-bot server start
agent-bot server status
agent-bot server restart --reason "reason for restart"
agent-bot server stop
```

Treat `server restart` as the normal restart path. It schedules a safe restart and waits for active tasks, pending final-message delivery, and a quiet inbound-message window.

Use `agent-bot server restart --immediate` only when the user explicitly requests an immediate restart or accepts interruption. Never use `taskkill`, `Stop-Process`, or equivalent commands for routine Agent Bot restart management.

`agent-bot console` opens the console UI only when the service is stopped. Do not use `--force` while the service is live unless the user explicitly accepts concurrent state access.

## Manage tasks

List tasks before resolving a numeric reference because task numbers follow the current list order:

```powershell
agent-bot task list
agent-bot task chat <number-or-task-id> [--json]
agent-bot task status <number-or-task-id>
agent-bot task stop <number-or-task-id>
agent-bot task title <number-or-task-id> <new-title>
agent-bot task prompt <number-or-task-id> <prompt>
```

Task IDs may be supplied in full or as an unambiguous prefix. Use `task stop` to ask the running worker to send the Codex Interrupt signal; leave child-process lifecycle management to Codex.

Use `task chat <number-or-task-id>` to read the Feishu chat ID associated with a task from local routing state. Plain output is only the chat ID for scripting. Add `--json` to include the stable task ID, complete context key, and the thread ID for a topic-bound task. This read-only command does not require the Agent Bot server to be running.

Use `task prompt` to send input to a specific task without changing any chat's current task. The bot first posts the Prompt text to the task's existing Feishu chat, thread, or private-chat route, then submits it to the task. If posting fails, the task is not started or steered. The thinking card and final response continue to the same route; the command line only reports whether the Prompt was accepted.

For a long-running objective in the active Feishu task, use `/goal <objective>`. Use `/goal` to inspect it, `/goal pause` or `/goal resume` to control automatic continuation, `/goal edit <objective>` to revise it, and `/goal clear` to remove it. Stopping a Goal turn through Agent Bot also pauses the Goal before sending Interrupt so it does not immediately continue.

Use `/newgroup [title]` in Feishu to create a private group named `[agent] [project directory] <title>` and invite the command sender without creating a task. When the title is omitted, use `[agent] [project directory] 新任务 - yy-mm-dd hh:mm`; an explicit title never gets a timestamp suffix. Every new group gets a deterministic scheme-C Identicon avatar: Latin project names display their first word, Chinese names display up to their first four characters, and the normalized full project path hashes into the palette and symmetric node pattern. Projectless groups use the title as the stable seed. Replace the user's home-directory prefix with `~`. The bracketed project-directory value is limited to 15 characters. Longer paths use `...<separator><parent><separator><leaf>`, shortening the two trailing directory names further when necessary. Use `\` on Windows and `/` on macOS/Linux. Do not automatically send a Sessions or Status card to the new group. If the source chat's current task belongs to a project, the new group persists that project as its default; the first ordinary message or `/new` inherits it unless `/new --dir <cwd>` or `/new --nodir` explicitly overrides it.

Use `/forkgroup [title]` in Feishu to fork the current Codex task's latest available completed turn into a newly created private group. Agent Bot invites the command sender and binds the fork as the new group's current task, but does not automatically send a Sessions or Status card there. The source chat keeps its current task, and an active source turn is not interrupted. If the current task has no completed turn yet, Agent Bot rejects the command before creating a group. An explicit title is used without a timestamp suffix in the group name. Without an explicit title, the fork uses the persistent `source title（分支 N）` sequence and keeps the timestamp suffix in the group name.

Use `/new [title] --nodir` to force a new Codex Projectless task even when the current task belongs to a project. `--nodir` and `--dir <cwd>` are mutually exclusive; omitting both preserves the normal project-shape inheritance behavior.

Every task in the Feishu `/sessions` card has a `New` action. It inherits the source task's project directory, model, reasoning effort, and permission mode, creates a new task, and switches the current chat to it without stopping or forking the source task.

Use `/fork [number-or-task-id]` in Feishu to branch from the current or specified Codex task and switch to the new branch. If the source task is running, Agent Bot forks from its latest completed turn and leaves the active turn running; it rejects only when the task has no completed turn yet.

Status cards include a `刷新` action that reads the latest task state and updates the same card in place without switching tasks or sending another card.

Use `/model` in Feishu to show an interactive Card 2.0 model selector for the current task. Each non-current model has the same blue link-style `切换` action used by other Agent Bot cards. After selecting a model, the same card advances to that model's reasoning-mode selector; the selector lists only mode names, has a `返回模型` action, and applies a selected mode from the next request. `/thinking` opens the reasoning selector directly. `/model <name>` and `/thinking <level>` remain available for direct text-based selection.

Messages whose trimmed text starts with `/` are always parsed as Agent Bot commands. Unknown slash commands are reported to the user with a `/help` hint and must never fall through to the model, including slash-prefixed messages that also contain images.

When a group body has a current task, renaming the Feishu group to `[agent-name] new title` also renames that current task if the prefix matches the task's configured agent. Malformed names, agent mismatches, empty groups, and thread-specific tasks are ignored.

Use `--context <key>` or `--status <status>` to narrow `task list`. Use `--config <path>` before the command when controlling a non-default Agent Bot configuration.

## Apply code changes safely

After changing Agent Bot code, run the relevant tests, typecheck, and build. If a running service must pick up the result, schedule:

```powershell
agent-bot server restart --reason "brief description of the completed change"
```

Do not replace the worker immediately while a task is active. A later incoming task must not cancel the pending safe restart; allow the scheduler to wait until the service becomes safely idle again.
