# Windows DPI-Aware Screenshot Design

## Problem

Codex generated a PowerShell screenshot command that loaded `System.Windows.Forms` before enabling DPI awareness. On a dual-monitor Windows desktop scaled to 200%, the process saw logical bounds of `3840×1080` instead of the physical virtual desktop bounds of `7680×2160`. `Graphics.CopyFromScreen` therefore captured only part of the desktop.

## Design

`acp-bot` will attach a concise Windows screenshot rule to every Codex thread at the trusted app-server developer-instruction layer. The same instruction is sent on `thread/start`, explicit `thread/resume`, and the lazy `thread/resume` performed after an app-server disconnect.

The instruction requires screenshot commands to:

- call `SetProcessDpiAwarenessContext((IntPtr)-4)` in a fresh process before loading WinForms or querying screen bounds;
- use the physical monitor or virtual-desktop bounds reported after DPI awareness is enabled;
- validate the saved image dimensions against the requested physical capture region.

The user prompt remains unchanged and the instruction is not rendered in Feishu cards. No screenshot daemon, global DPI setting, or workspace file is introduced.

## Verification

- A protocol-level unit test checks all thread creation and resume paths for the instruction.
- The focused runtime tests, full test suite, typecheck, and production build must pass.
- A live Codex request must produce a screenshot whose dimensions match the DPI-aware virtual desktop bounds (`7680×2160` on the current machine), and the result must be delivered as a Feishu image.
