# Agent Bot Technical Reference

English | [简体中文](technical-reference.zh.md)

This document covers deployment, configuration, runtime behavior, persistence, and integration details. For installation and everyday commands, start with the [README](../README.md).

## Runtime Architecture

Agent Bot is a Node.js 22+ ESM TypeScript application built around these components:

- The supervisor owns the long-running service and restarts the worker.
- The worker starts the configured Codex and ACP runtimes, Feishu transport, Console transport, local control server, and SQLite store.
- Feishu events and Console input are normalized into the same task controller.
- Presentation components maintain one progress card per turn and send the final Markdown response separately.
- App Server agents use the App Server protocol over stdio; other configured agents use ACP.

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

The CLI also supports explicit directory-based profiles. Without `--profile`, commands use the main profile and the normal environment-based path rules. `--profile <directory>` pins both `AGENT_BOT_HOME` and `AGENT_BOT_CONFIG` for the command and every spawned supervisor or worker, with the configuration fixed at `<directory>/config.yaml`. It also clears inherited Feishu credential variables before loading the selected profile's `.env`, which prevents a secondary service launched from inside the primary Agent Bot process tree from accidentally reusing the primary bot. It cannot be combined with `--config`. Alternative profiles must be selected explicitly on every command; Agent Bot does not maintain a named-profile registry.

The CLI reads the system locale through Node.js internationalization support. Locales beginning with `zh` use Chinese interface text; English and every unsupported locale use English. This applies to help, status, progress, prompts, and CLI-owned errors. JSON field names and enum values are not localized. System-generated restart reasons remain Chinese because they are rendered in Chinese Lark status cards; an explicit `--reason` is preserved verbatim. `agentbot server status` reports the running worker's Lark App ID as `feishuAppId` in JSON; when the server is stopped or predates that health field, the CLI falls back to the selected profile's configured App ID.

| Default path                         | Contents                           |
| ------------------------------------ | ---------------------------------- |
| `~/.agent-bot/config.yaml`           | Main YAML configuration            |
| `~/.agent-bot/.env`                  | Feishu credentials                 |
| `~/.agent-bot/data/agent-bot.sqlite` | Persistent task and delivery state |
| `~/.agent-bot/data/inbound-images/`  | Cached incoming images             |
| `~/.agent-bot/logs/agent-bot.log`    | Structured runtime logs            |

Configuration path precedence:

1. CLI `--profile <directory>` selects `<directory>/config.yaml`
2. CLI `--config <path>`
3. `AGENT_BOT_CONFIG`
4. `<AGENT_BOT_HOME>/config.yaml`, defaulting to `~/.agent-bot/config.yaml`

The default `.env` is always loaded from the Agent Bot home. YAML values in the form `${NAME}` are expanded from the process environment after `.env` loading.

Relative `storage.sqlitePath` and `logging.path` values resolve against the directory containing the loaded configuration file. `defaults.cwd` resolves against the process startup directory.

## Initialization

`agentbot init` copies the packaged `config.example.yaml` and `.env.example` when their target files do not exist, creates the data and log directories, and restricts `.env` permissions where the platform supports POSIX modes.

Credential behavior:

