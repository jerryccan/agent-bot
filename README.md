# Agent Bot: Use Local Codex from Feishu

English | [简体中文](README.zh.md)

Agent Bot connects a local Codex App Server to a Feishu bot and keeps a parallel command-line interface for testing. Feishu is the primary interface: each request creates a single progress card that updates in place, followed by a separate final Markdown response when the task completes.

## Prerequisites

- Node.js 20+
- Codex CLI installed and available as `codex` on the host machine
- A completed Codex login under the same operating-system user that runs Agent Bot

Check the login status:

```powershell
codex login status
```

App Server reuses the local Codex login directly. Neither the bot user nor the Feishu user needs to sign in to ChatGPT again. When running Agent Bot under a service account, make sure it uses the same `CODEX_HOME` and credentials directory as the account that logged in to Codex.

## System Skill

The project includes a standard Agent Bot skill that can be registered in the system-wide `~/.agents/skills` directory through the CLI:

```powershell
agent-bot skills install
agent-bot skills status
agent-bot skills uninstall
```

`register` and `unregister` are aliases for `install` and `uninstall`, respectively. Registration creates a managed copy: updating replaces the previous managed version, while unregistering never removes a same-named directory that Agent Bot did not create. Use `--target <skills-directory>` or `AGENT_BOT_SKILLS_DIR` to select a different skills root.

## Start Agent Bot

```powershell
npm install
npm run build
npm link
agent-bot init
# Fill in ~/.agent-bot/.env before enabling Feishu
agent-bot server start
```

`agent-bot init` prepares the first-run environment. It creates the Agent Bot home, `config.yaml`, `.env`, `data/`, and `logs/`, using the bundled example files as templates. The command is idempotent: existing configuration and environment files are reported but never overwritten. It respects `AGENT_BOT_HOME`, `AGENT_BOT_CONFIG`, and `--config <path>`. Add `--json` for structured output.

Edit `~/.agent-bot/.env` as needed before starting the server. `agent-bot server start` launches Agent Bot through a detached resident supervisor. The supervisor automatically restarts Agent Bot after an unexpected exit and applies exponential backoff from 1 to 30 seconds after repeated crashes to avoid a tight crash loop. `npm start` runs the supervisor in the current terminal. For development, use `npm run dev` to run a single process directly.

## Agent Bot CLI

After building, register the local `agent-bot` command through npm or invoke it with `npm run cli --`:

```powershell
npm run build
npm link
agent-bot --help
# Without npm link: npm run cli -- server status
```

Run `agent-bot init` once after installation. It is safe to run again to create any missing paths without changing existing user files.

Console UI:

```powershell
agent-bot console
```

By default, the Console UI refuses to compete with a running server for the same task state. Use `agent-bot console --force` only when concurrent access is intentional and you understand the risks.

Server management:

```powershell
agent-bot server status
agent-bot server start
agent-bot server stop
agent-bot server restart                         # Safe restart by default
agent-bot server restart --safe --reason "Deploy card updates"
agent-bot server restart --immediate --reason "Recover a stuck worker"
```

A safe restart waits for all group-chat, thread, and private-chat tasks to finish, confirms that final responses have been delivered, and then requires 15 consecutive seconds without a new message before restarting. New work during this period resets the idle timer. `--immediate` (or `--force`) skips the idle checks and is intended only for cases where the worker must be replaced immediately.

Task inspection and management:

```powershell
agent-bot task list
agent-bot task list --status running
agent-bot task list --context "chat_id:oc_xxx"
agent-bot task chat 019f...
agent-bot task chat 2 --json
agent-bot task status 2
agent-bot task status 019f... --json
agent-bot task stop 019f...
agent-bot task title 2 "New task title"
agent-bot task prompt 2 "Continue running the tests and report the result"
```

`task chat <number-or-task-id>` prints the Feishu chat or conversation ID from a task's persisted message route, which makes it convenient for scripts. Plain output contains only the `chat_id`; `--json` also includes the task ID, full `contextKey`, and, for a thread-bound task, its `threadId`. This command only reads local state and does not require the Agent Bot server to be running.

