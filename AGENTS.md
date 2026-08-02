# AGENTS.md

Guidance for agents working in this repository.

## Project Overview

Agent Bot is a Feishu-first bridge to local Codex App Server and ACP agents, with a console entry point for local testing. The runtime is a Node.js 22+ TypeScript application using ESM, strict TypeScript, Vitest, SQLite persistence, and YAML configuration.

Primary user-facing behavior is documented in `README.md`. Keep that document in sync when changing commands, message routing, Feishu card behavior, task/session semantics, restart behavior, configuration, or install/start instructions.

## Repository Map

- `src/index.ts` wires the application together: config, state store, runtimes, Feishu/console connectors, outbound routing, local control server, and graceful shutdown.
- `src/supervisor.ts` keeps the worker process alive and handles restart policy behavior.
- `src/cli.ts` implements the `agentbot` command-line surface; `src/deprecated-cli.ts` preserves the deprecated `agent-bot` compatibility entry.
- `src/acp/` contains ACP JSON-RPC process/session handling.
- `src/codex/` contains Codex App Server process and protocol integration.
- `src/commands/` parses and routes Feishu slash commands.
- `src/config/` loads and validates the user config, defaulting to `~/.agent-bot/config.yaml`, using Zod.
- `src/feishu/` contains Feishu transport, message client, card rendering, and turn presentation.
- `src/presentation/` owns turn-state reduction, Markdown splitting, and outbound routing.
- `src/proxy/` coordinates sessions, turns, steering, queues, forks, and command execution.
- `src/runtime/` provides the shared runtime abstraction over ACP and Codex.
- `src/state/` owns SQLite persistence and migrations.
- `src/startup/` and `src/supervision/` handle startup cards, task metadata hydration, and safe restarts.
- `src/utils/` contains small reusable helpers.
- `tests/` mirrors the source areas with Vitest coverage.
- `skills/agent-bot/` is the built-in managed Agent Bot skill. Update it when CLI/control behavior changes.
- `scripts/check-package.mjs` and `scripts/smoke-package.mjs` validate the npm tarball and installed CLI.
- `docs/specs/` contains design notes, and `docs/plans/` contains implementation plans.

## Commands