- Environment values take precedence over values in `~/.agent-bot/.env`.
- Both `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are required.
- One-click registration also stores the authorizing user's `open_id` as `FEISHU_USER_OPEN_ID`.
- Complete credentials are preserved unless `--reconfigure-feishu` is used.
- Missing or incomplete credentials cause a new app registration.
- Newly registered credentials are fsynced, atomically replaced in `.env`, and read back before configuration begins.

Initialization holds `~/.agent-bot/init.lock` so concurrent commands cannot create multiple apps, including commands that use different config paths. A lock left by a dead process is recovered on the next run, and credential temporary files left by an interrupted write are removed.

When complete credentials are absent, initialization uses Feishu one-click registration and reports its verification URL as text and a QR code. In-progress registration codes are not resumed: if the process exits before the complete credential pair is persisted, the next run starts a new app registration. After credentials are persisted, initialization audits the currently published app version and can safely resume that audit after interruption.

Missing app configuration is handled in two stages:

1. Core configuration is requested and polled until it becomes available. The manually configured all-group-message scope may be explicitly skipped with `Y`.
2. Remaining optional configuration is requested. The CLI prints its QR code followed by the authorization URL, then immediately polls for up to five minutes. An interactive terminal offers only `Y` to skip optional authorization and continue; otherwise the user completes authorization in the browser while polling continues.

Configuration supported by the one-click launcher is encoded in its `addons` manifest. The core `im:message.group_msg` scope is excluded from that manifest because Feishu does not add it through one-click configuration. Instead, the CLI prints a QR code and this app-specific, pre-filtered Developer Console URL:

```text
https://open.feishu.cn/app/<appId>/auth?q=im%3Amessage.group_msg&op_from=openapi&token_type=tenant
```

The user must add the permission, publish the app version, and complete tenant approval when required. Core polling then detects the permission in the published version before initialization continues. In an interactive terminal, entering `Y` skips only this manual permission wait; other missing core scopes and the message event remain blocking. Initialization returns a partial configuration result and warns that ordinary group messages which do not mention the bot are unavailable.

Optional polling failures and timeouts return a partial configuration result instead of failing initialization. When stdin is not an interactive terminal, no skip input is available and polling continues until configuration becomes active or times out. Verification URLs and prompts use stderr, so `--json` keeps its final stdout machine-readable.

The generated authorization links do not contain the app secret.

`agentbot --profile <directory> init --reset` fully resets an explicitly selected Profile. The Profile server must be stopped first. The command moves the active `config.yaml`, `.env`, `data/`, and `logs/` into a unique timestamped directory under `<profile>/.reset-backups/`, creates clean replacements from the packaged templates, and proceeds through normal initialization. Existing reset backups and unrelated files are retained. Because backups can contain old app secrets and conversation data, protect the Profile directory accordingly. The remote Feishu app is not deleted. `--reset --skip-feishu` creates a clean Console-only Profile, while `--reset` and `--reconfigure-feishu` cannot be combined.

After Feishu initialization succeeds, the CLI releases the initialization lock and starts the detached supervisor through the same readiness path as `agentbot server start`. It waits up to 45 seconds for the worker to connect to Feishu and become ready. If the selected profile is already running, no second supervisor is created. `--skip-feishu` skips automatic server startup, and `--json` includes the resulting `server.status` without adding non-JSON output.

## Feishu App Requirements

Core configuration required for basic messaging:

- Bot capability
- Persistent-connection event delivery
- `im.message.receive_v1`
- `im:message.group_msg` for all user messages in groups containing the bot
- Tenant permission for private messages
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

Optional authorization failures are returned in the final initialization result with the affected feature names. Rerunning `agentbot init` repeats the audit.

## Configuration Model

The complete example is [config.example.yaml](../config.example.yaml). The main sections are:

```yaml
feishu:
  appId: "${FEISHU_APP_ID}"
  appSecret: "${FEISHU_APP_SECRET}"
  userOpenId: "${FEISHU_USER_OPEN_ID}"
  respondToAllGroupMessages: true

console:
  enabled: true

agents:
  codex:
    kind: "app-server"
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

`feishu.respondToAllGroupMessages` defaults to `true`. Set it to `false` to ignore group messages unless they mention the current bot. The worker resolves the bot's Open ID at startup so mentioning another member does not trigger it. Private messages are always accepted. Initialization requests all-user group-message delivery regardless of this runtime option, allowing it to be changed later without another authorization.

