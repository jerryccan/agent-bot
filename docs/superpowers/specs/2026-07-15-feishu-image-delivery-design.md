# Feishu Image Tool and Delivery Design

## Goal

Make image-related Codex activity and final answers complete in Feishu. The progress card must show `imageView` tool calls, and final answers that reference local screenshots must contain real Feishu-hosted, previewable images instead of dead local-file links.

## Reasoning and Tool Semantics

- Reasoning summaries remain visible text. They describe Codex's current intent and do not have a protocol-level result.
- Results belong only to tool items. The UI must not invent a result for a reasoning summary.
- Codex App Server `imageView` items are mapped to normal tool lifecycle events.
- An `imageView` tool uses the original local path and renders as `view_image <path>` in its collapsed tool panel.
- `imageView` has no textual result in the App Server schema. Completion is communicated by the existing success icon and panel color.
- Item types without a `status` field use the notification phase: `item/started` is running and `item/completed` is completed.

## Local Image Detection

- Inspect final Markdown for both image syntax (`![label](path)`) and ordinary links (`[label](path)`).
- Treat a link as a local image only when its target is an absolute local path, has a supported image extension, and points to an existing regular file.
- Supported extensions are PNG, JPEG/JPG, GIF, WEBP, TIFF, BMP, and ICO.
- Web URLs and non-image local links remain unchanged.

## Feishu Delivery

- Upload each detected local image through the Feishu IM image API with `image_type=message`.
- Replace the local Markdown link with an interactive-card `img` element using the returned `image_key`.
- Set `preview: true`, `mode: fit_horizontal`, and use the Markdown label as image title and alt text.
- Preserve the original ordering of text and images in a single final interactive card.
- Keep the existing final-message UUID so message retries remain idempotent.
- If the same path appears more than once in a chunk, upload it once and reuse its key.

## Failure Handling

- A missing or unsupported local path remains ordinary Markdown and does not trigger an upload.
- If a detected image upload fails, do not fail the full final answer. Replace that link with a concise visible notice containing the label and log the upload error.
- Existing retry behavior for the final message send remains unchanged.

## Verification

- Mapper tests cover `imageView` started and completed notifications and phase-derived status.
- Message-client tests cover local image detection, upload, card element order, preview fields, duplicate-path reuse, and graceful upload failure.
- Existing no-image Markdown behavior and stable UUID behavior remain covered.
- A production card containing an actual local screenshot is sent to Feishu and read back as an interactive card with an image resource.
