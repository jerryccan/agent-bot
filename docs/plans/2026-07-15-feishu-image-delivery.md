# Feishu Image Tool and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Codex `imageView` activity in progress cards and convert local screenshot links in final answers into real previewable Feishu images.

**Architecture:** Extend the App Server item mapper with phase-derived status for `imageView`. Add a focused local-image Markdown renderer that uploads detected files through a callback and returns ordered card elements; `FeishuMessageClient` supplies the Feishu upload implementation and continues to send one idempotent final card.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem/fetch APIs, Feishu IM image API, Feishu interactive cards.

## Global Constraints

- Reasoning summaries remain result-free text; no synthetic reasoning results.
- `imageView` renders as a separate collapsed tool with the original path.
- Detect only absolute, existing, regular local image files with supported extensions.
- Preserve final text/image order in one interactive card and enable image preview.
- Keep the existing final-message UUID.
- Image upload failure must not suppress the rest of the final answer.

---

### Task 1: Map `imageView` lifecycle events and preserve non-command tool results

**Files:**
- Modify: `src/codex/CodexEventMapper.ts`
- Test: `tests/codex/CodexEventMapper.test.ts`

**Interfaces:**
- Produces: existing `MappedCodexNotification` tool events with `kind: "image_view"`, plus MCP/dynamic tool commands and outputs derived from their original protocol payloads.

- [x] **Step 1: Write failing mapper tests**

Add started and completed `imageView` notifications with `{ id, type: "imageView", path }`. Assert the tool command is `view_image <path>`, started status is `running`, and completed status is `completed` even though the protocol item has no `status` field.

Add completed MCP and dynamic tool notifications. Assert their original `arguments`, MCP `result`, and dynamic `contentItems` are retained as formatted JSON in `command` and `output`.

- [x] **Step 2: Run mapper tests and verify RED**

Run: `npx vitest run tests/codex/CodexEventMapper.test.ts`

Expected: FAIL because `imageView` currently returns `undefined`.

- [x] **Step 3: Implement phase-derived tool status and image mapping**

Pass the notification phase into `mapTool`, use it as the fallback in `mapToolStatus`, and add:

```ts
if (type === "imageView") {
  const imagePath = stringValue(item.path) ?? "image";
  return {
    id,
    title: `查看图片 ${imagePath}`,
    kind: "image_view",
    status,
    command: `view_image ${imagePath}`,
    startedAt,
    completedAt,
  };
}
```

For MCP and dynamic tools, format the original arguments and result payload with `JSON.stringify(value, null, 2)` and assign them to the existing `command` and `output` fields without summarization.

- [x] **Step 4: Run mapper tests and verify GREEN**

Run: `npx vitest run tests/codex/CodexEventMapper.test.ts`

Expected: all mapper tests pass.

---

### Task 2: Convert local Markdown image links into card elements

**Files:**
- Create: `src/feishu/LocalImageMarkdown.ts`
- Create: `tests/feishu/LocalImageMarkdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdownWithLocalImages(markdown, uploadImage, onUploadError): Promise<Record<string, unknown>[]>`.
- `uploadImage(path)` resolves to a Feishu `image_key`.

- [x] **Step 1: Write failing renderer tests**

Use real temporary PNG files. Verify ordinary `[label](absolute.png)` and `![label](absolute.png)` become ordered `markdown`, `img`, `markdown` elements; `img` has `preview: true`, `mode: "fit_horizontal"`, and label-derived title/alt. Verify duplicate paths call `uploadImage` once. Verify HTTP URLs and missing files remain Markdown. Verify upload rejection yields a visible `图片上传失败：label` Markdown element and invokes the error callback.

- [x] **Step 2: Run renderer tests and verify RED**

Run: `npx vitest run tests/feishu/LocalImageMarkdown.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement local-image parsing and ordered rendering**

Use a Markdown link regex, `path.isAbsolute`, `path.extname`, and `fs.statSync`. Cache upload promises by resolved path. Return existing `{ tag: "markdown", content }` elements for text and:

```ts
{
  tag: "img",
  img_key: imageKey,
  alt: { tag: "plain_text", content: label },
  title: { tag: "plain_text", content: label },
  mode: "fit_horizontal",
  preview: true,
}
```

- [x] **Step 4: Run renderer tests and verify GREEN**

Run: `npx vitest run tests/feishu/LocalImageMarkdown.test.ts`

Expected: all local-image renderer tests pass.

---

### Task 3: Upload images through `FeishuMessageClient`

**Files:**
- Modify: `src/feishu/FeishuMessageClient.ts`
- Modify: `tests/feishu/FeishuMessageClient.test.ts`

**Interfaces:**
- Consumes: `renderMarkdownWithLocalImages`.
- Produces: private `uploadImage(filePath: string): Promise<string>` and final interactive cards containing image elements.

- [x] **Step 1: Write failing client tests**

Create a temporary PNG and mock token, upload, and message responses. Assert the upload request targets `/open-apis/im/v1/images` with `FormData`, the sent card contains the returned `image_key`, `preview: true`, and the stable UUID. Add a failed-upload case that still sends the answer with a visible failure notice.

- [x] **Step 2: Run client tests and verify RED**

Run: `npx vitest run tests/feishu/FeishuMessageClient.test.ts`

Expected: FAIL because `sendMarkdown` currently emits the local link unchanged and never uploads.

- [x] **Step 3: Implement upload and card composition**

Read the local file, reject files larger than 10 MiB, POST a multipart form with `image_type=message`, validate `data.image_key`, and let `sendMarkdown` use the ordered elements returned by `renderMarkdownWithLocalImages`. Log upload failures through the existing logger.

- [x] **Step 4: Run client and focused integration tests**

Run: `npx vitest run tests/feishu/FeishuMessageClient.test.ts tests/feishu/LocalImageMarkdown.test.ts tests/feishu/FeishuTurnPresenter.test.ts`

Expected: all focused tests pass.

- [x] **Step 5: Run full verification**

Run: `npm test`, `npm run typecheck`, and `npm run build`.

Expected: all tests pass and both TypeScript commands exit successfully.

- [x] **Step 6: Commit, restart, and test in Feishu**

```text
git add src/codex/CodexEventMapper.ts tests/codex/CodexEventMapper.test.ts src/feishu/LocalImageMarkdown.ts tests/feishu/LocalImageMarkdown.test.ts src/feishu/FeishuMessageClient.ts tests/feishu/FeishuMessageClient.test.ts docs/plans/2026-07-15-feishu-image-delivery.md
git commit -m "fix: deliver Codex screenshots in Feishu"
```

Restart Agent Bot, send a production final message referencing an existing local screenshot, read the message back, and confirm the card contains an image resource and previewable image element.
