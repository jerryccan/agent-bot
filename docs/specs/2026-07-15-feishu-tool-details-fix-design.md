# Feishu Tool Details Fix Design

## Goal

Make the Feishu experience accurately represent the active runtime and show useful tool execution details without forcing the user through a callback-only “view details” flow.

## Confirmed causes

- Feishu blocks card buttons before delivery when callback configuration is disabled, so `card.action.trigger` never reaches the bot.
- The test chat resumed a persisted `coco-yolo` ACP session while the card header was hard-coded to “Codex”.
- ACP tool start events carry command data in `rawInput`, while completion events carry output in `content`/`rawOutput`; the adapter discarded both and replaced missing completion titles with “ACP tool”.

## Design

1. The main progress card is self-contained. Successful tools stay collapsed to avoid noise, but expanding the native collapsible panel shows an explicit operation/command, exit status, and bounded result summary. The redundant callback-only “查看详情” button is removed.
2. Normal turn controls do not require card callbacks: an active card tells the user to send `/cancel`. Approval buttons remain relevant only if the user explicitly changes from the default automatic permission mode to confirmation mode.
3. `AcpRuntimeAdapter` remembers each tool call between partial updates and extracts command, description, output, error, and exit code from the ACP payload. Completion events merge with the remembered start event instead of losing the title and command.
4. The existing Feishu context is migrated once from its legacy ACP session to a fresh Codex session. Normal explicit `/use` and `/switch` behavior remains unchanged.

## UX constraints

- Completed tools are collapsed by default.
- Failed and active tools are expanded.
- Result summaries are bounded so cards remain readable and update payloads stay small.
- No historical final response is resent when a Codex thread is resumed.
- A legacy ACP session must never be labeled as Codex in operational diagnostics.

## Verification

- Card renderer tests assert no normal-flow callback button and assert labeled command/result text plus the `/cancel` fallback.
- ACP adapter tests replay captured start/completion payload shapes and assert the merged tool event.
- Existing unit, integration, typecheck, and build suites pass.
- The server is restarted, the Feishu chat is migrated to Codex, and a real Feishu prompt that runs a command is used as the smoke test.
