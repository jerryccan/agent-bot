<p align="center">
  <img src="assets/agent-bot-logo.png" alt="Agent Bot Logo" width="180">
</p>

# Agent Bot

通过飞书使用本机上的 Codex、TraeX 和兼容 ACP 的 Agent。

[English](README.md) | 简体中文

Agent Bot 运行在你的电脑上，把飞书机器人连接到本机编程 Agent。发送消息即可开始工作；执行过程中机器人会更新进度卡，完成后发送 Markdown 最终回答。

## 可以做什么

- 在飞书中使用本机已有的 Codex 或 TraeX 登录
- 创建、继续、切换、分支和停止任务
- 从任意成功完成的思考卡片重置当前对话
- 使用文字、图片、群聊和话题协作
- 排队后续 Prompt，或在任务运行中追加指令
- Agent Bot 重启后继续已有工作
- 不使用飞书时通过本地 Console UI 运行

## 快速开始

### 使用前提

- Node.js 22 或更高版本
- 至少安装一个支持的 App Server Agent：Codex 或 TraeX
- 已完成准备使用的 Agent 的本机登录

检查已安装的 Agent 和登录状态：

```bash
codex --version
codex login status
traex --version
traex login status
```

Codex 或 TraeX 中任意一个准备完成后即可继续初始化。`agentbot init` 会检查两者，并可帮助安装或升级。

### 安装

```bash
# 安装正式版
npm install --global @keyou007/agent-bot
# 如果想要使用最新功能，可以安装 Alpha 版本
# npm install --global @keyou007/agent-bot@alpha
agentbot --version
agentbot --help
```

