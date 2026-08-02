<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot logo" width="180">
</p>

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
agentbot --version
agentbot --help
```

This installs `agentbot` as the primary command. The legacy `agent-bot` command remains available temporarily, prints a deprecation warning, and will be removed in a future release. Command-line help, status, progress, prompts, and errors follow the system language for Chinese and English locales; all other locales fall back to English. JSON output remains language-neutral and stable. See the [technical reference](docs/technical-reference.md#development-and-source-installation) to install from source.

### Initialize

```powershell
agentbot init
```

Follow the displayed link or scan the QR code to create and authorize the Feishu bot. Initialization prepares `~/.agent-bot`, saves the bot credentials and the authorizing user, checks the required permissions, and starts Agent Bot automatically.

Only a complete app ID and secret saved locally count as a successful bot creation. If initialization is interrupted before both credentials are saved, rerunning `agentbot init` creates a new bot. If credentials were saved, initialization resumes by auditing that bot's remote permissions and subscriptions.

The `im:message.group_msg` permission cannot be added through Feishu's one-click configuration. When it is missing, Agent Bot prints a QR code and a direct Developer Console link already filtered to that permission. Add it manually, publish the app version, and complete tenant approval if required. While Agent Bot waits for it to become active, enter `Y` to skip this permission and continue initialization; the final result warns that ordinary group messages which do not mention the bot will be unavailable.

When optional permissions or subscriptions are missing, Agent Bot first shows their QR code and authorization link, then immediately waits up to five minutes for them to become active. The terminal offers only one choice: enter `Y` to skip optional authorization and continue. Otherwise, complete authorization in the browser while Agent Bot waits. Optional authorization failures or timeouts do not block startup, and Agent Bot reports which features may be unavailable.

| Option                 | Purpose                             |
| ---------------------- | ----------------------------------- |
| `--reset`              | Back up and fully reset an explicitly selected Profile |
| `--skip-feishu`        | Initialize for Console only; do not start the server |
| `--reconfigure-feishu` | Replace existing Feishu credentials |
| `--json`               | Print a machine-readable result     |
| `--profile <directory>`| Use an isolated profile directory   |
| `--config <path>`      | Use a specific configuration file   |

You can rerun `agentbot init` later to check or complete the bot configuration. If the server is already running, initialization leaves it running.

To fully reconfigure a Profile, stop its server and select the Profile explicitly:

```powershell
agentbot --profile ~/.agent-bot init --reset
```

Reset moves the active `config.yaml`, `.env`, `data/`, and `logs/` into a new timestamped directory under `.reset-backups`, then initializes clean replacements. Existing backup directories are retained. The old remote Feishu app is not deleted.

### Start And Stop

```powershell
agentbot server status
```

`agentbot init` starts the server automatically. If you stop it later, run `agentbot server start` to start it again. For local-only use, initialize with `--skip-feishu` and run `agentbot console` instead.

The `Agent Bot 已启动` startup card shows the version of Agent Bot currently running.

Open Feishu, find the bot, and send a message. Agent Bot automatically creates a task for a chat that does not have one yet.

Stop the service with:

```powershell
agentbot server stop
```

### Update Or Uninstall

Stop the running service before replacing or removing the global package:

```powershell
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot server start
```

To uninstall:

```powershell
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

Uninstalling the npm package does not delete your data under `~/.agent-bot`.

## Daily Commands

### Service

```powershell
agentbot server status
agentbot server start
agentbot server stop
agentbot server restart
```

`server restart` waits for current work to finish by default. Its status card includes a `Cancel` button while the restart is still waiting. Use `--immediate` only when interruption is acceptable.

`server status` shows the Lark App ID used by the running server. Add `--json` to read it from `feishuAppId`.

### Console

```powershell
agentbot console
```

The Console UI works without Feishu credentials. It will not share task state with a running server unless `--force` is supplied.

### Tasks

```powershell
agentbot task list
agentbot task status <task>
agentbot task prompt <task> "<prompt>"
agentbot task title <task> "<title>"
agentbot task stop <task>
```

`<task>` can be a number from `task list`, a task ID, or an unambiguous task-ID prefix. Run `agentbot --help` for all CLI options.

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
| `/provider`                              | Open execution settings on the Provider tab |
| `/model`                                 | Open execution settings on the Model tab    |
| `/thinking`                              | Open execution settings on the Thinking tab |
| `/permissions`                           | Open execution settings on the Permission tab |
| `/newgroup [title] [--dir <cwd> \| --nodir]` | Create a private group for a new task       |
| `/forkgroup [title]`                     | Fork the current position into a private group |
| `/agent [name]`                          | Open Agent settings or select the default Agent |
| `! <command>`                            | Run a local command in the task directory   |
| `/restart [--force]`                     | Restart safely, or immediately with `--force` |
| `/help`                                  | Show in-chat help                           |

