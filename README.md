# acp-bot：通过飞书使用本机 Codex

`acp-bot` 把本机 Codex App Server 接到飞书机器人，并保留一个并行的命令行入口用于测试。飞书是主界面：每次请求只创建一张进度卡，卡片会原地更新；完成后再单独发送最终 Markdown 回复。

## 使用前提

- Node.js 20+
- 已安装 Codex CLI，并能在运行机器上执行 `codex`
- 用运行 `acp-bot` 的同一个系统用户完成过 Codex 登录

检查登录状态：

```powershell
codex login status
```

App Server 直接复用本机 Codex 的登录状态，不需要机器人用户或飞书侧再次登录 ChatGPT。若通过服务账号启动，需要确保它与登录 Codex 时使用相同的 `CODEX_HOME` 和凭证目录。

## 启动

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

`npm start` 通过常驻 supervisor 启动 acp-bot。acp-bot 异常退出时会自动重启；连续崩溃时采用 1～30 秒指数退避，避免形成高频崩溃循环。开发调试可使用 `npm run dev` 直接运行单进程。

填入 `.env`：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
ACP_BOT_CONFIG=./agents.yaml
```

默认会同时启动：

- 飞书 WebSocket 长连接（配置凭证时）
- 本地测试终端（`console.enabled: true`）

两条入口各自维护当前任务，不会互相切换会话。未配置飞书凭证时，仍可直接在终端测试 Codex。

## Codex 配置

默认 `agents.yaml` 已包含：

```yaml
console:
  enabled: true

agents:
  codex:
    kind: "codex"
    title: "Codex"
    command: "codex"
    args:
      - "app-server"
      - "--listen"
      - "stdio://"
    env: {}

defaults:
  agent: "codex"
  cwd: "."
