---
name: agent-bot
description: Initialize Agent Bot, detect and work safely inside its runtime, and manage the local service and its App Server or ACP sessions through the agentbot CLI. Use when an agent needs to adapt its behavior while running under Agent Bot, or when a user asks to initialize, inspect, start, safely restart, immediately restart, or stop Agent Bot; open its console UI; list, inspect, stop, rename, or send a prompt to tasks; create or fork Lark groups from tasks; check a scheduled restart; or troubleshoot the bot without manually killing worker processes.
---

# Agent Bot

Use the `agentbot` command as the supported control surface for Agent Bot. The legacy `agent-bot` command is deprecated and should not be used in new instructions or automation. Prefer structured status and control operations over direct process manipulation or database edits.

## Detect the Agent Bot runtime

Agent Bot injects `AGENT_BOT=1` into every configured Agent process it starts. Test for the exact value `1`:

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
agentbot init
```

Initialization detects the supported Codex and TraeX CLIs and reports each installed version. Missing or outdated Agents are presented in one numbered maintenance list with their exact commands. In an interactive terminal, the user may enter comma-separated action numbers, `all`, or press Enter to skip maintenance. A failed maintenance command or the absence of an interactive terminal does not block the remaining initialization. Do not select maintenance actions on the user's behalf without permission. Agent Bot uses the latest stable Codex release and the TraeX Alpha channel for these checks.

After the maintenance choice, interactive initialization requires the user to select the default Agent by number or standard name. It lists configured custom Agents and installed supported Agents, omits Codex or TraeX when that CLI is still missing, and writes the selected standard name to `defaults.agent` in `config.yaml`. If the current default remains available, an empty answer explicitly confirms it. Always relay the choices and let the user decide. A non-interactive invocation keeps an already configured default; it fails with an instruction to rerun interactively when no valid default exists. With `--json`, read the result from `defaultAgent.name` and `defaultAgent.status`.

Initialization creates the Agent Bot home, `config.yaml`, `.env`, `data/`, and `logs/` from the bundled examples. If Feishu credentials are absent, it starts Feishu one-click app registration, prints a QR code followed by its authorization URL, waits for the user to approve the request, and stores the returned app ID and secret in `.env`. It then audits the app's currently published tenant permissions, event subscriptions, and callbacks. Core and optional missing items produce separate configuration challenges. Core configuration is polled until ready, except that the manually configured all-group-message permission may be explicitly skipped with `Y`. For optional configuration, the CLI prints the QR code followed by the authorization URL and immediately waits up to five minutes for activation. The only terminal choice is also `Y`, which skips optional authorization and continues initialization.

An existing app may have complete credentials but no `FEISHU_USER_OPEN_ID`. In that state, ask the user to send the bot a direct message. Agent Bot atomically persists the first valid private-chat sender to the Profile `.env`; group messages and later users cannot replace it. This identity is needed for startup-notification fallback and CLI-created group invitations.

Rerun `agentbot init` after upgrading Agent Bot. It non-destructively upgrades an existing `config.yaml` by adding settings missing from the current bundled template while preserving user values, comments, custom Agents, and intentionally omitted template Agents. It also appends active variables missing from the bundled `.env.example` without changing existing values, comments, line endings, or enabling commented optional variables. It repeats the Agent version checks and Feishu configuration audit. If the selected Profile server is already running, initialization schedules a safe restart so the current installed code and refreshed configuration take effect after active work finishes. Invalid YAML is left untouched and reported as an error. Use `init --reset` only for an explicitly requested full Profile reset.

Core messaging configuration includes `im:message.group_msg`, not merely the narrower group-mention scope. Accept `im:message.group_msg:readonly` when an existing app version reports that alias. Feishu cannot add `im:message.group_msg` through the one-click launcher, so Agent Bot excludes it from `addons` and prints a QR code plus a direct filtered Developer Console permission-page URL. The user should add the permission manually, publish the app version, and complete tenant approval if required. Entering `Y` skips only this permission wait and continues with a partial configuration; the bot then cannot respond to ordinary group messages that do not mention it.

Initialization always requests all-user group-message delivery. The runtime option `feishu.respondToAllGroupMessages` controls whether Agent Bot uses it: the default `true` responds to ordinary group messages, while `false` requires a mention of the current bot. Private messages are unaffected.

After Feishu initialization succeeds, `init` releases its initialization lock and automatically starts the selected profile's server, waiting until it is ready. It does not create another supervisor when that profile is already running. `init --skip-feishu` is the exception: it prepares Console-only files and does not start the server. With `--json`, inspect `server.status` for `started`, `already-running`, or `skipped`.

When running `init` on the user's behalf, relay every exact authorization, incremental-configuration, and manual permission-page URL and let the user complete it in their own browser. For `im:message.group_msg`, explicitly tell the user to add the filtered permission and publish the app version, or offer to enter `Y` when they intentionally accept mention-only group behavior. Optional polling starts automatically after the link is shown. Do not enter `Y` for either prompt unless the user explicitly asks to skip; there is no separate accept action. Optional capabilities such as group creation, group-title synchronization, reactions, images, and card actions never block initialization when skipped, timed out, or still unavailable; relay the final affected-feature warnings. In a non-interactive terminal, skip input is unavailable. None of the URLs contains the app secret, and the secret itself is never printed.

Existing complete Feishu credentials are preserved but still audited and repaired when needed. Missing or incomplete credentials mean app creation did not complete, so a later `init` starts a new registration instead of resuming the previous device code. Once both credentials are durably saved, an interrupted permission audit resumes against the same remote app. `init` also holds a local lock to prevent concurrent registrations. Use `agentbot init --skip-feishu` only for console-only initialization because it skips both registration and configuration auditing. Use `agentbot init --reconfigure-feishu` only when the user explicitly wants to replace existing complete credentials. The command respects `AGENT_BOT_HOME`, `AGENT_BOT_CONFIG`, and `--config <path>`. Use `agentbot init --json` when structured final output helps.

Use `agentbot --profile <directory> init --reset` only when the user explicitly requests a full Profile reset. `--profile` is mandatory even for the primary Profile, and its server must be stopped first. The command moves the active `config.yaml`, `.env`, `data/`, and `logs/` into a new timestamped `.reset-backups` directory, retains all older backups and unrelated files, then initializes a clean Profile. Relay the reported backup path. Do not delete `.reset-backups`; it may contain old credentials and task data. `--reset --skip-feishu` is valid for a clean Console-only Profile, but `--reset` cannot be combined with `--reconfigure-feishu`.

For an isolated secondary bot, pass its profile directory explicitly on every command:

```powershell
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server status
```

No `--profile` selects the main profile at `~/.agent-bot` by default. `--profile <directory>` selects that directory's `config.yaml`, `.env`, data, logs, and local control endpoint and propagates the selection to the supervisor and worker. Alternative profiles are not registered by name. Do not combine `--profile` with `--config`.

## Start with inspection

Verify the CLI and current service state before changing anything:

```powershell
agentbot --version
agentbot --help
agentbot server status
agentbot task list
```

Agent Bot CLI interface text follows the system locale: locales beginning with `zh` use Chinese, while English and unsupported locales use English. JSON output is not localized. `agentbot server status` also reports the running profile's Lark App ID; with `--json`, read it from `feishuAppId`.

Add `--json` to status and list commands when machine-readable output helps. If `agentbot` is unavailable, report that the CLI is not installed or linked instead of guessing process state.

By default Agent Bot stores user-owned configuration and runtime state in `~/.agent-bot`: config at `~/.agent-bot/config.yaml`, environment variables at `~/.agent-bot/.env`, SQLite state at `~/.agent-bot/data/agent-bot.sqlite`, logs at `~/.agent-bot/logs/agent-bot.log`, and inbound image cache next to the SQLite database. `AGENT_BOT_HOME` changes this root. Prefer `--profile <directory>` when controlling a complete isolated instance; use `--config <path>` only when selecting a non-default configuration without changing the whole profile.

## Manage the service

Use these commands:

```powershell
agentbot server start
agentbot server status
agentbot server restart --task <current-task-id> --reason "reason for restart"
agentbot server stop
```

Treat `server restart` as the normal restart path. It schedules a safe restart and waits for active tasks, pending final-message delivery, and a quiet inbound-message window. The first safe-restart status card is delayed by three seconds so the active task's final response can usually be delivered first; this presentation delay does not postpone scheduler polling. While the restart is pending, its status card has a bottom `Cancel` button that conditionally cancels that exact schedule and updates the card in place.

When scheduling from an Agent Bot-hosted task, pass `--task <current-task-id>`. This adds the task's exact Lark conversation, including its topic, to the pending restart's notification set. Every conversation that triggers the same pending restart plus every conversation active during the previous minute receives its own status card and restarting acknowledgement. Once enrolled, a route remains in the set until that restart ends; repeated routes are deduplicated. Resolve the current ID with `agentbot task list --status running` when necessary. If `--task` is omitted, the Server infers a target only when all running tasks belong to one conversation and rejects the request when multiple running conversations make ownership ambiguous. Startup cards are service-wide notices: every known private chat receives one on every startup, groups receive one when active in the previous minute or enrolled for the current safe restart, and topic routes receive the card in their parent group rather than inside the topic.

On Windows, initial start, safe or immediate replacement, and every crash-driven Worker launch reload the latest Machine and User environment variables. After changing `PATH` or installing a CLI shim, finish the current work and use the normal restart path. Agent Bot keeps `AGENT_BOT_*` and `FEISHU_*` process-local so Profile selection and bot credentials do not leak between isolated instances.

In Feishu, `/restart` schedules the same safe restart. Use `/restart --force` only when the user explicitly accepts interruption; the command accepts no other arguments.

Use `agentbot server restart --immediate` only when the user explicitly requests an immediate restart or accepts interruption. Never use `taskkill`, `Stop-Process`, or equivalent commands for routine Agent Bot restart management.

`agentbot console` opens the console UI only when the service is stopped. Do not use `--force` while the service is live unless the user explicitly accepts concurrent state access.

When a startup card says the Worker exited and the supervisor restarted it, inspect the selected profile's persisted crash evidence before guessing at a cause:

- `data/last-crash.json` for PID, exit code, uptime, restart delay, and linked report paths
- `logs/supervisor.log` for the restart timeline
- `logs/worker.stderr.log` for Node/V8 fatal output
- `data/crash-reports/report.*.json` for Node diagnostic reports

Normal safe restarts and explicit stops do not overwrite the latest crash record. Every explicit profile keeps its own diagnostic files; use the same `--profile <directory>` selection when correlating service status with those paths.

## Manage tasks

List tasks before resolving a numeric reference because task numbers follow the current list order:

```powershell
agentbot task list
agentbot task chat <number-or-task-id> [--json]
agentbot task status <number-or-task-id>
agentbot task stop <number-or-task-id>
agentbot task title <number-or-task-id> <new-title>
agentbot task prompt <number-or-task-id> <prompt>
agentbot task newgroup <number-or-task-id> [title] [--agent <standard-name>] [--dir <cwd> | --nodir] [--json]
agentbot task forkgroup <number-or-task-id> [title] [--json]
```

Task IDs may be supplied in full or as an unambiguous prefix. Use `task stop` to ask the running worker to send the App Server Interrupt signal; leave child-process lifecycle management to the selected Agent.

Use `task chat <number-or-task-id>` to read the Feishu chat ID associated with a task from local routing state. Plain output is only the chat ID for scripting. Add `--json` to include the stable task ID, complete context key, and the thread ID for a topic-bound task. This read-only command does not require the Agent Bot server to be running.

Use `task prompt` to send input to a specific task without changing any chat's current task. The bot first posts the Prompt text to the task's existing Feishu chat, thread, or private-chat route, then submits it to the task. If posting fails, the task is not started or steered. The thinking card and final response continue to the same route; the command line only reports whether the Prompt was accepted.

### Create a task group from the CLI

Use `task newgroup` to create a Lark group and bind a new task from outside Feishu. List tasks first and pass the intended source task explicitly; `<number-or-task-id>` defines the source context, so never substitute the shell's current working directory for the task's project directory.

```powershell
# Inherit the source task's Agent, project, and execution settings.
agentbot task newgroup <number-or-task-id> "Review"

