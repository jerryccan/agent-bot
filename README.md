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

- Node.js 20 or later
- Codex CLI installed and available as `codex`
- A completed local Codex login

Check the login:

```powershell
codex login status
```

### Install

Run from the repository root:

```powershell
npm install
npm run build
npm link
```

`npm link` registers the local `agent-bot` command. Without it, use `npm run cli --` before CLI arguments.

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
| `/nosteer <prompt>`                      | Queue a separate follow-up Prompt           |
| `/goal [objective]`                      | View or manage a persistent Goal            |
| `/model [name]`                          | View or change the model                    |
| `/thinking [level]`                      | View or change reasoning effort             |
| `/permissions auto\|confirm`             | Change tool approval behavior               |
| `/newgroup [title]`                      | Create a private group for a new task       |
| `/forkgroup [title]`                     | Fork the current task into a private group  |
| `/agent [name]`                          | View or change the default agent            |
| `/use <agent> [cwd]`                     | Select an agent and create a task           |
| `! <command>`                            | Run a local command in the task directory   |
| `/restart`                               | Gracefully restart Agent Bot                |
| `/help`                                  | Show in-chat help                           |

Private chats, group timelines, and threads keep separate current tasks. You can send an image by itself or together with text. While a task is running, plain text adds instructions to the current work; use `/nosteer` to always create a later turn.

When `/newgroup` omits the title, the default group name is `[agent] [project dir] 新任务 (mm-dd)`. When `/forkgroup` omits the title, its task and group name use the same persistent `source title（分支 N）` sequence as `/fork`, without a date suffix. Feishu group names created by `/newgroup` and `/forkgroup` are capped at 60 displayed characters. When a generated name is too long, Agent Bot truncates only the title portion in the group name; the task title itself stays unchanged.

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
- [Agent Development Guide](AGENTS.md)