Use these commands from the repository root:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run package:smoke
```

Useful runtime commands after building:

```powershell
npm start
npm run dev
npm run cli -- server status
npm run cli -- task list
```

When changing runtime behavior, run the focused Vitest file(s) first, then run `npm run typecheck` and `npm test`. Run `npm run build` before handing off changes that affect compiled output, package entry points, CLI behavior, or deployment/startup paths.

## Coding Conventions

- This is an ESM TypeScript project with `module` and `moduleResolution` set to `NodeNext`.
- Use explicit `.js` extensions for local TypeScript imports, matching the existing code.
- Keep `strict` TypeScript clean. Avoid `any` unless a boundary genuinely cannot be typed more narrowly.
- Prefer small, focused modules that fit the existing source-area ownership.
- Use Zod for external/configuration validation and typed internal objects after parsing.
- Preserve the existing async control-flow style. Avoid fire-and-forget work unless failures are logged or intentionally ignored.
- Use structured logger calls through the existing logger rather than `console.log` in runtime code.
- Keep comments sparse and useful. Add them only where the surrounding code is not enough to explain the intent.
- Do not commit generated output from `dist/`, runtime SQLite files, logs, inbound image caches, `.tmp/`, `.worktrees/`, or `node_modules/`.
- User-owned runtime content belongs under `~/.agent-bot` by default, not in the repository root.

## Tests

- Tests use Vitest.
- Put tests under the matching `tests/<area>/` directory.
- Import source files with the same `.js` extension style used by existing tests.
- Prefer focused unit tests for command parsing, state transitions, persistence migrations, card rendering, and runtime protocol mapping.
- For SQLite/state changes, use temporary directories or isolated database files and clean them up in `finally` blocks.
- For process-spawning code, prefer test doubles and narrow assertions over starting real long-lived processes.

## State And Persistence

- The default SQLite path is `~/.agent-bot/data/agent-bot.sqlite`.
- Treat `src/state/StateStore.ts` and `src/state/migrations.ts` as compatibility-sensitive. Existing users may already have local databases.
- Add migrations for schema changes instead of assuming a fresh database.
- Preserve final-message delivery ledgers and task routing semantics; they prevent duplicate Feishu replies after restart.
- Be careful with task identifiers. Local session IDs, Codex task/thread IDs, Feishu chat IDs, and Feishu thread IDs are different concepts.

## Feishu And Presentation Behavior

- Feishu is the primary interface. Avoid changes that create extra progress cards or duplicate final messages.
- Each turn should have one progress card that is updated in place, followed by a separate final Markdown reply.
- Preserve card throttling behavior unless intentionally changing UX: normal updates are throttled, critical status updates may refresh faster.
- Slash-prefixed messages are commands. Unknown slash commands must not fall through to the model.
- Topic-bound messages should remain in the topic. Group body, topic, and private chat routes are separate contexts.
- Markdown sent to Feishu may need splitting; use the presentation utilities instead of ad hoc chunking.
- Image handling should keep local-image Markdown and cached inbound images compatible with the Codex `localImage` path.

## Codex And ACP Runtime Notes

- `kind: "codex"` agents use Codex App Server through stdio.
- Agents without `kind` default to ACP; preserve this backward-compatible behavior.
- Do not steer, resume, stop, or fork external Codex work unless the user explicitly requests the matching operation.
- Fork behavior should use the latest available completed turn and must not interrupt an active source turn.
- Keep model, thinking, permission mode, project directory, and projectless-task inheritance behavior consistent across `/new`, `/sessions` actions, `/fork`, `/newgroup`, and `/forkgroup`.

## Safe Restart And Process Management

- Use the CLI/local control path for service management. Do not manage routine restarts by killing processes directly.
- A normal restart should be safe: wait for active tasks, final-message delivery, and the quiet inbound-message window.
- Use immediate restart only when the caller explicitly accepts interruption.
- If code changes need a running service to pick them up, build first, then schedule:

```powershell
agentbot server restart --reason "brief reason"
```

## Configuration

- `~/.agent-bot/config.yaml` is the default user config. `loadConfig()` creates it from the built-in default when no explicit config path is supplied and the file is missing.
- `config.example.yaml` is the checked-in example config. Keep it aligned with the built-in default config in `src/config/loadConfig.ts`.
- `.env` is loaded from `~/.agent-bot/.env`. Update `.env.example` when adding new required or useful environment variables.
- Relative `storage.sqlitePath` and `logging.path` values resolve against the directory containing the loaded config file.
- `AGENT_BOT_HOME` can move the user-data root; `AGENT_BOT_CONFIG` and `--config <path>` can point to a specific YAML file.
- Preserve `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `AGENT_BOT_CONFIG` behavior unless intentionally changing documented setup.
- Resolve paths relative to config/workspace consistently; avoid depending on the shell's incidental current directory except at documented entry points.

## Built-In Skill

The managed skill in `skills/agent-bot/SKILL.md` teaches agents how to control Agent Bot through the CLI. Update it when adding, renaming, or materially changing:

- server commands
- task commands
- safe restart behavior
- `/goal`, `/new`, `/fork`, `/sessions`, `/model`, `/thinking`, or permission commands
- recommended troubleshooting procedures

## Windows Screenshots

If work touches screenshot capture on Windows, use a fresh helper process, enable Per-Monitor DPI Aware V2 before reading any screen/window APIs, and use physical DWM extended frame bounds. In locked sessions, use `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` and validate the returned bitmap dimensions instead of returning black captures.

## Before Handoff

- Check `git status --short` and do not overwrite unrelated user changes.
- Run the most relevant tests for the files changed.
- Run `npm run typecheck` for TypeScript changes.
- Run `npm test` and `npm run build` for broad runtime, CLI, state, or packaging changes.
- Note any commands you could not run and why.