Numeric references follow the current `task list` order. A task can also be identified by its full local ID, an unambiguous local-ID prefix, or its Codex task ID. Query commands read persisted state directly; stop, rename, and Prompt operations use the running worker's local control endpoint. `task prompt` does not switch the current task in any chat. The bot first posts the Prompt text to the task's most recent group, thread, or private-chat route and submits it to the task only after delivery succeeds. The thinking card and final response continue on that same route.

Set the following values in `~/.agent-bot/.env`:

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
# Optional: defaults to ~/.agent-bot/config.yaml
# AGENT_BOT_CONFIG=~/.agent-bot/config.yaml
```

By default, Agent Bot starts both:

- A Feishu WebSocket connection when credentials are configured
- A local test terminal when `console.enabled: true`

Each entry point maintains its own current task, so they do not switch each other's sessions. Codex can still be tested from the terminal when Feishu credentials are not configured.

## Codex Configuration

Agent Bot stores user configuration under `~/.agent-bot` by default. Set `AGENT_BOT_HOME` to choose another root. When `AGENT_BOT_CONFIG` is not explicitly set, the first run creates and loads `~/.agent-bot/config.yaml`. The repository keeps `config.example.yaml` as a configuration example; copy it to `~/.agent-bot/config.yaml` and customize it as needed. The default configuration includes:

```yaml
console:
  enabled: true

agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args:
      - "app-server"
      - "--enable"
      - "goals"
      - "--listen"
      - "stdio://"
    env: {}

defaults:
  agent: "codex"
  cwd: "."

storage:
  sqlitePath: "./data/agent-bot.sqlite"

logging:
  level: "info"
  path: "./logs/agent-bot.log"
