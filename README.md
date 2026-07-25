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

## 系统 Skill

项目内置了标准 `acp-bot` Skill，可通过 CLI 注册到系统通用的 `~/.agents/skills`：

```powershell
acp-bot skills install
acp-bot skills status
acp-bot skills uninstall
```

`register`/`unregister` 分别是 `install`/`uninstall` 的别名。注册采用受管复制；更新会覆盖旧的受管版本，反注册不会删除非 acp-bot 创建的同名目录。可用 `--target <skills目录>` 或 `ACP_BOT_SKILLS_DIR` 修改目标根目录。

## 启动

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

`npm start` 通过常驻 supervisor 启动 acp-bot。acp-bot 异常退出时会自动重启；连续崩溃时采用 1～30 秒指数退避，避免形成高频崩溃循环。开发调试可使用 `npm run dev` 直接运行单进程。

## acp-bot 命令行工具

构建后可以通过 npm 注册本地 `acp-bot` 命令，或直接使用 `npm run cli --`：

```powershell
npm run build
npm link
acp-bot --help
# 未执行 npm link 时：npm run cli -- server status
```

Console UI：

```powershell
acp-bot console
```

Console UI 默认拒绝与已运行的 server 争用同一份任务状态；只有明确需要并理解风险时才使用 `acp-bot console --force`。

Server 管理：

```powershell
acp-bot server status
acp-bot server start
acp-bot server stop
acp-bot server restart                         # 默认安全重启
acp-bot server restart --safe --reason "部署卡片更新"
acp-bot server restart --immediate --reason "修复阻塞进程"
```

安全重启会等待所有群聊、话题和私聊任务结束，确认最终回答完成投递，并连续 15 秒没有新消息后再重启。等待期间新任务会重置空闲计时。`--immediate`（或 `--force`）跳过任务空闲判断，适合明确需要立刻替换 worker 的场景。

任务查询和管理：

```powershell
acp-bot task list
acp-bot task list --status running
acp-bot task list --context "chat_id:oc_xxx"
acp-bot task status 2
acp-bot task status 019f... --json
acp-bot task stop 019f...
acp-bot task title 2 "新的任务标题"
acp-bot task prompt 2 "继续运行测试并汇报结果"
```

序号以当前 `task list` 排序为准。任务也可以使用完整或唯一前缀形式的本地 ID、Codex task ID。查询命令直接读取持久化状态；停止、改标题和发送 Prompt 通过运行中 worker 的本地控制端点执行。`task prompt` 不会切换任何群聊的当前任务；机器人会先把 Prompt 文本发送到该任务最近一次使用的群聊、话题或私聊，发送成功后再提交给任务，思考卡片和最终回答也继续发送到同一位置。

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

`cwd` 是 ACP agent 的默认工作目录。首次创建 Codex 任务且未指定目录时，会创建真正的无项目任务：工作区位于 `~/Documents/Codex/<日期>/<任务名>`，并能被 Codex Desktop 识别到 Tasks 列表。已有当前任务时，无参数 `/new` 会继承其项目形态：项目任务复用当前项目目录，Projectless 任务创建新的 Projectless 工作区；也可以用 `/new 新任务标题 --dir D:\dev\project` 同时指定标题和项目目录。已有任务的工作目录不会在运行中改变。

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
- `/nosteer <prompt>` 会跳过 steering，将 Prompt 持久排到当前任务的后续轮次；紧凑队列卡可逐项 Cancel，多个 Prompt 按 FIFO 顺序执行
- 每个 turn 只有一张进度卡，普通更新最多每 2 秒一次，关键状态最短间隔 500ms
- 当前工具直接展示；命令行工具在执行中增量显示最近输出，并按卡片更新节流合并刷新；成功工具折叠；失败工具展开；文件变更折叠汇总
- 完成后先把进度卡更新为终态，再单独发送最终 Markdown；长代码块会安全分片
- 重启后会恢复原 Codex thread，但不会读取或重发已经发送成功的历史消息
- 卡片的“查看详情”只读取本地有界快照，不会触发 App Server 历史回放

## 命令

