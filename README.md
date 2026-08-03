<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot logo" width="180">
</p>

# Agent Bot

Use Codex, TraeX, and compatible ACP agents directly from Feishu.

English | [简体中文](README.zh.md)

Agent Bot runs on your computer and connects a Feishu bot to your local coding agents. Send a message to start working; the bot updates a progress card while the agent runs and sends the final answer as Markdown.

## What You Can Do

- Use your existing local Codex or TraeX login from Feishu
- Create, continue, switch, fork, and stop tasks
- Reset the current conversation to any successfully completed progress card
- Work with text, images, groups, and threads
- Queue follow-up Prompts or add instructions while a task is running
- Resume work after Agent Bot restarts
- Use a local Console UI without Feishu

## Quick Start

### Requirements

- Node.js 22 or later
- At least one supported App Server Agent: Codex or TraeX
- A completed local login for the Agent you intend to use

Check the installed Agents and login state:

```powershell
codex --version
codex login status
traex --version
traex login status
```

You can continue to initialization when either Codex or TraeX is ready. `agentbot init` checks both Agents and can help install or upgrade either one.

### Install

```powershell
npm install --global @keyou007/agent-bot
agentbot --version
agentbot --help
```

To try the current Alpha channel without replacing npm's stable `latest` tag:

```powershell
npm install --global @keyou007/agent-bot@alpha
```

