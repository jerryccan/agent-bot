# Feishu Reasoning Timeline Design

## Summary

Present each Codex turn as a single chronological activity timeline in the Feishu progress card. User-visible reasoning summaries stay expanded, while every tool invocation occupies its own collapsed panel. The card preserves the order emitted by Codex, for example: reasoning summary 1, tool 1, reasoning summary 2, tool 2.

## User Experience

- The turn header continues to show status and elapsed time.
- Plan updates remain near the top when Codex provides a plan.
- Activity is rendered in event order, not grouped by activity type or tool status.
- A reasoning summary is an always-visible Markdown block labeled as a thinking update.
- A tool invocation is one native `collapsible_panel`; it is collapsed by default in running, completed, and failed states.
- The panel header is a one-line status plus readable tool title. Expanding it reveals the command, exit code, output or error summary, and file details when available.
- The existing file-change aggregate remains a separate collapsed summary after the timeline.
- Card updates retain the existing coalescing cadence, so reasoning deltas do not create extra chat messages or token-by-token card writes.

## Reasoning Boundary

Only App Server reasoning summaries from `item/reasoning/summaryTextDelta` are shown. Raw reasoning text from `item/reasoning/textDelta` is not exposed. Each summary is assembled by `(itemId, summaryIndex)` from incremental deltas and stored as one timeline item. `item/reasoning/summaryPartAdded` may establish an empty summary part before text arrives.

Each Codex turn requests `summary: "auto"` so supported models emit a user-readable summary. When no summary is available, the card still shows tool and plan activity normally.

## State Model

Replace the single `progressText` field and status-grouped tool presentation with an ordered bounded activity list:

```ts
type TurnActivity =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolState };
```

Reasoning events carry a stable activity ID derived from the App Server item ID and summary index. Tool lifecycle updates use the tool ID. The reducer inserts a new activity on first sight and updates the existing item in place, preserving original order.

Existing `activeTool`, `completedTools`, and `failedTools` fields remain during this change for runtime status, compatibility, and file aggregation. Card rendering uses the activity list as the authoritative chronological presentation. Persisted snapshots that predate `activities` remain readable and fall back to the legacy tool collections.

## Bounds and Sanitization

- Keep at most 40 activity items per turn, removing the oldest when the limit is exceeded.
- Bound each reasoning summary and tool detail with the existing turn-state limits.
- Deduplicate repeated reasoning deltas by stable part ID and append only new delta text.
- Remove empty reasoning blocks from rendering.
- Continue truncating command and output details inside the card to stay within Feishu card limits.

## Verification

- Mapper tests verify summary-part IDs and verify raw reasoning text is ignored.
- Runtime tests verify `turn/start` requests `summary: "auto"`.
- Reducer tests verify reasoning/tool/reasoning/tool order survives tool lifecycle updates.
- Renderer tests verify visible reasoning blocks, one collapsed panel per tool, chronological element order, and detailed content inside each panel.
- Existing resume-delivery tests verify no historical final messages are resent.

