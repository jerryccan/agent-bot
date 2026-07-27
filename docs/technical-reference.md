# Agent Bot Technical Reference

English | [简体中文](technical-reference.zh.md)

This document covers deployment, configuration, runtime behavior, persistence, and integration details. For installation and everyday commands, start with the [README](../README.md).

## Runtime Architecture

Agent Bot is a Node.js 20+ ESM TypeScript application built around these components:

- The supervisor owns the long-running service and restarts the worker.
- The worker starts the configured Codex and ACP runtimes, Feishu transport, Console transport, local control server, and SQLite store.
- Feishu events and Console input are normalized into the same task controller.
- Presentation components maintain one progress card per turn and send the final Markdown response separately.
- Codex agents use Codex App Server over stdio; other configured agents use ACP.

Relevant source areas:

| Area                | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `src/config/`       | YAML loading, environment expansion, validation, and path resolution      |
| `src/cli/`          | Initialization, app registration, app auditing, and service/task commands |
| `src/feishu/`       | Feishu WebSocket events, API calls, cards, images, and context keys       |
| `src/runtime/`      | Shared runtime abstraction                                                |
| `src/codex/`        | Codex App Server protocol integration                                     |
| `src/acp/`          | ACP process and JSON-RPC integration                                      |
| `src/proxy/`        | Tasks, turns, steering, queues, forks, and command execution              |
| `src/presentation/` | Turn-state reduction and outbound routing                                 |
| `src/state/`        | SQLite schema, migrations, routing, and delivery state                    |
| `src/supervision/`  | Safe restart and restart notifications                                    |

## User Data And Path Resolution

The default user-data root is `~/.agent-bot`. `AGENT_BOT_HOME` replaces that root.

| Default path                         | Contents                           |
| ------------------------------------ | ---------------------------------- |
| `~/.agent-bot/config.yaml`           | Main YAML configuration            |
| `~/.agent-bot/.env`                  | Feishu credentials                 |
| `~/.agent-bot/data/agent-bot.sqlite` | Persistent task and delivery state |
| `~/.agent-bot/data/inbound-images/`  | Cached incoming images             |
| `~/.agent-bot/logs/agent-bot.log`    | Structured runtime logs            |

Configuration path precedence:

1. CLI `--config <path>`
2. `AGENT_BOT_CONFIG`
3. `~/.agent-bot/config.yaml`

The default `.env` is always loaded from the Agent Bot home. YAML values in the form `${NAME}` are expanded from the process environment after `.env` loading.

Relative `storage.sqlitePath` and `logging.path` values resolve against the directory containing the loaded configuration file. `defaults.cwd` resolves against the process startup directory.

## Initialization

`agent-bot init` copies the packaged `config.example.yaml` and `.env.example` when their target files do not exist, creates the data and log directories, and restricts `.env` permissions where the platform supports POSIX modes.

Credential behavior:

- Environment values take precedence over values in `~/.agent-bot/.env`.
- Both `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are required.
- Complete credentials are preserved unless `--reconfigure-feishu` is used.
- An incomplete credential pair is rejected instead of being silently replaced.
- Newly registered credentials are written atomically to `.env`.

When credentials are absent, initialization uses Feishu one-click registration and reports its verification URL as text and a QR code. After registration, or when complete credentials already exist, it audits the currently published app version.

Missing app configuration is handled in two stages:

1. Core configuration is requested and polled until it becomes available.
2. Remaining optional configuration is requested without blocking initialization.

The generated authorization links do not contain the app secret.

## Feishu App Requirements

Core configuration required for basic messaging:

- Bot capability
- Persistent-connection event delivery
- `im.message.receive_v1`
- Tenant permissions for group @ messages and private messages
- `im:message:send_as_bot` or a broader equivalent
- `application:application:self_manage` so initialization can inspect the published version

Optional configuration:

| Configuration                         | Enabled behavior             |
| ------------------------------------- | ---------------------------- |
| `im:chat:create`                      | `/newgroup` and `/forkgroup` |
| `im:chat:read`                        | Reading group metadata       |
| `im.chat.updated_v1`                  | Group-title synchronization  |
| `im:message.reactions:write_only`     | Processing-status reactions  |
| Message-read and resource permissions | Incoming and outgoing images |
| Image and chat permissions            | Generated group avatars      |
| `card.action.trigger`                 | Interactive card actions     |

Optional authorization failures are returned in the final initialization result with the affected feature names. Rerunning `agent-bot init` repeats the audit.

## Configuration Model

The complete example is [config.example.yaml](../config.example.yaml). The main sections are:

```yaml
feishu:
  transport: "auto"
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"
  useConsoleWhenMissingCredentials: true

console:
  enabled: true

agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args: ["app-server", "--enable", "goals", "--listen", "stdio://"]
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

`feishu.transport` accepts:

