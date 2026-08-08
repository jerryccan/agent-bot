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
- Automatically retry temporary model-service failures
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

After these steps, the `~/.agent-bot` directory is initialized and Agent Bot starts automatically. Every successful `agentbot init` sends a private welcome card containing the Agent Bot logo. The first card introduces the main capabilities; after an upgrade it highlights the new version, while a same-version rerun confirms that the Profile was refreshed.

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

It waits for currently running Agent tasks to finish before restarting, allowing every task to complete normally. When triggered from a Feishu topic, both restart status and the post-restart startup card return to that topic.

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

Send a message beginning with `/` to run a command. Use `/help` in Feishu for the latest command list.

| Command                                       | Purpose                              |
| --------------------------------------------- | ------------------------------------ |
| `/new [title] [--dir <path> \| --nodir]`      | Start a new task                     |
| `/dir [path]`                                 | Browse files or start work in a directory |
| `/sessions [keyword]`                         | Find and manage tasks                |
| `/switch [task]`                              | Switch tasks or return to the previous task |
| `/fork [task]`                                | Branch a task                        |
| `/turns`                                      | Restore an earlier conversation turn |
| `/status [task]`                              | View task status                     |
| `/title <title>`                              | Rename the current task              |
| `/stop`                                       | Stop the current execution           |
| `/queue <prompt>`                             | Run a Prompt after the current turn  |
| `/nosteer <prompt>`                           | Same as `/queue`                     |
| `/goal [objective]`                           | Manage a long-running objective      |
| `/provider`                                   | Choose a Provider                    |
| `/model`                                      | Choose a model                       |
| `/thinking`                                   | Set reasoning effort                 |
| `/permissions`                                | Set execution permissions            |
| `/agent [name]`                               | Choose the Agent for new tasks       |
| `/newgroup [title] [--dir <path> \| --nodir]` | Start a task in a new private group  |
| `/forkgroup [title]`                          | Branch a task into a new private group |
| `/restart [--force]`                          | Restart safely, or interrupt with `--force` |
| `/mute [on\|off]`                            | Require @ mentions in the current group |
| `/help`                                       | Show command help                    |

Private chats, group timelines, and topics keep separate current tasks. Ordinary messages sent while a task is running add instructions to that turn; use `/queue` when the message should run afterward as a separate turn.

In a group, `/mute` and `/mute on` make the bot process only messages that mention it. Mention the bot and send `/mute off` to restore automatic responses. The setting applies to every topic in that group.

`/new` and `/newgroup` inherit the current Agent, project, and execution settings. Use `--dir` to choose another directory or `--nodir` to start without a project directory; `~` represents your home directory.

`/fork` and `/forkgroup` branch from completed work without interrupting a running turn. `/sessions` manages tasks across projects, while `/turns` restores conversation context without reverting local files.

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

By default, `feishu.respondToOwnerOnly: true` accepts only messages and card actions from the bot owner identified by `feishu.userOpenId`; other users are ignored before any processing reaction is added. Set it to `false` to allow collaborators. When enabled without an owner Open ID, all Feishu user input is ignored until the owner is configured.

Agent Bot responds to ordinary owner messages in groups containing the bot. Set `feishu.respondToAllGroupMessages` to `false` to additionally require the owner to @ the bot in groups; private chats are unchanged. Initialization still requests the complete group-message permission set so changing this option later does not require another authorization.

Thinking cards use the grouped layout by default: auxiliary Commentary and user steering remain visible, while each execution group shows only its latest native reasoning and expands to reveal complete tool commands and results. Execution groups start collapsed and keep stable component identities so a group manually opened in Feishu stays open across card updates. On long turns, pagination measures the fully rendered card content instead of using fixed message or tool counts. Set `feishu.thinkingCardLayout` to `timeline` to temporarily restore the original layout.

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
