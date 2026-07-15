# Feishu Compact Card Design

## Summary

Make Codex progress cards read like a concise terminal activity stream. Remove explanatory labels that repeat information already conveyed by the card header, status icon, ordering, or code-block formatting.

## Turn Layout

- Keep the colored card header as the only turn-status label: `Codex 正在处理`, `Codex 已完成`, `Codex 执行失败`, or `Codex 已停止`.
- Show elapsed time as a plain value such as `51.6s`; remove the `状态` and `耗时` labels.
- Render plan steps directly without a `计划` heading.
- Render each reasoning summary as its original text without a `思考` heading, icon, or bold wrapper.
- Preserve the existing chronological reasoning/tool order.
- Remove the routine `/cancel` instruction from the card body.

## Tool Layout

- Keep one collapsed panel per tool.
- The panel header contains only a status icon and a single-line tool/command summary.
- The header uses `...` when truncated.
- Expanding the panel shows the command or tool name in the first code block.
- Show output, error, or file-change summary in a second code block when available.
- Do not render the labels `工具`, `状态`, `命令`, `退出码`, `耗时`, `文件`, `错误摘要`, or `结果摘要`.
- The status icon and panel color communicate running, success, or failure; numeric exit codes are omitted from the card.

## Truncation and Output Cleanup

- Replace the current explanatory truncation suffix with a trailing `...` only.
- Keep the returned string within the requested maximum length, including the suffix.
- Strip ANSI terminal escape sequences from code-block content.
- Preserve safe Markdown fences by replacing embedded triple backticks.

## Exceptional States

- Approval cards retain the approval title and buttons because they require user action, but commands remain code blocks without redundant labels.
- Turn errors render directly as a code block without an `错误` heading.
- The existing collapsed file-change aggregate remains available; it is separate from individual tool details.
- Startup and status cards keep their field labels because those cards are structured status reports, not activity timelines.

## Verification

- Unit tests assert that routine turn cards omit every removed label and explanatory truncation message.
- Tests assert raw reasoning text, elapsed value, command blocks, result blocks, chronological order, and one collapsed panel per tool.
- Truncation tests assert a trailing `...` and maximum-length preservation.
- A production-renderer card is sent to Feishu after restart and read back to confirm the compact structure.