- `auto`: use the SDK when credentials exist; otherwise follow `useConsoleWhenMissingCredentials`
- `sdk`: require Feishu credentials and start the WebSocket client
- `console`: disable Feishu transport

At least one agent must be configured. `defaults.agent` must name a configured agent.

## Agent Runtimes

An agent with `kind: "codex"` uses Codex App Server. Agent Bot passes project directory, model, reasoning effort, permission mode, text input, and local images through the App Server protocol.

An agent with `kind: "acp"`, or without a `kind`, is started as an ACP process. Agent-specific `env` values are added to its environment.

Every agent process receives:

```text
AGENT_BOT=1
```

The bundled skill uses this variable to detect that it is running inside Agent Bot.

## Chat Routing

The message route determines the current task:

- A private chat body is isolated by its Feishu chat ID.
- A group timeline is isolated by its Feishu chat ID.
- A message with a thread ID is isolated as its own thread context.
- Console input uses a separate local context.

Commands, card callbacks, progress cards, and final responses stay on the originating route.

Starting a Feishu thread from a mapped user message, progress card, or final response forks from the associated completed Codex turn. If no reliable completed source turn exists, the operation fails instead of selecting an arbitrary point.

## Turn And Message Behavior

- Plain text creates a task when the route has no current task.
- Text received during an active Codex turn is sent through steering.
- A steering race at turn completion becomes the next queued request.
- `/nosteer` always creates a persistent FIFO queue item.
- Queue card actions can cancel individual pending items.
- Unknown slash commands are rejected and never forwarded as Prompts.

Each turn owns one progress card. Normal updates are throttled to one every two seconds; critical updates have a 500 ms minimum gap. On completion, Agent Bot updates the progress card to a terminal state before sending a separate final Markdown message.

After message deduplication, Agent Bot attempts an `OnIt` reaction. It replaces that reaction with `DONE`, `ERROR`, or `CrossMark` when the turn succeeds, fails, or is canceled. Reaction failures do not block task execution.

Incoming rich-text images are downloaded into the inbound image cache and passed to Codex as `localImage` inputs. An image-only message uses the default Prompt `请分析这张图片。`. An ACP runtime that cannot accept image input returns an explicit error.

## Tasks, Projects, And External Codex Work

`/sessions` reads Codex tasks through `thread/list` and can discover tasks created by Codex Desktop, CLI, Agent Bot, or another App Server client under the same `CODEX_HOME`.

Agent Bot keeps a local routing key for Feishu cards and delivery state, but presents the Codex task ID to users. It does not resume, steer, stop, or fork externally running Codex work without an explicit user action.

Project behavior:

- `/new --dir <path>` creates a project task.
- `/new --nodir` creates a Projectless task.
- `/new` inherits the current task's project or Projectless shape.
- A first Projectless task is created under `~/Documents/Codex/<date>/<task-name>`.
- An existing task's working directory is immutable.

Forks use the latest available completed turn and do not interrupt an active source turn.

## Persistence And Recovery

SQLite stores:

- Current and previous tasks for each route
- Local and Codex task/thread identifiers
- Model, reasoning effort, and permission mode
- Queued Prompts
- Progress snapshots and message bindings
- Final-message delivery records

On startup, Agent Bot reconciles persisted active work with Codex through `thread/read`. It also reconciles when turn identifiers change, terminal notifications arrive, or control requests fail.

The final-delivery ledger prevents duplicate successful replies. App Server requests use finite timeouts so a stalled request cannot permanently occupy a message route.

## Supervisor And Restart

`agent-bot server start` starts a detached supervisor. The supervisor restarts the worker after unexpected exits and applies exponential backoff from one to 30 seconds after repeated crashes.

A safe restart waits for:

1. Active tasks to finish
2. Final responses to be delivered
3. A 15-second quiet inbound-message window

New messages reset the quiet timer. `--immediate` and `--force` skip these checks. Exit code `75` identifies an intentional worker restart.

The local control server implements task mutations and service restart requests. Read-only task queries access SQLite directly.

## Permission Modes

- `auto`: Codex runs with `approvalPolicy=never` and `danger-full-access`.
- `confirm`: approval requests are presented through card actions for one-time approval, session approval, denial, or task cancellation.

Model, reasoning effort, permission mode, and project shape are inherited where applicable when creating or forking tasks.

## Managed System Skill

The packaged Agent Bot skill can be installed into the shared agent skill directory:

```powershell
agent-bot skills install
agent-bot skills status
agent-bot skills uninstall
```

The default target is `~/.agents/skills`. `AGENT_BOT_SKILLS_DIR` or `--target` selects another root. Installation is a managed copy; uninstall does not remove an unrelated same-named directory.

## Development And Verification

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

`npm run dev` runs one foreground worker. `npm start` runs the supervisor in the current terminal. Built CLI commands can be invoked without `npm link` through `npm run cli --`.