从源码安装的方法见[技术参考](docs/technical-reference.zh.md#开发与源码安装)。

### 初始化

```bash
agentbot init
```

初始化会检测 Codex 和 TraeX，并显示已安装的版本。未安装或版本较旧的 Agent 会汇总显示对应的安装或升级命令。Agent Bot 会把配置保存到 `~/.agent-bot/config.yaml` 中。

全新的初始化，终端通常会依次显示 3 轮二维码或链接。

1. **创建机器人。** 创建带有标准基础消息配置的飞书应用，并保存 App ID、App Secret 和授权用户。该步骤不能跳过，否则 Agent Bot 无法连接飞书。创建时已经提供的权限不再在下方重复列出。
2. **添加“接收所有群消息”权限。** 创建机器人后唯一需要额外处理的核心权限是 `im:message.group_msg`，用于接收未 @ 机器人的普通群消息。飞书要求用户在开发者后台手动添加该权限。可以输入 `Y` 跳过等待；缺少该权限时，私聊仍然可用，但群成员必须 @ 机器人才会响应。
3. **补充剩余事件和回调。** 创建机器人时使用的模板已经提供 Agent Bot 所需的其他权限，第三步实际只新增：

    | 类型 | 事件或回调 | 功能 |
    | ---- | ---------- | ------------------ |
    | 事件 | `im.chat.updated_v1` | 检测群改名，把群名同步到 agent 任务标题。 |
    | 回调 | `card.action.trigger` | 卡片按钮交互。 |

完成这些步骤后，即完成了 `~/.agent-bot` 目录的初始化。Agent Bot 会自动启动，并使用飞书机器人向你发送欢迎消息，你可以开始在飞书中使用 Agent Bot 了。

Agent Bot 自带保活机制，确保在 Agent Bot，Codex 或 TraeX 崩溃后能够自动重新连接。

### 启动与停止

启动服务：

```bash
# agentbot init 会自动启动 Server，一般不需要手动启动。
agentbot server start
```

查看服务状态：

```bash
agentbot server status
```

停止服务：

```bash
agentbot server stop
```

安全重启服务：

```bash
agentbot server restart
```

他会等待当前运行中的 Agent 任务完成后自动重启，确保所有任务都能正常执行。

### 更新或卸载

替换或移除全局包前，先停止正在运行的服务：

```bash
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot init # 更新 Profile 并启动 Server
```

卸载：

```bash
agentbot server stop
npm uninstall --global @keyou007/agent-bot
```

卸载 npm 包不会删除 `~/.agent-bot` 中的用户数据。

### 多 Profile

多 Profile 支持在同一台设备上运行多个 Agent Bot 机器人，它们互相独立，互不干扰。

使用以下命令创建新 Profile：

```bash
# 指定新 profile 目录，初始化新机器人
agentbot --profile ~/.agent-bot-rescue init
agentbot --profile ~/.agent-bot-rescue server start
agentbot --profile ~/.agent-bot-rescue server status
```

不指定 `--profile` 时使用位于 `~/.agent-bot` 的主 Profile。

每个 Profile 都在所选目录内保存自己的 `config.yaml`、`.env`、`data/` 和 `logs/`，飞书凭据与本地控制端点也相互隔离。

### 重置 Profile

如需完整重新配置一个现有 Profile，请先停止它的 Server，并显式指定 Profile：

```bash
agentbot --profile ~/.agent-bot server stop # 停止主 Profile 的 Server
agentbot --profile ~/.agent-bot init --reset # 重置主 Profile
```

重置会把当前 `config.yaml`、`.env`、`data/` 和 `logs/` 移入 `.reset-backups` 目录中，再创建干净的新文件和目录。已有备份会永久保留，不会被后续重置覆盖或清理。远端旧飞书应用不会被删除。

重置不会清理 Codex 或 TraeX 的聊天会话，只会重建飞书机器人以及清理 Agent Bot 的本地数据。

## 日常命令

### Console UI/TUI

```bash
agentbot console
```

Console UI 不需要飞书凭据。除非传入 `--force`，否则不会与正在运行的 Server 共享任务状态。

### 任务管理

```bash
agentbot task list
agentbot task current [--json]
agentbot task status <任务>
agentbot task prompt <任务> "<prompt>"
agentbot task newgroup <任务> [标题] [--agent <标准名>] [--dir <路径> | --nodir]
agentbot task forkgroup <任务> [标题]
agentbot task title <任务> "<标题>"
agentbot task stop <任务>
```

`task current` 会显示当前调用 CLI 的 Codex 或 TraeX 任务详情；JSON 输出包含 Agent Bot 的 `localSessionId` 和原生 `remoteSessionId`。`<任务>` 可以是 `task list` 中的序号、任务 ID 或唯一的任务 ID 前缀。运行 `agentbot --help` 可查看完整 CLI 参数。

`task newgroup` 会创建飞书群和新任务。默认继承源任务的 Agent 和运行设置；`--agent <标准名>` 可选择另一个已配置的 Agent，此时仍继承源任务的项目形态，但 Provider、模型、思考强度和权限模式使用目标 Agent 自己的 Runtime 默认值。`--dir` 可覆盖项目目录并支持 `~`，`--nodir` 会强制创建 Projectless App Server 任务。`task forkgroup` 从源任务最新可用的已完成 turn 创建分支，不会中断正在执行的 turn。两个命令都要求 Server 正在运行，邀请 Profile 中保存的授权用户，不会切换源会话的当前任务，并支持 `--json`。

## 飞书命令

在飞书聊天框直接输入 `/` 开头的消息会作为命令处理。

| 命令                                    | 作用                       |
| --------------------------------------- | -------------------------- |
| `/new [标题] [--dir <路径> \| --nodir]` | 创建任务                   |
| `/sessions [关键词]`                    | 浏览可用的 App Server 任务 |
| `/switch [任务]`                        | 切换任务，或返回上一个任务 |
| `/fork [任务]`                          | 创建并打开任务分支         |
| `/turns`                                | 浏览历史对话轮次并重置对话 |
| `/status [任务]`                        | 查看任务进度和结果         |
| `/title <标题>`                         | 修改当前任务标题           |
| `/stop`                                 | 停止当前执行               |
| `/queue <prompt>`                       | 排队一个独立的后续 Prompt  |
| `/nosteer <prompt>`                     | 与 `/queue` 相同           |
| `/goal [目标]`                          | 查看或管理持久 Goal        |
| `/provider`                            | 打开运行设置的 Provider tab   |
| `/model`                               | 打开运行设置的 Model tab      |
| `/thinking`                            | 打开运行设置的 Thinking tab   |
| `/permissions`                         | 打开运行设置的 Permission tab |
| `/newgroup [标题] [--dir <cwd> \| --nodir]` | 为新任务创建私有群         |
| `/forkgroup [标题]`                     | 将当前位置分支到私有群     |
| `/agent [名称]`                         | 打开 Agent 设置或切换默认 Agent |
| `/restart [--force]`                    | 默认安全重启；`--force` 立即重启 |
| `/help`                                 | 显示聊天内帮助             |

斜杠命令支持任意唯一前缀，复合命令还支持首字母缩写：`/sess` 等同于 `/sessions`，`/fg` 等同于 `/forkgroup`，`/ng` 等同于 `/newgroup`，`/ns` 等同于 `/nosteer`。完整命令名优先；`/s`、`/f` 等匹配多个命令的前缀会被拒绝，并列出全部候选命令。

私聊、群正文和话题分别维护当前任务。可以单独发送图片，也可以同时发送文字和图片。任务运行中发送普通文字会追加指令；需要确保形成后续 turn 时使用 `/queue`（或 `/nosteer`）。

`/sessions` 卡片每页显示 5 个任务，通过 `Previous` 和 `Next` 原地翻页。每个任务都提供 `NewGroup` 和 `ForkGroup` 操作，可直接按所选任务创建同项目的新群，或把所选任务 Fork 到新群。

`/turns` 会打开当前任务的已完成轮次列表，每页显示 10 个 turn。每条 turn 使用独立的序号节点和缩进内容；图谱 lane 按真实父轮次绘制 Reset 产生的分支与合并，并跨分页保持连续，不再按完成时间相邻关系直接连线。当前对话位置标记为“当前”，其余记录后的 `Reset` 按钮会把对话上下文恢复到该轮完成时并将标记移动到这里，但不会回退本地文件。成功提示会显示目标轮次的 Prompt 摘要、完成时间和 Turn ID。所选位置之后原本已经完成的轮次仍会保留在历史列表中，Reset 后新分支产生的轮次也会显示；任务执行期间不能 Reset。

在话题中使用 `/forkgroup` 时，如果话题任务还没有完成过自己的 turn，则从话题原始 turn fork；完成过后则从话题任务最近完成的 turn fork。正在执行的 turn 不会作为 fork 点。

`/forkgroup` 创建新群后，群内欢迎消息会显示分支任务当前使用的 Provider、模型、思考强度和权限类型。

`/new` 和 `/newgroup` 支持相同的项目参数：使用 `--dir <cwd>` 覆盖继承的项目目录，或使用 `--nodir` 强制创建 Projectless App Server 任务，二者不能同时使用。两条命令中的 `~`、`~/...` 和 `~\...` 均表示当前用户目录。`/newgroup` 会立即在新群中创建并绑定任务，同时继续继承当前任务的 Provider、模型、思考强度和权限模式，不影响来源任务。来源聊天没有当前任务时，则使用选定 Agent 及其运行时默认设置。显式标题会同时作为群名后缀和任务标题。

`/newgroup` 省略标题时，任务标题和群名中的标题部分统一使用 `新任务 (mm-dd)`，默认群名为 `[agent] [project dir] 新任务 (mm-dd)`。Projectless 群会完全省略项目段，群名格式为 `[agent] title`。`/forkgroup` 省略标题时，任务标题和群名都与 `/fork` 一样使用持久递增的 `源标题（分支 N）`，不追加日期。`/newgroup` 和 `/forkgroup` 创建的飞书群名最多显示 60 个字符。生成后的群名过长时，Agent Bot 只截断群名中的标题部分，任务标题本身保持不变。

把已绑定任务的群改名为 `[agent] [project dir] title` 时，只会把 `title` 同步到当前任务；Agent 和工程目录前缀仅作为群元数据，不会写入任务标题。旧的 `[agent] title` 格式仍然兼容。

## 本地命令

在飞书聊天框直接输入 `!` 开头的消息会作为本地命令处理，命令会在当前任务目录执行。

比如 `! ls` 会列出当前目录下的文件，`! git status` 会显示当前 Git 仓库的状态。

## 配置与数据

Agent Bot 将用户相关文件保存在仓库之外：

| 路径                       | 用途               |
| -------------------------- | ------------------ |
| `~/.agent-bot/config.yaml` | Agent Bot 配置     |
| `~/.agent-bot/.env`        | 飞书凭据           |
| `~/.agent-bot/data/`       | 任务数据和输入缓存 |
| `~/.agent-bot/logs/`       | 运行日志           |

可通过 `AGENT_BOT_HOME` 修改用户数据目录。配置示例见 [config.example.yaml](config.example.yaml)。

Agent 进程会继承普通父进程变量及其显式配置的 `agents.<name>.env`。启动 Agent 前，Agent Bot 会移除继承的 `FEISHU_*` 凭据和内部 `AGENT_BOT_*` 状态，再仅提供带命名空间的非敏感 Profile 与 Lark 身份上下文；`FEISHU_APP_SECRET` 永远不会传入 Agent 进程。

默认情况下，Agent Bot 会响应机器人所在群内的普通消息。将 `feishu.respondToAllGroupMessages` 设为 `false` 后，群消息必须 @ 当前机器人才会响应，私聊不受影响。初始化仍会申请完整的群消息权限，因此以后切换该配置无需重新授权。

## 常见问题

- **机器人没有响应：** 运行 `agentbot server status`，并查看 `~/.agent-bot/logs/agent-bot.log`
- **Node 崩溃后 Worker 被自动重启：** 查看 `~/.agent-bot/data/last-crash.json`、`~/.agent-bot/logs/worker.stderr.log` 和 `~/.agent-bot/data/crash-reports/`
- **飞书权限不完整：** 重新运行 `agentbot init`，完成显示的授权步骤
- **Agent 无法启动：** 使用运行 Agent Bot 的同一操作系统用户执行 `codex login status` 或 `traex login status`，然后重新运行 `agentbot init` 检查版本
- **只需要本地测试：** 运行 `agentbot init --skip-feishu`，然后执行 `agentbot console`
- **安全重启一直等待：** 使用 `agentbot task list --status running` 检查活动任务

## 更多文档

- [技术参考](docs/technical-reference.zh.md)：配置、权限、路由、持久化、恢复和运行机制
- [配置示例](config.example.yaml)
- [更新日志](CHANGELOG.md)
- [Agent 开发指南](https://github.com/keyou/agent-bot/blob/master/AGENTS.md)