Slash commands accept any unique prefix, and compound commands accept registered initialisms: `/sess` runs `/sessions`, `/fg` runs `/forkgroup`, `/ng` runs `/newgroup`, and `/ns` runs `/nosteer`. Exact command names take priority. An ambiguous prefix such as `/s` or `/f` is rejected and reports every matching command.

`/agent`, `/provider`, `/model`, `/thinking`, and `/permissions` use the same execution-settings card when there is something to select. When more than one Agent is configured, the card adds an Agent tab for selecting the default Agent used by future tasks; `/agent` opens that tab, including when the chat has no current task. With only one configured Agent, `/agent` reports the current Agent directly instead. Existing tasks keep their original Agent, and tasks using different Agents run independently. `/agent <name>` remains available for direct selection. `/provider` likewise reports the current Provider directly when no alternative Provider is configured. The other four commands activate their matching tabs and do not accept arguments. A task created without inherited settings uses the default Provider from your Codex configuration.

Private chats, group timelines, and threads keep separate current tasks. You can send an image by itself or together with text. While a task is running, plain text adds instructions to the current work; use `/queue` (or `/nosteer`) to always create a later turn.

The `/sessions` card provides `NewGroup` and `ForkGroup` actions for each task, so you can create a project-matched group or fork a selected task directly into a new group.

Inside a thread, `/forkgroup` forks from the thread's original turn until the thread task completes its own turn. After that, it forks from the thread task's latest completed turn. A currently running turn is never used as a fork point.

After `/forkgroup` creates the new group, its welcome message shows the forked task's current Provider, model, reasoning effort, and permission type.

`/new` and `/newgroup` accept the same project options. Pass `--dir <cwd>` to override the inherited project directory, or `--nodir` to force a Projectless Codex task; the two options are mutually exclusive. `~`, `~/...`, and `~\...` resolve from the current user's home directory for both commands. `/newgroup` immediately creates and binds the task in the new group while continuing to inherit the current task's Provider, model, reasoning effort, and permission mode without affecting the source task. If there is no current task, Agent Bot uses the selected agent and its runtime defaults. An explicit title becomes both the group suffix and the task title.

When `/newgroup` omits the title, the task title is `新任务` and the default group name is `[agent] [project dir] 新任务 (mm-dd)`. Projectless groups omit the project segment entirely, using `[agent] title`. When `/forkgroup` omits the title, its task and group name use the same persistent `source title（分支 N）` sequence as `/fork`, without a date suffix. Feishu group names created by `/newgroup` and `/forkgroup` are capped at 60 displayed characters. When a generated name is too long, Agent Bot truncates only the title portion in the group name; the task title itself stays unchanged.

Renaming a bound group to `[agent] [project dir] title` synchronizes only `title` to the current task. The Agent and project-directory prefixes remain group metadata and are never included in the Codex task title. The older `[agent] title` format remains supported.

## Configuration And Data

Agent Bot keeps user-owned files outside the repository:

| Path                       | Purpose                     |
| -------------------------- | --------------------------- |
| `~/.agent-bot/config.yaml` | Agent Bot configuration     |
| `~/.agent-bot/.env`        | Feishu credentials          |
| `~/.agent-bot/data/`       | Task data and cached inputs |
| `~/.agent-bot/logs/`       | Runtime logs                |

Set `AGENT_BOT_HOME` to use another user-data directory. See [config.example.yaml](config.example.yaml) for configuration examples.

By default, Agent Bot responds to ordinary messages in groups containing the bot. Set `feishu.respondToAllGroupMessages` to `false` to require users to @ the bot in groups; private chats are unchanged. Initialization still requests the complete group-message permission set so changing this option later does not require another authorization.

### Multiple Profiles

Commands without `--profile` use the main profile at `~/.agent-bot`. To run another bot with isolated credentials, configuration, data, logs, and local control endpoint, pass its directory explicitly on every command:

```powershell
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
```

Alternative profiles are directory-based and are not registered by name. Each one uses `config.yaml`, `.env`, `data/`, and `logs/` inside the selected directory. `--profile` cannot be combined with `--config`.

## Troubleshooting

- **The bot does not respond:** run `agentbot server status` and check `~/.agent-bot/logs/agent-bot.log`.
- **The Worker restarted after a Node crash:** check `~/.agent-bot/data/last-crash.json`, `~/.agent-bot/logs/worker.stderr.log`, and `~/.agent-bot/data/crash-reports/`.
- **Feishu permissions are incomplete:** rerun `agentbot init` and follow the displayed authorization steps.
- **Codex cannot start:** run `codex login status` as the same operating-system user that runs Agent Bot.
- **You only need local testing:** run `agentbot init --skip-feishu`, then `agentbot console`.
- **A safe restart keeps waiting:** inspect active tasks with `agentbot task list --status running`.

## More Documentation

- [Technical Reference](docs/technical-reference.md): configuration, permissions, routing, persistence, recovery, and runtime behavior
- [Example Configuration](config.example.yaml)
- [Changelog](CHANGELOG.md)
- [Agent Development Guide](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