# Override the project directory. Prefer an absolute path or a ~-based path.
agentbot task newgroup <number-or-task-id> "Review" --dir ~/dev/project

# Create a fresh Projectless App Server task instead of inheriting a project.
agentbot task newgroup <number-or-task-id> "Question" --nodir

# Use another configured Agent with the inherited project shape.
agentbot task newgroup <number-or-task-id> "Review" --agent traex
```

Apply these rules:

- With neither `--dir` nor `--nodir`, inherit the source task's project directory. If the source is Projectless, create a fresh Projectless workspace rather than reusing its generated directory.
- `--dir <cwd>` overrides the inherited project and resolves `~`, `~/...`, and `~\...` from the user's home directory.
- `--nodir` forces a Projectless task and is valid only for an App Server Agent. Reject combining it with `--dir`.
- With no `--agent`, inherit the source task's Agent, Provider, model, reasoning effort, and permission mode. When `--agent <standard-name>` selects a different Agent, retain the chosen or inherited project shape but use that Agent runtime's own execution defaults.
- The Server must be running. The Profile must contain `FEISHU_USER_OPEN_ID`; the Server invites that saved authorizing user because the CLI has no Lark operator identity.
- Creating the group must not interrupt the source task or switch the source chat's current task. Add `--json` when the caller needs `group.chatId`, `group.contextKey`, or the created task IDs.

Use `task forkgroup` to Fork the selected task's latest available completed turn into a new group. It does not interrupt a newer active source turn and does not switch the source chat. Both group commands accept an optional title and `--json`; use the structured result to read the new `group.chatId`, `group.contextKey`, and task IDs.

Use `/queue <prompt>` in Feishu to persist a separate follow-up Prompt instead of steering the active turn. Queued Prompts run in FIFO order after the current turn completes and survive Agent Bot restarts. `/nosteer <prompt>` is an equivalent compatibility spelling.

For a long-running objective in the active Feishu task, use `/goal <objective>`. Use `/goal` to inspect it, `/goal pause` or `/goal resume` to control automatic continuation, `/goal edit <objective>` to revise it, and `/goal clear` to remove it. Stopping a Goal turn through Agent Bot also pauses the Goal before sending Interrupt so it does not immediately continue.

Use `/agent` in Feishu to open the unified execution-settings card on its Agent tab and `/agent <name>` to directly select the default agent. The Agent tab is present only when multiple agents are configured and remains usable before the chat has a current task. When only one Agent is configured, `/agent` reports that current Agent directly instead of sending a card. Agent selection affects future tasks and does not replace the Agent of an existing task; use `/new` after selecting when a new task is needed.

Use `/newgroup [title] [--dir <cwd> | --nodir]` in Feishu to create a private group named `[agent] [project directory] <title>`, invite the command sender, and immediately create and bind a new task in that group. `/new` and `/newgroup` share the same project options: an explicit `--dir` overrides the inherited project directory, while `--nodir` forces a Projectless App Server task; reject using both together. Resolve `~`, `~/...`, and `~\...` from the current user's home directory for both commands. Projectless groups omit the project segment and use `[agent] <title>`. The new task inherits the source chat's current task project directory when neither option is present, plus its model, reasoning effort, and permission mode without interrupting or switching the source task. When the source chat has no current task, use the selected agent and its runtime defaults. An explicit title becomes both the group suffix and the task title. When the title is omitted, use task title `新任务` and group name `[agent] [project directory] 新任务 (mm-dd)`, or `[agent] 新任务 (mm-dd)` for Projectless; an explicit title never gets a date suffix. Every new group gets a deterministic scheme-C Identicon avatar: Latin project names display their first word, Chinese names display up to their first four characters, and the normalized full project path hashes into the palette and symmetric node pattern. Projectless groups use the title as the stable seed. Replace the user's home-directory prefix with `~`. The bracketed project-directory value is limited to 15 characters. Longer paths keep the final two directories when they fit, otherwise keep the final directory, truncating the tail only when the final directory itself is overlong. Use `\` on Windows and `/` on macOS/Linux. Do not automatically send a Sessions or Status card to the new group. A later `/new --dir <cwd>` or `/new --nodir` in the group may explicitly replace the inherited project shape.

Provider is part of the same inherited execution-settings group as model, reasoning effort, and permission mode. Preserve all four across `/new`, `/newgroup`, `/fork`, `/forkgroup`, and the matching `/sessions` actions. New tasks with no inherited Provider must leave it unset so the selected App Server Agent uses its own default configuration. New-group welcome messages report all four settings.

Group names created by `/newgroup` and `/forkgroup` are capped at 60 displayed characters. When the generated name would exceed that limit, truncate only the title portion in the Feishu group name; preserve the underlying Agent Bot task title.

Use `/forkgroup [title]` in Feishu to fork the current position into a newly created private group. In a Feishu thread, use the thread's original anchor turn when the thread has no bound task or its bound task has not completed a turn of its own. Once the bound thread task has completed a turn, use its latest locally persisted completed turn; exclude any newer active turn without interrupting it. Resolve this source before generic thread initialization so an unbound thread does not create an intermediate task. Outside a thread, fork the current App Server task's latest available completed turn. Agent Bot invites the command sender and binds the fork as the new group's current task, but does not automatically send a Sessions or Status card there. The new-group welcome message reports the forked task's model, reasoning effort, and permission type. An explicit title is used directly. Without an explicit title, both the forked task and group name use the same persistent `source title（分支 N）` sequence as `/fork`. `/forkgroup` does not add a date suffix.

Use `/new [title] --nodir` to force a new App Server Projectless task even when the current task belongs to a project. `--nodir` and `--dir <cwd>` are mutually exclusive; omitting both preserves the normal project-shape inheritance behavior.

The Feishu `/sessions` card shows five tasks per page and updates the same card through `Previous` and `Next`; it never expands earlier pages into one long card. Every task has `New`, `NewGroup`, `Fork`, and `ForkGroup` actions. `New` inherits the source task's project directory, model, reasoning effort, and permission mode, creates a new task, and switches the current chat to it without stopping or forking the source task. `NewGroup` applies the same inheritance in a newly created private group. `Fork` switches the current chat to a branch, while `ForkGroup` binds the branch to a newly created private group; both fork actions use the selected task's latest available completed turn without interrupting an active turn.

Use `/fork [number-or-task-id]` in Feishu to branch from the current or specified App Server task and switch to the new branch. If the source task is running, Agent Bot forks from its latest completed turn and leaves the active turn running; it rejects only when the task has no completed turn yet. Every fork request sends `excludeTurns: true` to the App Server so the response omits populated turns without removing turns from the forked history. Older App Servers that explicitly reject this experimental field are retried once without it; ambiguous failures such as timeouts or disconnects are not retried.

Successfully completed Feishu thinking cards include a bottom `Reset` action followed by its compact warning. `/turns` opens the current task's completed-turn history with the Reset-effect warning at the top and 10 turns per page. It renders each entry as an indented numbered node in a commit graph whose lanes follow persisted parent turns, including Reset branches and merges across page boundaries. A successful Reset refreshes that card in place, moves the current marker to the selected turn, and sends a confirmation containing the target Prompt summary, completion time, and Turn ID. Reset forks the selected turn's original App Server thread through that turn and replaces the current task's remote thread binding in place, preserving the local task ID, title, Agent, project directory, execution settings, and chat route. Completed snapshots after the selected point remain visible together with later turns from the new branch. Reset is available only when the card still belongs to the current task and the task is idle. It restores conversation context only and never reverts local files.

Status cards include a `Refresh` action that reads the latest task state and updates the same card in place without switching tasks or sending another card.

Use `/agent`, `/provider`, `/model`, `/thinking`, or `/permissions` in Feishu to open the same interactive Card 2.0 execution-settings card with the corresponding tab active. The card exposes Provider, Model, Thinking, and Permission tabs whenever a current task exists, plus an Agent tab when multiple agents are configured. Each non-current option has an English `Switch` action. Selecting an option refreshes the same card in place. Agent changes affect future tasks; the other settings apply from the next request. Model changes automatically choose a compatible reasoning effort when necessary.

If the current runtime has no alternative Provider, `/provider` reports the current Provider directly instead of opening the settings card. Apply the same rule to `/agent` when only one Agent is configured.

These four settings commands do not accept arguments. Never instruct a user to send a Provider, model, reasoning effort, or permission value after the command; direct them to the card callbacks instead.

Keep action labels placed to the right of card content or at the bottom of a card in English. Buttons above the main card content, such as activity-history navigation, may remain in Chinese.

Messages whose trimmed text starts with `/` are always parsed as Agent Bot commands. Command names accept unique prefixes, such as `/sess` for `/sessions`. Compound commands also accept registered initialisms: `/fg` for `/forkgroup`, `/ng` for `/newgroup`, and `/ns` for `/nosteer`. Exact command names take priority; ambiguous matches are rejected and list every matching command. Unknown slash commands are reported to the user with a `/help` hint and must never fall through to the model, including slash-prefixed messages that also contain images.

When a group body has a current task, renaming the Feishu group to `[agent-name] [project directory] new title` also renames that current task if the Agent prefix matches the task's configured agent. Only `new title` is written to the task; the Agent and project-directory prefixes remain group metadata. The older `[agent-name] new title` shape remains supported. Malformed names, agent mismatches, empty groups, and thread-specific tasks are ignored.

Use `--context <key>` or `--status <status>` to narrow `task list`. Use `--profile <directory>` before the command when controlling an isolated Agent Bot instance, or `--config <path>` for only a non-default configuration.

## Apply code changes safely

After changing Agent Bot code, run the relevant tests, typecheck, and build. If a running service must pick up the result, schedule:

```powershell
agentbot server restart --task <current-task-id> --reason "brief description of the completed change"
```

Do not replace the worker immediately while a task is active. A later incoming task must not cancel the pending safe restart; allow the scheduler to wait until the service becomes safely idle again.
