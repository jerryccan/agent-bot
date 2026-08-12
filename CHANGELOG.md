# Changelog

All notable changes to Agent Bot are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.14] - 2026-08-12

- Promote the validated 0.1.14 Alpha series to the stable release channel.

## [0.1.14-alpha.3] - 2026-08-12

- Refresh elapsed time in the Feishu thinking-card header at least every three seconds, and freeze it when a turn completes or stops unexpectedly.
- Add a compact `/dismiss` confirmation card and matching `agentbot task dismiss --yes` command to archive the current task and dissolve its bot-owned Feishu group.

## [0.1.14-alpha.2] - 2026-08-12

- Ask users during first initialization and `init --reset` whether group messages should be received automatically or require an explicit @ mention, and request `im:message.group_msg` only for the all-group-message mode.

- Add Profile-specific `agentbot server autostart enable|status|disable` support through Windows Task Scheduler, macOS LaunchAgents, and Linux systemd user units, with optional Linux lingering for startup before login and combined OS-registration and live-server status.

- Add `agentbot update` for global npm installations, with release-channel selection, candidate-package validation, safe idle shutdown, automatic non-interactive Profile initialization, an external installer, automatic npm rollback, and a complete-package service fallback; source checkouts and `npm link` installs are never modified.
- Add CLI counterparts for every Feishu command, including same-conversation task creation and forks, queues, Agent and execution settings, Goals, Turn history and Reset, group mute, directory browsing, file delivery, task-directory shell commands, task switching, and task-scoped restart requests.
- Let every `agentbot task` command automatically target the invoking Agent's current task when its task argument is omitted, while preserving positional references and adding a consistent `--task <task>` override.
- Install or refresh the managed Agent Bot Skill after every successful initialization, including the non-interactive initialization run automatically after package updates.
- Keep early Commentary visible on long grouped thinking cards, move omitted reasoning and tool activity into paginated history, and use compact head-and-tail truncation for tool commands and results.
- Preserve local file line and column references in Feishu Markdown link labels so source links remain understandable when Feishu cannot open their local targets.

## [0.1.14-alpha.1] - 2026-08-08

- Add persistent group-level `/mute [on|off]` control so a muted group and all its topics respond only to messages that @ the current bot, filtering ordinary messages before reactions or other work.
- Add `feishu.respondToOwnerOnly`, enabled by default, to ignore non-owner Feishu messages and card actions before processing acknowledgements, reactions, downloads, commands, or Agent work.
- Automatically retry transient LLM turn failures up to three times in the same task, with a fresh thinking card for each retry and persisted retry counts and message-reaction bindings across Worker restarts; permanent request failures remain terminal immediately.
- Keep each pending safe-restart card bound to the reason supplied by its own requesting conversation, so a later request from another chat or topic cannot overwrite the earlier card with an unrelated reason.
- Preserve exact Feishu topic routes and message anchors through Supervisor replacement so the post-restart startup card returns to the triggering topic instead of creating a new root topic in its parent group.
- Persist every accepted turn before starting Agent work and automatically recover tasks active during the preceding five minutes after every Worker restart, notifying the original private chat, group, or topic and continuing interrupted work with a fresh thinking card while only redelivering turns already completed remotely; older unfinished history is expired instead of resumed.
- Add a grouped thinking-card layout that keeps Commentary and user steering visible, shows only the latest native reasoning per execution group, defaults execution panels to collapsed while keeping stable component identities for client-side expansion, preserves complete expandable tool results without promoting child failures to a red or failed execution group, omits PowerShell and POSIX shell launcher prefixes from displayed commands, and paginates long tasks by rendered UTF-8 size and component count instead of fixed activity or tool counts, while retaining the original `timeline` layout as a configuration fallback.
- Add a `/dir` file-browser card with a stable 16-row file area, Windows drive names and selection, directory navigation, distinct image and binary-file icons, clickable file delivery, and `New` / `NewGroup` actions for creating work in the selected directory.
- Rename the `/sessions` card to `任务列表`, show five tasks per page, group tasks by project, place project-level `New` / `NewGroup` actions on each project row, and render each task as a compact bordered collapsed row with an action menu that stays well within Feishu's 200-element card limit.
- Allow standalone Feishu topics, including replies to messages without a persisted turn binding, to show status or start a fresh task instead of failing automatic fork initialization.

## [0.1.14-alpha.0] - 2026-08-07

- Split table-heavy final answers across multiple Feishu cards so the platform's per-card table limit cannot suppress a completed task result.

## [0.1.13] - 2026-08-07

- Promote the validated 0.1.13 Alpha series to the stable release channel.

## [0.1.13-alpha.4] - 2026-08-06

- During first setup or `--reset`, configure only the detected installed Agents selected by the user, choose the sole Agent as default automatically, and ask for a default only when multiple Agents were selected; normal reruns preserve both settings.
- Always render the private initialization welcome card in Chinese, independently of the CLI locale.