`agentbot server start` requires both Feishu credentials. The worker starts the SDK's persistent connection without inspecting SDK logs or private connection state, then sends startup status cards as an outbound readiness check. Each startup card includes the Agent Bot version read from the installed package metadata. It normally targets known private chats and recently active groups. If the database has no known chat yet, it sends the card to `feishu.userOpenId` using an `open_id` private message. When notification targets exist, at least one card must be delivered before the server reports ready; individual target failures remain isolated. If neither a known chat nor `feishu.userOpenId` is available, startup continues without the outbound check. Missing credentials still fail startup with an initialization hint. `agentbot console` is the explicit local-only path and does not require Feishu credentials.

At least one agent must be configured. `defaults.agent` must name a configured agent.

## Agent Runtimes

The configured Agent standard name is the runtime isolation key. Every configured Agent owns a separate, lazily started child process and runtime instance, even when multiple Agents use the same `kind`. Tasks using different Agents never share a command, environment, protocol connection, session map, or event stream. Tasks using the same Agent share that Agent process while keeping separate protocol sessions.

`kind` selects only the connection adapter. An agent with `kind: "app-server"` uses its own App Server process, whether the executable is Codex, TraeX, or another compatible product. Agent Bot passes project directory, model, reasoning effort, permission mode, text input, and local images through the App Server protocol. `/sessions` aggregates tasks reported by every configured App Server Agent while preserving the owning Agent for Switch, Status, Stop, New, and Fork actions. The previous `kind: "codex"` value is normalized to `app-server` when existing profiles are loaded.

An agent with `kind: "acp"`, or without a `kind`, uses its own ACP process. Multiple tasks create separate ACP sessions on that connection. Agent-specific `env` values are added only to that Agent's environment.

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

`/forkgroup` has thread-aware source selection. An unbound thread, or a bound thread task with no completed turn of its own, forks directly from the thread's original anchor turn without creating an intermediate thread task. Once the thread task has completed a turn, `/forkgroup` uses its latest locally persisted completed turn. A newer active turn does not block the command and is excluded from the fork point.

Agent Bot sends the experimental `excludeTurns: true` field on every `thread/fork` request. This suppresses populated `thread.turns` in the response without changing the history copied into the fork. The App Server connection enables `experimentalApi`; no user-facing command option is required. If an older App Server explicitly rejects `excludeTurns` as unknown, unsupported, or unavailable without experimental support, Agent Bot retries once without that field. Timeouts, disconnects, and unrelated fork errors are never retried because the first request may already have created a branch.

The new group's welcome message reports the persisted fork settings: Provider, model, reasoning effort, and permission type. Permission type is rendered as automatic execution or confirmation before execution.

## Turn And Message Behavior

- Plain text creates a task when the route has no current task.
- Text received during an active Codex turn is sent through steering.
- A steering race at turn completion becomes the next queued request.
- `/nosteer` always creates a persistent FIFO queue item.
- Queue card actions can cancel individual pending items.
- Exact slash command names take priority. Otherwise, a unique command-name prefix or registered compound-command initialism is expanded before argument parsing; ambiguous matches are rejected with their candidate commands. Registered initialisms are `fg` for `forkgroup`, `ng` for `newgroup`, and `ns` for `nosteer`.
- Unknown slash commands are rejected and never forwarded as Prompts.

Each turn owns one progress card. Normal updates are throttled to one every two seconds; critical updates have a 500 ms minimum gap. On completion, Agent Bot updates the progress card to a terminal state before sending a separate final Markdown message.

After the durable message-deduplication claim, Agent Bot awaits the `OnIt` reaction before chat persistence, image downloads, queue waits, command execution, or runtime calls. It replaces that reaction with `DONE`, `ERROR`, or `CrossMark` when the turn succeeds, fails, or is canceled. Reaction failures are logged but do not block task execution.

Incoming rich-text images are downloaded into the inbound image cache and passed to Codex as `localImage` inputs. An image-only message uses the default Prompt `请查看这张图片`. An ACP runtime that cannot accept image input returns an explicit error.

## Tasks, Projects, And External Codex Work

`/sessions` reads Codex tasks through `thread/list` and can discover tasks created by Codex Desktop, CLI, Agent Bot, or another App Server client under the same `CODEX_HOME`.

