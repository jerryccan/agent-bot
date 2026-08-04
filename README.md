<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot Logo" width="180">
</p>

# Agent Bot

Use local Codex, TraeX, and compatible ACP agents through Feishu.

English | [简体中文](README.zh.md)

Agent Bot runs on your computer and connects a Feishu bot to your local coding agents. Send a message to start working; the bot updates a progress card while the agent runs and sends the final answer as Markdown.

## What You Can Do

- Use your existing local Codex or TraeX login from Feishu
- Create, continue, switch, fork, and stop tasks
- Reset the current conversation from any successfully completed progress card
- Collaborate with text, images, group chats, and topics
- Queue follow-up Prompts or add instructions while a task is running
- Continue existing work after Agent Bot restarts
- Run through the local Console UI without Feishu

## Quick Start

### Requirements

- Node.js 22 or later
- At least one supported App Server Agent: Codex or TraeX
- A completed local login for the Agent you plan to use

Check the installed Agents and their login status:

```bash
codex --version
codex login status
traex --version
traex login status
```

You can continue once either Codex or TraeX is ready. `agentbot init` checks both and can help install or upgrade them.

### Install

```bash
# Install the stable version
npm install --global @keyou007/agent-bot
# Install the Alpha version to try the latest features
# npm install --global @keyou007/agent-bot@alpha
agentbot --version
agentbot --help
```