## [0.1.13-alpha.3] - 2026-08-05

- Send a polished, logo-branded private welcome card after every successful `agentbot init`, with first-use capabilities, upgrade highlights, same-version refresh confirmation based on Profile initialization history, and a link to the project Changelog.
- Limit safe-restart progress cards to the conversations that explicitly requested the restart instead of enrolling recently active chats.

## [0.1.13-alpha.2] - 2026-08-04

- Show every configured Agent process's PID and initialized version in `agentbot server status` and its JSON output.
- Stop forwarding Lark credentials and internal restart state to Agent processes; preserve ordinary parent variables while exposing only namespaced, non-secret Agent Bot Profile and Lark identity context.
- Repair missing turn-parent links after a Worker crash so `/turns` keeps the correct conversation graph across restart recovery.

## [0.1.13-alpha.1] - 2026-08-03

- Route safe-restart status cards and restarting acknowledgements to every conversation that triggers the pending restart plus every conversation active during the previous minute, retaining each enrolled route until the restart completes while preserving Feishu topic replies; add `agentbot server restart --task <task>` and reject ambiguous CLI routing when multiple conversations are active.
- Send every startup card to all known private chats, non-topic groups active during the previous minute, and every group enrolled for the current safe restart; fold topic routes into their parent group instead of sending startup cards into topics.
- Replace the expanding `More` action in `/sessions` with in-place five-task pagination using `Previous` and `Next`, preserving search terms, task actions, and global numbering across pages.
- Add `Reset` actions to successfully completed progress cards and a paginated `/turns` history card with 10 completed turns per page. Persist each new turn's parent, backfill existing tasks from Reset audits, and render true branch lanes and merges across page boundaries instead of connecting turns merely because their completion times are adjacent. The card marks the current conversation point and moves that marker after a successful Reset while preserving the Agent Bot task and leaving local files unchanged. Completed turns after the selected Reset point remain visible because history snapshots are retained, and the success notice identifies the selected Prompt, completion time, and Turn ID.
- Recover a missing `FEISHU_USER_OPEN_ID` from the first valid private-chat message, persist it atomically without allowing group or later messages to replace it, and reload it correctly after Worker restarts.
- Schedule a safe restart after `agentbot init` when the selected Profile server is already running, ensuring upgraded code and refreshed configuration take effect without interrupting active work.

## [0.1.13-alpha.0] - 2026-08-03

- Upgrade existing Profiles during `agentbot init` by filling missing `config.yaml` and `.env` settings, detecting Codex and TraeX versions, offering explicit install or upgrade actions, and requiring an interactive default-Agent selection.
- Keep the generated Agent list focused on Codex and TraeX while preserving existing custom Agents and user configuration during Profile upgrades.
- Generalize runtime messages, cards, help, documentation, and package metadata from Codex-specific wording to the selected App Server Agent.
- Recognize known TraeX code-mode tool-channel failures in completed responses and guide users to switch models with `/model`.
- Make Alpha the default release channel, with tested Alpha sequencing and explicit stable promotion commands.
- Publish Alpha packages under npm's `alpha` dist-tag and mark their GitHub releases as prereleases while preserving `latest` for stable versions.

## [0.1.12] - 2026-08-03

- Add a ready-to-use TraeX App Server example to the checked-in and generated default configuration.
- Rename the configured App Server adapter kind from `codex` to `app-server` while normalizing existing `codex` values during loading, and show the active Agent's display name in progress-card connection and waiting states.
- Retry `thread/list` with `updated_at` and remember that capability when a compatible App Server such as TraeX rejects Codex's `recency_at` sort extension.
- Add `agentbot task newgroup <task>` and `agentbot task forkgroup <task>` to create inherited task groups or fork a task's latest completed turn through the running Server, with optional titles, target-Agent and project overrides for NewGroup, and structured JSON output.
- Register `agentbot` as the primary CLI executable, retain `agent-bot` as a deprecated forwarding entry with a localized warning, and update current documentation and CLI guidance to use the new command.
- Refresh Windows Machine and User environment variables before initial Supervisor launch, replacement Supervisor launch, and every Worker launch so restarts pick up updated `PATH` and other values while preserving Profile isolation.
- Extend App Server session lifecycle requests to 60 seconds so slower compatible Agents such as TraeX can complete `thread/start` without producing a late unknown response.

## [0.1.11] - 2026-08-02