```

`cwd` 是 ACP agent 的默认工作目录。首次创建 Codex 任务且未指定目录时，会创建真正的无项目任务：工作区位于 `~/Documents/Codex/<日期>/<任务名>`，并能被 Codex Desktop 识别到 Tasks 列表。已有当前任务时，无参数 `/new` 会继承其项目形态：项目任务复用当前项目目录，Projectless 任务创建新的 Projectless 工作区；也可以用 `/new D:\dev\project` 显式指定项目目录。已有任务的工作目录不会在运行中改变。

## 飞书应用配置

企业自建应用需要：

- 开启机器人能力
- 使用长连接接收事件
- 订阅 `im.message.receive_v1`
- 订阅 `card.action.trigger`
- 开通机器人收发消息、发送卡片和更新消息所需权限
- 开通 `im:message.reactions:write_only`，用于添加和替换消息处理状态表情
- 开通 `im:message:readonly`，用于下载用户消息中的图片

消息体验：

- 收到消息并完成去重后，先在原消息上添加 `OnIt` 表情；任务完成后替换为 `DONE`，失败替换为 `ERROR`，取消替换为 `CrossMark`。消息与 Codex turn 的绑定会持久化，重启恢复后仍可补齐终态；表情操作失败不会阻断任务处理
- 私聊正文和群正文分别按 `chat_id` 隔离当前任务；群正文中 @ 机器人后的文本会作为命令或提示词处理，机器人直接在群正文回复，不会主动创建话题
- 私聊和群聊采用统一的话题逻辑：只要收到的消息带有 `thread_id`，该话题就拥有独立当前任务，命令、卡片回调、思考卡与最终回答都留在话题中
- 在用户消息、思考卡或最终回答上创建话题后，话题内第一条消息会通过 Codex `thread/fork` 从来源轮次创建独立任务；来源轮次仍在执行或无法映射时不会猜测 fork 位置，而会明确报错；新任务会重命名为 `原任务（分支 N）`
- 直接发文字时，若没有当前任务会自动创建 Codex thread
- 可以直接发送单张图片，或发送同一条富文本中的文字和图片；图片会缓存到 SQLite 同目录下的 `inbound-images` 并作为 Codex `localImage` 输入，纯图片默认按“请分析这张图片”处理。ACP Agent 不支持图片输入时会明确报错，不会静默丢图
- Codex 运行中继续发文字，会通过 steering 追加到当前 turn；若恰好完成，则自动排为下一次请求
- 每个 turn 只有一张进度卡，普通更新最多每 2 秒一次，关键状态最短间隔 500ms
- 当前工具直接展示；命令行工具在执行中增量显示最近输出，并按卡片更新节流合并刷新；成功工具折叠；失败工具展开；文件变更折叠汇总
- 完成后先把进度卡更新为终态，再单独发送最终 Markdown；长代码块会安全分片
- 重启后会恢复原 Codex thread，但不会读取或重发已经发送成功的历史消息
- 卡片的“查看详情”只读取本地有界快照，不会触发 App Server 历史回放

## 命令

- 普通文本：发送给当前 Codex；没有任务时自动创建
- `/new [cwd]`：使用当前默认 Agent 创建新任务；未指定目录时继承当前任务的项目或 Projectless 形态
- `/fork [序号或 Codex 任务 ID]`：从当前或指定 Codex 任务的最新已结束轮次创建分支任务，并立即切换到新分支；序号来自最近一次 `/sessions`，新任务标题使用持久递增的 `原任务（分支 N）`
- `/title <新标题>`：修改当前任务标题；Codex 任务会同步更新 App Server 中的任务名称
- `/sessions [关键词]`：用交互卡片列出同一 `CODEX_HOME` 下的 Codex 任务，默认显示 5 条，可通过 `更多任务` 每次继续展开 5 条；每个任务的正文末尾都有链接式文字操作，点击 `Status` 查看详情，当前任务不显示 `Switch`，其他空闲任务可点击 `Switch` 快速切换，外部运行中的任务可点击 `Stop` 发送 Interrupt
- `/switch [序号或 Codex 任务 ID]`：不带参数切回上一个任务；也可按最近一次 `/sessions` 的序号或任务 ID 切换空闲任务
- `/model`：显示全部支持的模型、当前模型和思考强度
- `/model <name>`：切换模型，从下一次请求生效；不兼容的思考强度会自动回落到新模型默认值
- `/thinking`：显示当前思考强度及当前模型支持的可选值
- `/thinking <level>`：设置思考强度，从下一次请求生效
- `/permissions auto|confirm`：切换权限模式
- `/stop`：停止当前执行
- `/status [序号或 Codex 任务 ID]`：查看当前任务，或按最近一次 `/sessions` 的序号/任务 ID 查看指定任务的详细状态、执行步骤和最终结果
- `/restart`：优雅重启 acp-bot；可绕过阻塞的任务消息队列
- `/agent [agent]`：不带参数列出全部 Agent 并标出当前项；带参数时切换默认 Agent
- `/use <agent> [cwd]`：切换默认 agent 并创建任务
- `/help`：显示帮助

权限模式：

- `auto`（默认）：Codex 使用 `approvalPolicy=never` 和 `danger-full-access`，工具直接执行
- `confirm`：需要确认的工具会在进度卡中显示按钮，可允许一次、会话内允许、拒绝或取消

## 持久化与恢复

SQLite 默认位于 `./data/acp-bot.sqlite`，保存入口当前任务、上一个任务、Codex thread ID、模型、权限模式、进度快照和最终消息投递账本。

进程重启时会恢复持久化的活动 turn，并通过 `thread/read` 与 Codex 的真实状态校准。运行中收到新的 turn ID、线程终态通知或控制请求失败时也会重新校准；投递账本会阻止已经成功发送的最终回复被重复发送。App Server 请求均有有限超时，不会永久占住飞书消息队列。

supervisor 使用退出码 `75` 区分 `/restart` 发起的主动重启；其他意外退出同样会自动拉起。`/status` 会显示当前保活机制是否已启用。

### 统一 Codex 任务

`/sessions` 通过只读的 `thread/list` 发现 Codex Desktop、CLI、acp-bot 或其他 App Server 创建的任务。任务不再按创建端分类，对外统一使用 Codex 任务 ID，并为当前展示结果生成从 1 开始的序号；卡片默认显示前 5 条，点击 `更多任务` 后每次在原卡片继续展开 5 条。每个任务都显示 `Status`，点击后复用 `/status <任务 ID>` 发送该任务的详细状态卡，不改变当前任务。链接式文字操作携带稳定任务 ID，不受列表顺序变化影响。空闲任务显示 `Switch`；从 acp-bot 切走但当前活跃轮次仍是由 acp-bot 触发的任务也保持 `Switch`，可以随时切回且不会中断其执行；其他外部运行中的任务显示 `Stop`，点击后只确认向 Codex 发送 Interrupt，并把原卡片操作更新为 `Switch`，后续子进程与 turn 状态由 Codex 自行维护。`/switch` 不带参数时在当前任务和上一个任务之间往返，也可以使用最近一次列表中的序号或任务 ID 切换任务；首次切换时只建立消息路由，保留原任务的工作目录和上下文，不回放历史消息。

内部仍保存一个本地路由键，用于关联飞书卡片、投递账本和当前聊天，但它不代表另一类任务，也不会在用户界面中显示。为避免干扰其他 Codex 客户端，acp-bot 只会续写自己启动的当前 turn；首次加载以及每次继续消息前都会核对真实 turn ID。若任务正在其他客户端执行，acp-bot 不会 `resume` 或 `steer`；只有用户在 `/sessions` 卡片中明确点击 `Stop` 时才会发送 `interrupt`。

## 保留 ACP Agent

未写 `kind` 的 agent 仍按 `acp` 处理：

```yaml
agents:
  example:
    kind: "acp"
    title: "Example ACP Agent"
    command: "node"
    args: ["./examples/example-acp-agent.js"]
```

Codex 是默认入口。`/agent` 用于查看或设置后续新任务的默认 Agent；`/use` 用于切换默认 Agent 并立即创建任务；`/new` 始终使用当前默认 Agent。
