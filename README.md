# Agent Bot

Use local Codex and ACP agents directly from Feishu.

English | [简体中文](README.zh.md)

Agent Bot runs on your computer and connects a Feishu bot to your local Codex environment. Send a message to start working; the bot updates a progress card while the agent runs and sends the final answer as Markdown.

## What You Can Do

- Use your existing local Codex login from Feishu
- Create, continue, switch, fork, and stop tasks
- Work with text, images, groups, and threads
- Queue follow-up Prompts or add instructions while a task is running
- Resume work after Agent Bot restarts
- Use a local Console UI without Feishu

## Quick Start

### Requirements

- Node.js 22 or later
- Codex CLI installed and available as `codex`
- A completed local Codex login

Check the login:

```powershell
codex login status
```

### Install

```powershell
npm install --global @keyou007/agent-bot
```

This installs the `agent-bot` command globally. See the [technical reference](docs/technical-reference.md#development-and-source-installation) to install from source.

### Initialize

```powershell
agent-bot init
```

Follow the displayed link or scan the QR code to create and authorize the Feishu bot. Initialization prepares `~/.agent-bot`, saves the bot credentials, and checks the required permissions.

Missing optional permissions do not block initialization. Agent Bot reports which features may be unavailable.

| Option                 | Purpose                             |
| ---------------------- | ----------------------------------- |
| `--skip-feishu`        | Initialize for Console-only use     |
| `--reconfigure-feishu` | Replace existing Feishu credentials |
| `--json`               | Print a machine-readable result     |
| `--config <path>`      | Use a specific configuration file   |

You can rerun `agent-bot init` later to check or complete the bot configuration.

### Start

```powershell
agent-bot server start
agent-bot server status
```

Open Feishu, find the bot, and send a message. Agent Bot automatically creates a task for a chat that does not have one yet.

Stop the service with:

```powershell
agent-bot server stop
```

### Update Or Uninstall

Stop the running service before replacing or removing the global package:

```powershell
agent-bot server stop
npm install --global @keyou007/agent-bot@latest
agent-bot server start
```

To uninstall:

```powershell
agent-bot server stop
npm uninstall --global @keyou007/agent-bot
```

Uninstalling the npm package does not delete your data under `~/.agent-bot`.

## Daily Commands

### Service

```powershell
agent-bot server status
agent-bot server start
agent-bot server stop
agent-bot server restart
```

`server restart` waits for current work to finish by default. Use `--immediate` only when interruption is acceptable.

### Console

```powershell
agent-bot console
```

The Console UI works without Feishu credentials. It will not share task state with a running server unless `--force` is supplied.

### Tasks

```powershell
agent-bot task list
agent-bot task status <task>
agent-bot task prompt <task> "<prompt>"
agent-bot task title <task> "<title>"
agent-bot task stop <task>
```

`<task>` can be a number from `task list`, a task ID, or an unambiguous task-ID prefix. Run `agent-bot --help` for all CLI options.

## Feishu Commands

Plain text continues the current task. Messages beginning with `/` are commands.

| Command                                  | Purpose                                     |
| ---------------------------------------- | ------------------------------------------- |
| `/new [title] [--dir <path> \| --nodir]` | Create a task                               |
| `/sessions [keyword]`                    | Browse available Codex tasks                |
| `/switch [task]`                         | Switch tasks or return to the previous task |
| `/fork [task]`                           | Create and open a task branch               |
| `/status [task]`                         | View task progress and results              |
| `/title <title>`                         | Rename the current task                     |
| `/stop`                                  | Stop the current execution                  |
| `/queue <prompt>`                        | Queue a separate follow-up Prompt           |
| `/nosteer <prompt>`                      | Same as `/queue`                            |
| `/goal [objective]`                      | View or manage a persistent Goal            |
| `/model [name]`                          | View or change the model                    |
| `/thinking [level]`                      | View or change reasoning effort             |
| `/permissions auto\|confirm`             | Change tool approval behavior               |
| `/newgroup [title]`                      | Create a private group for a new task       |
| `/forkgroup [title]`                     | Fork the current position into a private group |
| `/agent [name]`                          | View or change the default agent            |
| `/use <agent> [cwd]`                     | Select an agent and create a task           |
| `! <command>`                            | Run a local command in the task directory   |
| `/restart`                               | Gracefully restart Agent Bot                |
| `/help`                                  | Show in-chat help                           |

Private chats, group timelines, and threads keep separate current tasks. You can send an image by itself or together with text. While a task is running, plain text adds instructions to the current work; use `/queue` (or `/nosteer`) to always create a later turn.

Inside a thread, `/forkgroup` forks from the thread's original turn until the thread task completes its own turn. After that, it forks from the thread task's latest completed turn. A currently running turn is never used as a fork point.

`/newgroup` immediately creates a new task in the new group. It inherits the current task's project directory, model, reasoning effort, and permission mode without affecting the source task. If there is no current task, Agent Bot uses the selected agent and its runtime defaults. An explicit title becomes both the group suffix and the task title.

When `/newgroup` omits the title, the task title is `新任务` and the default group name is `[agent] [project dir] 新任务 (mm-dd)`. When `/forkgroup` omits the title, its task and group name use the same persistent `source title（分支 N）` sequence as `/fork`, without a date suffix. Feishu group names created by `/newgroup` and `/forkgroup` are capped at 60 displayed characters. When a generated name is too long, Agent Bot truncates only the title portion in the group name; the task title itself stays unchanged.

## Configuration And Data

Agent Bot keeps user-owned files outside the repository:

| Path                       | Purpose                     |
| -------------------------- | --------------------------- |
| `~/.agent-bot/config.yaml` | Agent Bot configuration     |
| `~/.agent-bot/.env`        | Feishu credentials          |
| `~/.agent-bot/data/`       | Task data and cached inputs |
| `~/.agent-bot/logs/`       | Runtime logs                |

Set `AGENT_BOT_HOME` to use another user-data directory. See [config.example.yaml](config.example.yaml) for configuration examples.

## Troubleshooting

- **The bot does not respond:** run `agent-bot server status` and check `~/.agent-bot/logs/agent-bot.log`.
- **Feishu permissions are incomplete:** rerun `agent-bot init` and follow the displayed authorization steps.
- **Codex cannot start:** run `codex login status` as the same operating-system user that runs Agent Bot.
- **You only need local testing:** run `agent-bot init --skip-feishu`, then `agent-bot console`.
- **A safe restart keeps waiting:** inspect active tasks with `agent-bot task list --status running`.

## More Documentation

- [Technical Reference](docs/technical-reference.md): configuration, permissions, routing, persistence, recovery, and runtime behavior
- [Example Configuration](config.example.yaml)
- [Changelog](CHANGELOG.md)
- [Agent Development Guide](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