This installs `agentbot` as the primary command. The legacy `agent-bot` command remains available temporarily, prints a deprecation warning, and will be removed in a future release. Command-line help, status, progress, prompts, and errors follow the system language for Chinese and English locales; all other locales fall back to English. JSON output remains language-neutral and stable. See the [technical reference](docs/technical-reference.md#development-and-source-installation) to install from source.

### Initialize

```powershell
agentbot init
```

Initialization detects Codex and TraeX and reports their installed versions. Missing or outdated Agents are summarized once with their exact install or upgrade commands. Enter one or more action numbers separated by commas, enter `all`, or press Enter to skip maintenance. A failed command does not block the remaining initialization steps. After these checks, select the default Agent by number or standard name; when the current default is still available, press Enter to confirm it. Agent Bot saves the selection to `defaults.agent` in `config.yaml` for future tasks.

Then follow the displayed link or scan the QR code to create and authorize the Feishu bot. Initialization prepares `~/.agent-bot`, saves the bot credentials and the authorizing user, checks the required permissions, and starts Agent Bot automatically.

Only a complete app ID and secret saved locally count as a successful bot creation. If initialization is interrupted before both credentials are saved, rerunning `agentbot init` creates a new bot. If credentials were saved, initialization resumes by auditing that bot's remote permissions and subscriptions.

If an existing bot has an App ID and secret but no `FEISHU_USER_OPEN_ID`, Agent Bot fills it automatically from the first direct message sent to the bot. The value is stored in the Profile's `.env` and is never replaced by later messages. Group messages cannot claim this default user.

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

After upgrading Agent Bot, rerun `agentbot init` to refresh the Profile. It preserves existing values in `config.yaml` and `.env`, fills settings and environment variables added by the current version, lets you confirm or change the default Agent, and rechecks the Agents and bot configuration. If the server is already running, initialization schedules a safe restart so the current Agent Bot version and refreshed configuration take effect after active work finishes. In a non-interactive terminal, `init` cannot ask for a selection and keeps the already configured default Agent.

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

The `Agent Bot 已启动` startup card shows the version currently running. It is sent to every known private chat, groups active in the previous minute, and every group enrolled for the current safe restart; topic routes receive it in their parent group.

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

`server restart` waits for current work to finish by default. Its status card includes a `Cancel` button while the restart is still waiting. Every conversation that triggers the pending restart and every conversation active during the previous minute receives the waiting status and restarting notice. Once included, a conversation stays in the notification set until that restart finishes. When restarting for a specific task, use `--task <task>` to add that task's Lark conversation. Use `--immediate` only when interruption is acceptable.

On Windows, every Supervisor and Worker launch reloads the latest Machine and User environment variables. Restart the service after changing `PATH` or another system environment variable; the active Profile selection remains isolated.

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
agentbot task newgroup <task> [title] [--agent <name>] [--dir <path> | --nodir]
agentbot task forkgroup <task> [title]
agentbot task title <task> "<title>"
agentbot task stop <task>
```

`<task>` can be a number from `task list`, a task ID, or an unambiguous task-ID prefix. Run `agentbot --help` for all CLI options.

`task newgroup` creates a Feishu group and a new task. By default it inherits the source task's Agent and execution settings. `--agent <standard-name>` selects another configured Agent; the source project shape is still inherited, while the selected Agent uses its own runtime defaults for Provider, model, reasoning effort, and permission mode. `--dir` overrides the project directory and supports `~`; `--nodir` forces a Projectless App Server task. `task forkgroup` forks the source task's latest available completed turn without interrupting an active turn. Both commands require the Server to be running, invite the Profile's saved authorizing user, leave the source chat on its current task, and support `--json`.

## Feishu Commands

Plain text continues the current task. Messages beginning with `/` are commands.

| Command                                  | Purpose                                     |
| ---------------------------------------- | ------------------------------------------- |
| `/new [title] [--dir <path> \| --nodir]` | Create a task                               |
| `/sessions [keyword]`                    | Browse available App Server tasks           |
| `/switch [task]`                         | Switch tasks or return to the previous task |
| `/fork [task]`                           | Create and open a task branch               |
| `/turns`                                 | Browse historical turns and reset the conversation |
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

`/agent`, `/provider`, `/model`, `/thinking`, and `/permissions` use the same execution-settings card when there is something to select. When more than one Agent is configured, the card adds an Agent tab for selecting the default Agent used by future tasks; `/agent` opens that tab, including when the chat has no current task. With only one configured Agent, `/agent` reports the current Agent directly instead. Existing tasks keep their original Agent, and tasks using different Agents run independently. `/agent <name>` remains available for direct selection. `/provider` likewise reports the current Provider directly when no alternative Provider is configured. The other four commands activate their matching tabs and do not accept arguments. A task created without inherited settings uses the selected Agent's default Provider.

Private chats, group timelines, and threads keep separate current tasks. You can send an image by itself or together with text. While a task is running, plain text adds instructions to the current work; use `/queue` (or `/nosteer`) to always create a later turn.

The `/sessions` card shows five tasks per page and uses `Previous` and `Next` to update the card in place. It provides `NewGroup` and `ForkGroup` actions for each task, so you can create a project-matched group or fork a selected task directly into a new group.

`/turns` opens the current task's completed-turn history, 10 turns per page. Each turn is an indented numbered node in a compact commit graph whose lanes follow the actual parent turns, including branches and merges created by Reset. The active conversation point is marked as `Current`; every other entry has a `Reset` action that restores the conversation context to that completed turn and moves the marker there without reverting local file changes. The success notice identifies the selected Prompt, completion time, and Turn ID. Turns completed after the selected point remain in the history, alongside turns later completed on the new branch. Reset is unavailable while the task is running.

Inside a thread, `/forkgroup` forks from the thread's original turn until the thread task completes its own turn. After that, it forks from the thread task's latest completed turn. A currently running turn is never used as a fork point.

After `/forkgroup` creates the new group, its welcome message shows the forked task's current Provider, model, reasoning effort, and permission type.

`/new` and `/newgroup` accept the same project options. Pass `--dir <cwd>` to override the inherited project directory, or `--nodir` to force a Projectless App Server task; the two options are mutually exclusive. `~`, `~/...`, and `~\...` resolve from the current user's home directory for both commands. `/newgroup` immediately creates and binds the task in the new group while continuing to inherit the current task's Provider, model, reasoning effort, and permission mode without affecting the source task. If there is no current task, Agent Bot uses the selected agent and its runtime defaults. An explicit title becomes both the group suffix and the task title.

When `/newgroup` omits the title, both the task title and the group-title portion use `新任务 (mm-dd)`, producing the default group name `[agent] [project dir] 新任务 (mm-dd)`. Projectless groups omit the project segment entirely, using `[agent] title`. When `/forkgroup` omits the title, its task and group name use the same persistent `source title（分支 N）` sequence as `/fork`, without a date suffix. Feishu group names created by `/newgroup` and `/forkgroup` are capped at 60 displayed characters. When a generated name is too long, Agent Bot truncates only the title portion in the group name; the task title itself stays unchanged.

Renaming a bound group to `[agent] [project dir] title` synchronizes only `title` to the current task. The Agent and project-directory prefixes remain group metadata and are never included in the task title. The older `[agent] title` format remains supported.

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
- **An Agent cannot start:** run `codex login status` or `traex login status` as the same operating-system user that runs Agent Bot, then rerun `agentbot init` to check its version.
- **You only need local testing:** run `agentbot init --skip-feishu`, then `agentbot console`.
- **A safe restart keeps waiting:** inspect active tasks with `agentbot task list --status running`.

## More Documentation

- [Technical Reference](docs/technical-reference.md): configuration, permissions, routing, persistence, recovery, and runtime behavior
- [Example Configuration](config.example.yaml)
- [Changelog](CHANGELOG.md)
- [Agent Development Guide](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
