#!/usr/bin/env node
import { cliText } from "./cli/i18n.js";

process.stderr.write(`${cliText(
  "Warning: `agent-bot` is deprecated and will be removed in a future release. Use `agentbot` instead.",
  "警告：`agent-bot` 已弃用，并将在后续版本中移除。请改用 `agentbot`。",
)}\n`);

await import("./cli.js");