Each task entry exposes `NewGroup` and `ForkGroup` callbacks. The callback payload keeps the selected task ID and source context, while the Lark operator `open_id` is used to invite the user to the new group. `NewGroup` resolves the selected task's project and execution settings; `ForkGroup` resolves its latest available completed turn.

The CLI exposes the same task-targeted operations through `agentbot task newgroup <task> [title] [--agent <name>] [--dir <cwd> | --nodir]` and `agentbot task forkgroup <task> [title]`. Both commands require a running Server and send the stable local task ID over the Profile's local control endpoint. Since a CLI process has no Lark operator, the Server invites `feishu.userOpenId`, which initialization stores as `FEISHU_USER_OPEN_ID`. New-group creation inherits the selected task's Agent and execution settings by default. `--agent <standard-name>` selects another configured runtime while retaining the source project shape; execution settings are omitted so that runtime applies its own defaults. ForkGroup uses the source task's latest available completed turn and leaves an active source turn running. Both control responses include the new chat, group context, source task, and created task; `--json` prints that structure without localization.

## Codex Provider Settings

Provider is a task-level setting stored as `model_provider` alongside model, reasoning effort, and permission mode. Agent Bot passes `modelProvider` through `thread/start`, `thread/resume`, and `thread/fork` whenever a task explicitly inherits or selects one. For a brand-new task with no inherited Provider, Agent Bot omits `modelProvider`; the Codex App Server therefore uses the effective `model_provider` from Codex configuration and returns the selected Provider in its thread response for persistence.

`/provider`, `/model`, `/thinking`, and `/permissions` open one Card 2.0 execution-settings surface with the matching tab active. All four commands reject arguments; tab navigation and setting changes use card callbacks only. Provider choices come from App Server `config/read`. A Provider change resumes the thread with the selected Provider and the current compatible model, reasoning effort, and permission mode. Model, reasoning, and permission choices update their focused setting immediately, refresh the same card in place, and apply from the next request.

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

The final-delivery ledger prevents duplicate successful replies. App Server requests use finite timeouts so a stalled request cannot permanently occupy a message route. Session lifecycle requests allow 60 seconds because compatible third-party Agents may need more than 30 seconds for `thread/start`; control requests remain shorter.

## Supervisor And Restart

`agentbot server start` starts a detached supervisor. The supervisor restarts the worker after unexpected exits and applies exponential backoff from one to 30 seconds after repeated crashes.

On Windows, the CLI refreshes Machine and User environment variables before the initial Supervisor launch, a Worker refreshes them before launching a replacement Supervisor, and the Supervisor refreshes them before every Worker launch. Fresh values override inherited values, while `PATH` retains process-only entries after the current Machine and User paths. `AGENT_BOT_*` and `FEISHU_*` values remain process-local so an active Profile cannot accidentally switch data roots or bot credentials. A registry-read failure falls back to the inherited environment without blocking startup and is recorded when a runtime logger is available.

Supervisor crash diagnostics are isolated to the selected profile:

- `logs/supervisor.log` permanently records worker PIDs, exit codes, uptime, restart delays, and diagnostic artifact paths.
- `logs/worker.stderr.log` captures Node/V8 fatal output that would otherwise be lost by the detached process. Both diagnostic logs rotate at 10 MiB with three backups.
- `data/last-crash.json` points to the latest unexpected worker exit, while timestamped `data/crash-reports/crash-*.json` files preserve the history.
- `data/crash-reports/report.*.json` contains Node diagnostic reports when Node can generate one.

The supervisor, worker, replacement supervisor, and Console worker enable Node reports for fatal runtime errors and uncaught exceptions by default. Supported Node versions also exclude environment variables and network interfaces so credentials are not copied into reports. Intentional restart exit code `75` and stop exit code `76` do not create crash manifests.

A safe restart waits for:

1. Active tasks to finish
2. Final responses to be delivered
3. A 15-second quiet inbound-message window