See the [technical reference](docs/technical-reference.md#development-and-source-installation) to install from source.

### Initialize

```bash
agentbot init
```

Initialization detects Codex and TraeX and reports their installed versions. Missing or outdated Agents are listed with the appropriate install or upgrade commands. Agent Bot saves its configuration to `~/.agent-bot/config.yaml`.

A fresh initialization normally presents three QR-code or link steps in the terminal.

1. **Create the bot.** This creates a Feishu app with the standard basic messaging configuration and saves its App ID, App Secret, and authorizing user. This step cannot be skipped because Agent Bot cannot connect to Feishu without it. Permissions already provided during creation are not repeated below.
2. **Add the all-group-message permission.** The only additional core permission needed after bot creation is `im:message.group_msg`. It lets Agent Bot receive ordinary group messages that do not @ the bot. Feishu requires this permission to be added manually in the Developer Console. Enter `Y` to skip waiting; private chats still work without it, but group users must @ the bot.
3. **Add the remaining event and callback.** The bot-creation template already provides the other permissions Agent Bot needs. The third step adds only:

    | Type | Event or callback | Purpose |
    | ---- | ----------------- | ------- |
    | Event | `im.chat.updated_v1` | Detect group renames and synchronize them to Agent task titles. |
    | Callback | `card.action.trigger` | Enable card button interactions. |

After these steps, the `~/.agent-bot` directory is initialized. Agent Bot starts automatically and sends you a welcome message through the Feishu bot, so you can begin using it in Feishu.

Agent Bot includes a keepalive mechanism that automatically reconnects after Agent Bot, Codex, or TraeX crashes.

### Start And Stop

Start the service:

```bash
# agentbot init starts the Server automatically, so manual startup is usually unnecessary.
agentbot server start
```

Check the service status:

```bash
agentbot server status
```

Stop the service:

```bash
agentbot server stop
```

Safely restart the service:

```bash
agentbot server restart
```

It waits for currently running Agent tasks to finish before restarting, allowing every task to complete normally.

### Update Or Uninstall

Stop the running service before replacing or removing the global package:

```bash
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot init # Update the Profile and start the Server
```

To uninstall:

```bash
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

Uninstalling the npm package does not delete user data under `~/.agent-bot`.

### Multiple Profiles

Multiple Profiles let you run several independent Agent Bot instances on the same device without interfering with one another.

Create a new Profile with:

```bash
# Select a new Profile directory and initialize a new bot
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
```

Commands without `--profile` use the main Profile at `~/.agent-bot`.

Each Profile stores its own `config.yaml`, `.env`, `data/`, and `logs/` in the selected directory. Feishu credentials and local control endpoints are isolated as well.

### Reset A Profile

To completely reconfigure an existing Profile, stop its Server and select the Profile explicitly:

```bash
agentbot --profile ~/.agent-bot server stop # Stop the main Profile Server
agentbot --profile ~/.agent-bot init --reset # Reset the main Profile
```

Reset moves the current `config.yaml`, `.env`, `data/`, and `logs/` into `.reset-backups`, then creates clean files and directories. Existing backups are retained permanently and are not overwritten or cleaned by later resets. The old remote Feishu app is not deleted.

Reset does not remove Codex or TraeX chat sessions. It only recreates the Feishu bot and clears Agent Bot's local data.

## Daily Commands

### Console UI/TUI

```bash
agentbot console
```

The Console UI does not require Feishu credentials. It does not share task state with a running Server unless `--force` is supplied.

### Task Management

```bash
agentbot task list
agentbot task current [--json]
agentbot task status <task>
agentbot task prompt <task> "<prompt>"
agentbot task newgroup <task> [title] [--agent <standard-name>] [--dir <path> | --nodir]
agentbot task forkgroup <task> [title]
agentbot task title <task> "<title>"
agentbot task stop <task>
```

`task current` shows details for the Codex or TraeX task currently invoking the CLI. Its JSON output includes Agent Bot's `localSessionId` and the native `remoteSessionId`. `<task>` can be a number from `task list`, a task ID, or an unambiguous task-ID prefix. Run `agentbot --help` for all CLI options.

`task newgroup` creates a Feishu group and a new task. By default, it inherits the source task's Agent and execution settings. `--agent <standard-name>` selects another configured Agent; the source project shape is still inherited, while Provider, model, reasoning effort, and permission mode use the target Agent's own Runtime defaults. `--dir` overrides the project directory and supports `~`; `--nodir` forces a Projectless App Server task. `task forkgroup` forks from the source task's latest available completed turn without interrupting an active turn. Both commands require the Server to be running, invite the authorizing user saved in the Profile, leave the source conversation on its current task, and support `--json`.

## Feishu Commands

Enter a message beginning with `/` directly in the Feishu chat box to run a command.

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
| `/restart [--force]`                    | Restart safely, or immediately with `--force` |
| `/help`                                 | Show in-chat help                           |

Slash commands accept any unique prefix, and compound commands accept registered initialisms: `/sess` runs `/sessions`, `/fg` runs `/forkgroup`, `/ng` runs `/newgroup`, and `/ns` runs `/nosteer`. Exact command names take priority. An ambiguous prefix such as `/s` or `/f` is rejected and lists every matching command.

Private chats, group timelines, and topics maintain separate current tasks. You can send an image by itself or together with text. While a task is running, plain text adds instructions; use `/queue` (or `/nosteer`) when you need to guarantee a later turn.

The `/sessions` card shows five tasks per page and uses `Previous` and `Next` to update the card in place. Each task provides `NewGroup` and `ForkGroup` actions, so you can create a same-project group or fork the selected task directly into a new group.

`/turns` opens the current task's completed-turn history, with 10 turns per page. Each turn has its own numbered node and indented content. Graph lanes follow the actual parent turns, preserve Reset branches and merges across pages, and do not connect turns merely because their completion times are adjacent. The active conversation point is marked `Current`; every other entry has a `Reset` button that restores the conversation context to that completed turn and moves the marker there without reverting local files. The success notice shows the selected Prompt summary, completion time, and Turn ID. Turns completed after the selected point remain in history, and turns created on the new branch after Reset are shown as well. Reset is unavailable while the task is running.

Inside a topic, `/forkgroup` forks from the topic's original turn until the topic task has completed a turn of its own. After that, it forks from the topic task's latest completed turn. A running turn is never used as a fork point.

After `/forkgroup` creates a new group, its welcome message shows the forked task's current Provider, model, reasoning effort, and permission type.

`/new` and `/newgroup` support the same project options. Use `--dir <cwd>` to override the inherited project directory, or `--nodir` to force a Projectless App Server task; the two options cannot be combined. In both commands, `~`, `~/...`, and `~\...` represent the current user's home directory. `/newgroup` immediately creates and binds the task in the new group while continuing to inherit the current task's Provider, model, reasoning effort, and permission mode without affecting the source task. If the source chat has no current task, Agent Bot uses the selected Agent and its Runtime defaults. An explicit title becomes both the group-name suffix and the task title.

When `/newgroup` omits the title, the task title and the title portion of the group name both use `新任务 (mm-dd)`, producing `[agent] [project dir] 新任务 (mm-dd)`. Projectless groups omit the project segment entirely and use `[agent] title`. When `/forkgroup` omits the title, its task and group name use the same persistent `source title（分支 N）` sequence as `/fork`, without a date suffix. Feishu group names created by `/newgroup` and `/forkgroup` display at most 60 characters. If the generated name is too long, Agent Bot truncates only the title portion of the group name; the task title itself remains unchanged.

Renaming a bound group to `[agent] [project dir] title` synchronizes only `title` to the current task. The Agent and project-directory prefixes remain group metadata and are never included in the task title. The older `[agent] title` format remains supported.

## Local Commands

Enter a message beginning with `!` directly in the Feishu chat box to run a local command in the current task directory.

For example, `! ls` lists files in the current directory, and `! git status` shows the state of the current Git repository.

## Configuration And Data

Agent Bot keeps user-owned files outside the repository:

| Path                       | Purpose                     |
| -------------------------- | --------------------------- |
| `~/.agent-bot/config.yaml` | Agent Bot configuration     |
| `~/.agent-bot/.env`        | Feishu credentials          |
| `~/.agent-bot/data/`       | Task data and cached inputs |
| `~/.agent-bot/logs/`       | Runtime logs                |

Set `AGENT_BOT_HOME` to use another user-data directory. See [config.example.yaml](config.example.yaml) for configuration examples.

Agent processes inherit ordinary parent-process variables and their explicit `agents.<name>.env` settings. Before starting an Agent, Agent Bot removes inherited `FEISHU_*` credentials and internal `AGENT_BOT_*` state, then provides only namespaced, non-secret Profile and Lark identity context. `FEISHU_APP_SECRET` is never forwarded to an Agent process.

By default, Agent Bot responds to ordinary messages in groups containing the bot. Set `feishu.respondToAllGroupMessages` to `false` to require users to @ the bot in groups; private chats are unchanged. Initialization still requests the complete group-message permission set so changing this option later does not require another authorization.

## Troubleshooting

- **The bot does not respond:** run `agentbot server status` and check `~/.agent-bot/logs/agent-bot.log`
- **The Worker restarted after a Node crash:** check `~/.agent-bot/data/last-crash.json`, `~/.agent-bot/logs/worker.stderr.log`, and `~/.agent-bot/data/crash-reports/`
- **Feishu permissions are incomplete:** rerun `agentbot init` and follow the displayed authorization steps
- **An Agent cannot start:** run `codex login status` or `traex login status` as the same operating-system user that runs Agent Bot, then rerun `agentbot init` to check its version
- **You only need local testing:** run `agentbot init --skip-feishu`, then run `agentbot console`
- **A safe restart keeps waiting:** inspect active tasks with `agentbot task list --status running`

## More Documentation

- [Technical Reference](docs/technical-reference.md): configuration, permissions, routing, persistence, recovery, and runtime behavior
- [Example Configuration](config.example.yaml)
- [Changelog](CHANGELOG.md)
- [Agent Development Guide](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