- Retry Feishu messages, replies, and card updates rejected by email-address content auditing with audit-safe text; keep message reactions pending until terminal presentation succeeds while allowing session and queue state to settle after presentation failures.
- Use a shorter image-only prompt that asks the active Agent to inspect the attached image.
- Reduce the packaged project logo size without changing the documented asset path.
- Keep `/new` and `/newgroup` project options aligned: both support `--dir <cwd>` with `~`-based home-directory paths and `--nodir` for a forced Projectless Codex task, while `/newgroup` continues to inherit execution settings from the source task.
- Send `excludeTurns: true` by default for every Codex fork, reducing response size without removing branch history, and retry once without the experimental field when an older App Server explicitly rejects it.
- Remove obsolete `/mode`, `/modes`, `/ask`, `/agents`, and `/use` commands, consolidating Agent selection under `/agent`.
- Omit the `[Projectless]` segment from `/newgroup` and `/forkgroup` group names while preserving Projectless task behavior.
- Add a unified execution-settings card with Provider, Model, Thinking, and Permission tabs plus an Agent tab when multiple agents are configured; route multi-option Agent and Provider selection through the same card, report their current value directly when no alternative exists, persist and inherit Provider across task lifecycle operations, and leave new tasks on the Codex-configured default Provider.
- Make Feishu `/restart` schedule a safe restart by default, with `/restart --force` as the only immediate-restart form.
- Preserve Windows separators before dot-prefixed directories in Feishu file-change summaries instead of letting Markdown consume the separator as an escape.
- Isolate every configured Agent by standard name with its own process and runtime connection, aggregate Codex tasks across those isolated runtimes, and scope persisted remote task identities by Agent.
- Add the Agent Bot logo to both READMEs and include the high-resolution PNG in the npm package.

## [0.1.10] - 2026-08-01

- Open a filtered Feishu Developer Console permission page for manual `im:message.group_msg` setup instead of incorrectly including the unsupported scope in one-click configuration; allow `Y` to skip its wait and report the resulting mention-only group behavior.
- Localize Agent Bot CLI help, status, progress, prompts, and CLI-owned errors for Chinese and English system locales, with English fallback for every unsupported locale and stable language-neutral JSON output.
- Support unambiguous slash-command prefixes and short aliases such as `/fg`, `/ng`, and `/ns`, with ambiguity guidance in `/help`.
- Show the inherited model, reasoning effort, and permission type in newly created `/forkgroup` groups.
- Accept unique slash-command prefixes and compound-command initialisms while rejecting ambiguous matches with a candidate list.

## [0.1.9] - 2026-08-01

- Add `NewGroup` and `ForkGroup` actions to every task in the Lark `/sessions` card, using the selected task's project and latest completed turn.
- Fix Lark initialization timing out after group-message authorization by requesting the actual `im:message.group_msg` scope while retaining compatibility with the `im:message.group_msg:readonly` alias.

## [0.1.8] - 2026-08-01

- Deliver Codex-generated images to Lark as previewable final results, including image-only turns and completion recovery after restart.
- Fix fresh Lark apps receiving only private and @-mention messages by always requesting all-user group-message delivery during initialization, with `feishu.respondToAllGroupMessages` controlling whether ordinary group messages receive a response.
- Keep Agent and project-directory prefixes out of Codex task titles when synchronizing a renamed Lark group.

## [0.1.7] - 2026-07-31

- Automatically wait up to five minutes for optional Lark configuration during `init`, with `Y` as the sole option to skip and continue.

## [0.1.6] - 2026-07-31

- Prevent `init --reset` from reusing credentials loaded from the Profile before its `.env` was backed up.

## [0.1.5] - 2026-07-31

- Show the running Agent Bot version on startup status cards.
- Add `agent-bot --profile <directory> init --reset` to back up and fully reconfigure an explicitly selected Profile while retaining all reset backups.

## [0.1.4] - 2026-07-31

- Show the active Lark App ID in `agent-bot server status` and its JSON output.
- Use English consistently for all Agent Bot CLI interface text.
- Keep system-generated restart reasons in Chinese to match the Lark status cards.

## [0.1.3] - 2026-07-31

- Show the incoming-message reaction before chat persistence, image downloads, queue waits, commands, or runtime work begins.
- Verify Feishu startup through notification delivery before reporting the server as ready.
- Support isolated Agent Bot profiles through explicit profile directories.
- Start the selected profile's server automatically after successful initialization.
- Persist Supervisor crash context and enable privacy-reduced Node diagnostic reports by default.
- Add a `Cancel` action to pending safe-restart status cards.

## [0.1.2] - 2026-07-29

- Make npm release retries recover a missing GitHub Release from the version tag.
- Wait for the Feishu WebSocket connection before reporting the server as ready, and reject server startup when bot credentials are missing.
- Make Feishu initialization recover safely from interruption with exclusive initialization locking, durable credential writes, and new app registration whenever a complete credential pair was not saved.

## [0.1.1] - 2026-07-29

- Add `npm run release` to prepare the next stable version and changelog.
- Publish new package versions automatically after successful CI for a push to `master`.

## [0.1.0] - 2026-07-29

- Initial public npm package.