```

Relative `storage.sqlitePath` and `logging.path` values are resolved against the directory containing the configuration file. The default SQLite database is therefore `~/.agent-bot/data/agent-bot.sqlite`, and the default log file is `~/.agent-bot/logs/agent-bot.log`. `cwd` is the default working directory for ACP agents and remains relative to the directory from which Agent Bot was started. Creating a Codex task without a directory for the first time creates a true Projectless task under `~/Documents/Codex/<date>/<task-name>`, which Codex Desktop recognizes in its Tasks list. When a current task already exists, `/new` without arguments preserves its project shape: project tasks reuse the current project directory, while Projectless tasks create a new Projectless workspace. Use `/new New task --dir D:\dev\project` to provide both a title and a project directory. The working directory of an existing task never changes while it is running.

Every Codex or ACP agent process started by Agent Bot receives `AGENT_BOT=1`, allowing the agent to detect that it is running under Agent Bot.

## Feishu App Configuration

An enterprise custom app must:

- Enable bot capability
- Receive events through a persistent connection
- Subscribe to `im.message.receive_v1`
- Subscribe to `card.action.trigger`
- Have the permissions required to receive and send bot messages, send cards, and update messages
- Have `im:message.reactions:write_only` to add and replace message-processing status reactions
- Have `im:message:readonly` to download images from user messages

Message behavior:

- After a message is received and deduplicated, Agent Bot adds an `OnIt` reaction to the original message. It replaces that reaction with `DONE` on success, `ERROR` on failure, or `CrossMark` on cancellation. Message-to-Codex-turn bindings are persisted so the terminal reaction can still be applied after restart recovery. Reaction failures do not block task processing.
- Private chats and the main timeline of each group independently isolate their current tasks by `chat_id`. In a group timeline, text following an @ mention of the bot is processed as a command or Prompt. The bot replies directly in the group timeline and does not create a thread automatically.
- Private and group chats share the same thread behavior: whenever an incoming message has a `thread_id`, that thread owns an independent current task. Commands, card callbacks, thinking cards, and final responses all remain in the thread.
- When a user starts a thread from a user message, thinking card, or final response, the first message in that thread creates an independent task through Codex `thread/fork` from the source turn. If the source turn is still running or cannot be mapped, Agent Bot reports the problem instead of guessing a fork point. The new task receives the literal suffix `（分支 N）`, producing a title such as `Source task（分支 1）`.
- Sending plain text automatically creates a Codex thread when no current task exists.
- A user can send one image directly or combine text and images in a single rich-text message. Images are cached in `inbound-images` next to the SQLite database and passed to Codex as `localImage` inputs. An image-only message uses the literal Prompt `请分析这张图片。` ("Please analyze this image."). If an ACP agent does not support image input, Agent Bot reports the limitation instead of silently discarding the image.
- Text received while Codex is running is appended to the current turn through steering. If the turn completes at the same moment, the text is automatically queued as the next request.
- `/nosteer <prompt>` skips steering and persistently queues the Prompt for a later turn on the current task. A compact queue card allows each item to be canceled, and multiple Prompts run in FIFO order.
- Each turn has exactly one progress card. Normal updates are limited to once every 2 seconds, while critical state changes have a minimum interval of 500 ms.
- The active tool is shown directly. Command-line tools stream their most recent output while running, with updates coalesced by card throttling. Successful tools collapse, failed tools expand, and file changes appear as a collapsed summary.
- On completion, Agent Bot first updates the progress card to its terminal state and then sends a separate final Markdown response. Long code blocks are split safely.
- After a restart, Agent Bot restores the original Codex thread without reading or resending previously delivered history.
- The card's "View details" action reads only a bounded local snapshot and never triggers App Server history replay.

## Commands

- Plain text: send it to the current Codex task, creating one automatically if none exists.
- `/new [title] [--dir <cwd> | --nodir]`: create a task with the current default agent. Positional arguments become the title. `--dir` explicitly selects a working directory, while `--nodir` forces a Projectless task; the two options are mutually exclusive. Without either option, the current task's project or Projectless shape is inherited.
- `/newgroup [title]`: create a private Feishu group named `[agent] [Project directory] <title>` and invite the command sender without immediately creating a task or automatically sending a Sessions or Status card. Without a title, the literal name format is `[agent] [Project directory] 新任务 - yy-mm-dd hh:mm`. The new group receives a stable scheme-C Identicon generated from the project name: English or Latin project names display the first word, Chinese project names display the first character, and the full project-name hash determines the colors and symmetric node pattern. The user's home-directory prefix is displayed as `~`. The Project directory is limited to 15 displayed characters; longer paths become `...<path-separator><last-two-directories>`, with further directory-name shortening when necessary. Windows uses `\`, while macOS and Linux use `/`. If the source task belongs to a project, the new group persistently binds that project, and its first plain message or `/new` without directory options inherits it. `/new --dir <cwd>` and `/new --nodir` explicitly override that default. After the group timeline has a bound task, renaming the group to `[agent name] <new title>` with the current agent name also renames the current task.
- `/forkgroup [title]`: fork the latest available completed turn of the current Codex task, create a private Feishu group, invite the command sender, and make the fork the new group's current task. The new group does not automatically receive a Sessions or Status card, while the source group's current task and active turn remain unaffected. An explicit title does not receive a date suffix in the group name. Without a title, the command uses the persistent `<source task title>（分支 N）` sequence and still appends the date to the group name.
- `/fork [number-or-Codex-task-ID]`: fork the current or specified Codex task and immediately switch to the new branch. If the source task is running, the fork uses its latest completed turn and is rejected only when no completed turn exists. The number comes from the most recent `/sessions` result. New task titles use the persistent `<source task title>（分支 N）` sequence.
- `/title <new-title>`: rename the current task. Codex tasks are also renamed in App Server.
- `/goal [objective]`: inspect or create a persistent Goal for the current Codex task. `/goal pause`, `/goal resume`, `/goal edit <new-objective>`, and `/goal clear` are also supported. Codex continues automatically while a Goal is active.
- `/nosteer <prompt>`: queue a Prompt persistently for a later turn without modifying the currently running turn. The queue card shows every pending item and allows each one to be canceled.
- `! <command>`: run a local command directly in the current task's working directory, or in the default working directory when no current task exists.
- `/sessions [keyword]`: show an interactive card listing Codex tasks under the same `CODEX_HOME`. Five tasks are shown initially, and `更多任务` (More tasks) expands five more in place each time. Link-style actions appear at the end of every task. `New` creates and switches to a task that inherits the source task's project directory, model, reasoning effort, and permission mode. `Status` shows details. The current task omits `Switch`; other idle tasks can be switched to immediately, while externally running tasks expose `Stop` to send an Interrupt.
- `/switch [number-or-Codex-task-ID]`: without an argument, switch back to the previous task. A number from the latest `/sessions` result or a task ID selects an idle task directly.
- `/model`: show an interactive card containing every supported model, the current model, and reasoning effort. Selecting the link-style `切换` (Switch) action for another model changes the card in place to that model's reasoning-mode selector.
- `/model <name>`: change the model for the next request. An incompatible reasoning effort automatically falls back to the new model's default.
- `/thinking`: show an interactive card containing the current reasoning mode and the modes supported by the current model, with actions to change the mode or return to model selection.
- `/thinking <level>`: set the reasoning effort for the next request.
- `/permissions auto|confirm`: change the permission mode.
- `/stop`: stop the current execution.

Every message whose trimmed text starts with `/` is parsed strictly as an Agent Bot command. Unknown commands produce an error with a `/help` hint and are never forwarded as Prompts, including slash-prefixed messages that contain images.

- `/status [number-or-Codex-task-ID]`: show the current task, or use a number from the latest `/sessions` result or a task ID to show another task's detailed status, execution steps, and final result. The Status card's `刷新` (Refresh) action updates the same card in place.
- `/restart`: gracefully restart Agent Bot, bypassing a blocked task message queue when necessary.
- `/agent [agent]`: without an argument, list all agents and mark the current default. With an argument, change the default agent.
- `/use <agent> [cwd]`: change the default agent and create a task.
- `/help`: show help.

Permission modes:

- `auto` (default): Codex uses `approvalPolicy=never` and `danger-full-access`, so tools run directly.
- `confirm`: tools that require confirmation display actions on the progress card to allow once, allow for the session, decline, or cancel.

## Persistence and Recovery

By default, SQLite is stored at `~/.agent-bot/data/agent-bot.sqlite`. It persists each entry point's current and previous tasks, Codex thread IDs, models, permission modes, queued Prompts, progress snapshots, and the final-message delivery ledger.

After a process restart, Agent Bot restores persisted active turns and reconciles them with Codex's actual state through `thread/read`. It also reconciles when a new turn ID arrives, when it receives a terminal thread notification, or when a control request fails. The delivery ledger prevents successful final responses from being sent again. Every App Server request has a finite timeout, so it cannot occupy the Feishu message queue indefinitely.

The supervisor uses exit code `75` to distinguish an intentional restart initiated by `/restart`. Other unexpected exits are also restarted automatically. After restart, the Card 2.0 startup status card includes the restart reason, such as `/restart`, an exit code, or an exit signal. `/status` reports whether the supervisor is enabled.

### Unified Codex Tasks

`/sessions` uses the read-only `thread/list` API to discover tasks created by Codex Desktop, CLI, Agent Bot, or another App Server client. Tasks are no longer classified by their creator. The UI consistently uses Codex task IDs and assigns one-based numbers to the current result set. The card initially shows five tasks; each click on `更多任务` (More tasks) expands five more in place. Every task shows `New` and `Status`. `New` rereads the source task, creates a new task that inherits its project directory, model, reasoning effort, and permission mode, and switches the current chat to it. `Status` reuses `/status <task-ID>` to send that task's detailed status card without changing the current task. Link-style actions carry stable task IDs and are unaffected by list reordering. Idle tasks show `Switch`. A task switched away from Agent Bot while its current active turn was started by Agent Bot also keeps `Switch`, so it can be revisited without interrupting execution. Other externally running tasks show `Stop`; clicking it only confirms that an Interrupt was sent to Codex and updates the original card action to `Switch`, while Codex continues to own the child process and turn state. `/switch` without arguments alternates between the current and previous tasks, and it can also select a task by the latest list number or task ID. A first switch only establishes message routing, preserving the task's working directory and context without replaying history.

Agent Bot still stores an internal local routing key to associate Feishu cards, the delivery ledger, and the current chat. It does not represent a separate task type and is not shown in the UI. To avoid interfering with other Codex clients, Agent Bot only continues active turns that it started. It checks the real turn ID on first load and before each continuation message. If another client is running the task, Agent Bot neither resumes nor steers it; it sends `interrupt` only when the user explicitly selects `Stop` in the `/sessions` card.

## ACP Agent Compatibility

An agent without an explicit `kind` continues to be treated as `acp`:

```yaml
agents:
  example:
    kind: "acp"
    title: "Example ACP Agent"
    command: "node"
    args: ["./examples/example-acp-agent.js"]
```

Codex is the default entry point. `/agent` displays or changes the default agent used by future tasks. `/use` changes the default agent and immediately creates a task. `/new` always uses the current default agent.