The Feishu `/restart` command uses this safe path by default; `/restart --force` restarts immediately and may interrupt active work. The command rejects every other argument. New messages reset the quiet timer. CLI `--immediate` and `--force` also skip these checks. Exit code `75` identifies an intentional worker restart.

The first safe-restart status card is delayed by three seconds so a task's final response can usually arrive first. Status changes during that window are coalesced into the initial card. The delay does not block scheduler polling, and shutdown flushes any pending card immediately.

Pending safe-restart cards include a bottom `Cancel` action. The action carries the scheduler's monotonic schedule ID, so an old card cannot cancel a newer restart. A successful cancellation updates every existing status card in place and removes the action; the action is also absent once the scheduler enters the irreversible restarting phase.

The local control server implements task mutations, task-targeted NewGroup and ForkGroup operations, and service restart requests. Read-only task queries access SQLite directly.

## Permission Modes

- `auto`: Codex runs with `approvalPolicy=never` and `danger-full-access`.
- `confirm`: approval requests are presented through card actions for one-time approval, session approval, denial, or task cancellation.

Model, reasoning effort, permission mode, and project shape are inherited where applicable when creating or forking tasks.

## Managed System Skill

The packaged Agent Bot skill can be installed into the shared agent skill directory:

```powershell
agentbot skills install
agentbot skills status
agentbot skills uninstall
```

The default target is `~/.agents/skills`. `AGENT_BOT_SKILLS_DIR` or `--target` selects another root. Installation is a managed copy; uninstall does not remove an unrelated same-named directory.

## npm Package And Releases

The public package is `@keyou007/agent-bot`; its primary executable is `agentbot`. The deprecated `agent-bot` executable remains as a forwarding compatibility entry and prints a localized warning before each invocation. The package uses a `files` allowlist so runtime code, templates, the managed skill, source code, and user-facing documentation are published without tests or internal design plans.

`npm-shrinkwrap.json` is published with the CLI to keep transitive runtime dependencies reproducible. Direct runtime and development dependencies are also pinned to exact versions.

Package lifecycle:

- `prepublishOnly` runs type checking and the full test suite.
- `prepack` builds a clean `dist/` and validates the tarball manifest.
- `npm run package:smoke` packs the project, installs the tarball into a temporary directory, runs the CLI, and performs Console-only initialization.

Prepare the next patch release from a clean worktree:

```powershell
npm run release
git add package.json npm-shrinkwrap.json CHANGELOG.md
git commit -m "release: v0.1.1"
git push origin master
```

`npm run release` increments the patch version by default and moves the current `Unreleased` entries into a dated version section. Use `npm run release -- minor`, `npm run release -- major`, or `npm run release -- 0.2.0` to select another stable version. The command refuses to modify a dirty worktree or publish an empty changelog.

No local publish command is required after the push. When CI succeeds for a first-party push to `master`, `publish.yml` checks the package version against npm. An existing version is skipped successfully. An unpublished stable version requires a matching `CHANGELOG.md` section, then runs verification and the package smoke test before publishing. After npm accepts the package, the workflow creates the matching `v<package version>` GitHub Release.

The workflow can also be retried manually from **GitHub Actions → Publish to npm → Run workflow** on `master`. Pull requests, forked repositories, failed CI runs, and pushes to other branches cannot enter the publish job.

The npm Trusted Publisher is configured for:

- GitHub owner: `keyou`
- Repository: `agent-bot`
- Workflow: `publish.yml`
- Allowed action: `npm publish`

The publish workflow uses GitHub OIDC instead of a long-lived npm token and publishes from a GitHub-hosted Node.js 24 runner.

## Development And Source Installation

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm link
```

`npm link` registers the checkout's `agentbot` executable and deprecated `agent-bot` compatibility executable globally. Without it, built CLI commands can be invoked through `npm run cli --`. `npm run dev` runs one foreground worker, while `npm start` runs the supervisor in the current terminal.