- 普通文本：发送给当前 Codex；没有任务时自动创建
- `/new [title] [--dir <cwd> | --nodir]`：使用当前默认 Agent 创建新任务；普通参数作为标题，`--dir` 显式指定工作目录，`--nodir` 强制创建 Projectless 任务，两者互斥；都不指定时继承当前任务的项目或 Projectless 形态
- `/newgroup [title]`：创建名为 `[agent name] title` 的私有飞书群并邀请命令发送者，不立即创建任务，同时在新群正文发送一次 Sessions 卡片；省略标题时使用 `yy-mm-dd hh:mm` 本地时间。群正文绑定任务后，把群名改为匹配当前 Agent 的 `[agent name] 新标题` 会同步修改当前任务标题
- `/fork [序号或 Codex 任务 ID]`：从当前或指定 Codex 任务创建分支任务，并立即切换到新分支；源任务正在运行时从最近已完成轮次分支，没有已完成轮次时才拒绝；序号来自最近一次 `/sessions`，新任务标题使用持久递增的 `原任务（分支 N）`
- `/title <新标题>`：修改当前任务标题；Codex 任务会同步更新 App Server 中的任务名称
- `/goal [目标]`：查看或创建当前 Codex 任务的持久 Goal；支持 `/goal pause`、`/goal resume`、`/goal edit <新目标>`、`/goal clear`，Goal 活跃时 Codex 会自动续跑
- `/nosteer <prompt>`：不修改当前执行中的 turn，将 Prompt 排入当前任务的持久队列；队列卡展示全部待执行项并支持逐项 Cancel
- `! <命令>`：在当前任务的工作目录直接执行本地命令；没有当前任务时使用默认工作目录
- `/sessions [关键词]`：用交互卡片列出同一 `CODEX_HOME` 下的 Codex 任务，默认显示 5 条，可通过 `更多任务` 每次继续展开 5 条；每个任务的正文末尾都有链接式文字操作，点击 `New` 可继承该任务的项目目录、模型、思考强度和权限模式，创建并切换到新任务；点击 `Status` 查看详情，当前任务不显示 `Switch`，其他空闲任务可点击 `Switch` 快速切换，外部运行中的任务可点击 `Stop` 发送 Interrupt
- `/switch [序号或 Codex 任务 ID]`：不带参数切回上一个任务；也可按最近一次 `/sessions` 的序号或任务 ID 切换空闲任务
- `/model`：用交互卡片显示全部支持的模型、当前模型和思考强度；点击链接式 `切换` 操作修改模型后，同一张卡片会进入该模型的思考模式选择界面
- `/model <name>`：切换模型，从下一次请求生效；不兼容的思考强度会自动回落到新模型默认值
- `/thinking`：用交互卡片显示当前思考模式及当前模型支持的模式名称，并可点击切换或返回模型选择
- `/thinking <level>`：设置思考强度，从下一次请求生效
- `/permissions auto|confirm`：切换权限模式
- `/stop`：停止当前执行

所有以 `/` 开头的消息都会严格按机器人命令解析。未知命令会直接提示用户并建议查看 `/help`，不会作为 Prompt 发送给模型；带图片的斜杠消息也遵循相同规则。
- `/status [序号或 Codex 任务 ID]`：查看当前任务，或按最近一次 `/sessions` 的序号/任务 ID 查看指定任务的详细状态、执行步骤和最终结果；Status 卡片支持点击 `刷新` 在原卡片获取最新状态
- `/restart`：优雅重启 acp-bot；可绕过阻塞的任务消息队列
- `/agent [agent]`：不带参数列出全部 Agent 并标出当前项；带参数时切换默认 Agent
- `/use <agent> [cwd]`：切换默认 agent 并创建任务
- `/help`：显示帮助

权限模式：

- `auto`（默认）：Codex 使用 `approvalPolicy=never` 和 `danger-full-access`，工具直接执行
- `confirm`：需要确认的工具会在进度卡中显示按钮，可允许一次、会话内允许、拒绝或取消

## 持久化与恢复

SQLite 默认位于 `./data/acp-bot.sqlite`，保存入口当前任务、上一个任务、Codex thread ID、模型、权限模式、排队 Prompt、进度快照和最终消息投递账本。

进程重启时会恢复持久化的活动 turn，并通过 `thread/read` 与 Codex 的真实状态校准。运行中收到新的 turn ID、线程终态通知或控制请求失败时也会重新校准；投递账本会阻止已经成功发送的最终回复被重复发送。App Server 请求均有有限超时，不会永久占住飞书消息队列。

supervisor 使用退出码 `75` 区分 `/restart` 发起的主动重启；其他意外退出同样会自动拉起。重启后的 Card 2.0 启动状态卡会显示本次重启原因，包括 `/restart`、退出码或退出信号。`/status` 会显示当前保活机制是否已启用。

### 统一 Codex 任务

`/sessions` 通过只读的 `thread/list` 发现 Codex Desktop、CLI、acp-bot 或其他 App Server 创建的任务。任务不再按创建端分类，对外统一使用 Codex 任务 ID，并为当前展示结果生成从 1 开始的序号；卡片默认显示前 5 条，点击 `更多任务` 后每次在原卡片继续展开 5 条。每个任务都显示 `New` 和 `Status`：`New` 会重新读取来源任务，并继承其项目目录、模型、思考强度和权限模式来创建新任务，然后把当前聊天切换过去；`Status` 复用 `/status <任务 ID>` 发送该任务的详细状态卡，不改变当前任务。链接式文字操作携带稳定任务 ID，不受列表顺序变化影响。空闲任务显示 `Switch`；从 acp-bot 切走但当前活跃轮次仍是由 acp-bot 触发的任务也保持 `Switch`，可以随时切回且不会中断其执行；其他外部运行中的任务显示 `Stop`，点击后只确认向 Codex 发送 Interrupt，并把原卡片操作更新为 `Switch`，后续子进程与 turn 状态由 Codex 自行维护。`/switch` 不带参数时在当前任务和上一个任务之间往返，也可以使用最近一次列表中的序号或任务 ID 切换任务；首次切换时只建立消息路由，保留原任务的工作目录和上下文，不回放历史消息。

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
