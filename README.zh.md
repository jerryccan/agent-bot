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
- 模型服务临时失败时自动重试
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

### 更新

```bash
agentbot update
```

正式版默认检查稳定通道，Alpha 版默认检查 Alpha 通道。也可以使用 `--stable`、`--alpha` 或 `--version <版本>` 明确选择。服务正在运行时，Agent Bot 会等待当前任务完成后更新并自动恢复服务；源码目录和 `npm link` 安装不会被自更新命令修改。

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

完成这些步骤后，即完成了 `~/.agent-bot` 目录的初始化，Agent Bot 会立即启动。每次 `agentbot init` 成功后，机器人都会向授权用户私聊发送一张包含 Agent Bot Logo 的欢迎卡片：首次初始化会介绍主要能力，升级后初始化会展示新版亮点，同版本再次初始化则会确认 Profile 已刷新。

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

它会等待当前运行中的 Agent 任务完成后自动重启，确保所有任务都能正常执行。在飞书话题中触发时，重启状态和重启后的启动卡都会返回原话题。

启用下次用户登录时自动启动：

```bash
agentbot server autostart enable
agentbot server autostart status
```

每个 Profile 都会创建独立的操作系统启动项：Windows 使用任务计划程序，macOS 使用 LaunchAgent，Linux 使用 systemd 用户单元。如果 Windows 策略拒绝创建计划任务，Agent Bot 会自动改用当前用户的启动文件夹，无需管理员权限。Linux 如需在用户尚未登录时启动，可执行 `agentbot server autostart enable --linger`；该命令会启用用户 linger，可能需要系统授权。`server autostart disable` 只移除启动项，不停止当前正在运行的 Server；它也不会关闭 Linux linger，因为其他用户服务可能依赖 linger。

### 更新或卸载

替换或移除全局包前，先停止正在运行的服务：

```bash
agentbot server stop
npm install --global @keyou007/agent-bot@latest
agentbot init # 更新 Profile 并启动 Server
```

卸载：

```bash
agentbot server autostart disable
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
agentbot --profile ~/.agent-bot-rescue server autostart enable
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
agentbot task new <任务> [标题] [--agent <标准名>] [--dir <路径> | --nodir]
agentbot task newgroup <任务> [标题] [--agent <标准名>] [--dir <路径> | --nodir]
agentbot task fork <任务>
agentbot task forkgroup <任务> [标题]
agentbot task queue <任务> "<prompt>"
agentbot task model <任务> [模型]
agentbot task goal <任务> [操作或目标]
agentbot task turns <任务>
agentbot task reset <任务> <Turn ID>
agentbot task dir <任务> [目录]
agentbot task file <任务> <路径>
agentbot task title <任务> "<标题>"
agentbot task stop <任务>
agentbot task archive <任务>
```

`task current` 会显示当前调用 CLI 的 Codex 或 TraeX 任务详情；JSON 输出包含 Agent Bot 的 `localSessionId` 和原生 `remoteSessionId`。`<任务>` 可以是 `task list` 中的序号、任务 ID 或唯一的任务 ID 前缀。飞书中的任务、分支、排队、Agent、Provider、模型、思考强度、权限、Goal、历史 Turn、Reset、群静音、目录、文件、Shell 和重启能力都有对应的 CLI 命令；运行 `agentbot --help` 查看完整列表和参数。

`task newgroup` 会创建飞书群和新任务。默认继承源任务的 Agent 和运行设置；`--agent <标准名>` 可选择另一个已配置的 Agent，此时仍继承源任务的项目形态，但 Provider、模型、思考强度和权限模式使用目标 Agent 自己的 Runtime 默认值。`--dir` 可覆盖项目目录并支持 `~`，`--nodir` 会强制创建 Projectless App Server 任务。`task forkgroup` 从源任务最新可用的已完成 turn 创建分支，不会中断正在执行的 turn。两个命令都要求 Server 正在运行，邀请 Profile 中保存的授权用户，不会切换源会话的当前任务，并支持 `--json`。

## 飞书命令

发送 `/` 开头的消息即可执行命令。使用飞书中的 `/help` 查看最新命令列表。

| 命令                                          | 作用                         |
| --------------------------------------------- | ---------------------------- |
| `/new [标题] [--dir <路径> \| --nodir]`       | 开始新任务                   |
| `/dir [路径]`                                 | 浏览文件，或在指定目录开始任务 |
| `/sessions [关键词]`                          | 查找和管理任务               |
| `/archive [任务]`                             | 归档当前或指定任务           |
| `/switch [任务]`                              | 切换任务，或返回上一个任务   |
| `/fork [任务]`                                | 创建任务分支                 |
| `/turns`                                      | 恢复到更早的对话轮次         |
| `/status [任务]`                              | 查看任务状态                 |
| `/title <标题>`                               | 修改当前任务标题             |
| `/stop`                                       | 停止当前执行                 |
| `/queue <prompt>`                             | 在当前轮次结束后执行 Prompt  |
| `/nosteer <prompt>`                           | 与 `/queue` 相同             |
| `/goal [目标]`                                | 管理长期目标                 |
| `/provider`                                   | 选择 Provider                |
| `/model`                                      | 选择模型                     |
| `/thinking`                                   | 设置思考强度                 |
| `/permissions`                                | 设置执行权限                 |
| `/agent [名称]`                               | 选择新任务使用的 Agent       |
| `/newgroup [标题] [--dir <路径> \| --nodir]`  | 在新私有群中开始任务         |
| `/forkgroup [标题]`                           | 将任务分支到新私有群         |
| `/restart [--force]`                          | 安全重启；`--force` 会中断任务 |
| `/mute [on\|off]`                            | 设置当前群仅响应 @ 消息      |
| `/help`                                       | 显示命令帮助                 |

私聊、群正文和话题分别维护当前任务。任务运行时发送普通消息会向当前轮次追加指令；需要在本轮结束后独立执行时，使用 `/queue`。

在群聊中发送 `/mute` 或 `/mute on` 后，机器人只处理 @ 它的消息；@ 机器人并发送 `/mute off` 可恢复自动响应。该设置对群内所有话题生效。

`/new` 和 `/newgroup` 会继承当前 Agent、项目和运行设置。使用 `--dir` 指定其他目录，或使用 `--nodir` 创建无项目目录的任务；`~` 表示用户主目录。

`/fork` 和 `/forkgroup` 会从已完成的工作创建分支，不会中断正在执行的轮次。`/sessions` 用于跨项目管理任务，`/turns` 用于恢复对话上下文，不会回退本地文件。

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

默认配置 `feishu.respondToOwnerOnly: true` 只接受 `feishu.userOpenId` 所标识的机器人拥有者发送的消息和卡片操作；其他用户会在添加处理 reaction 之前被忽略。设为 `false` 可允许其他协作者使用。开启后若未配置拥有者 Open ID，Agent Bot 会忽略所有飞书用户输入，直到完成拥有者配置。

Agent Bot 会响应机器人所在群内拥有者发送的普通消息。将 `feishu.respondToAllGroupMessages` 设为 `false` 后，还会要求拥有者在群消息中 @ 当前机器人；私聊不受这一项影响。初始化仍会申请完整的群消息权限，因此以后切换该配置无需重新授权。

思考卡片默认使用分组布局：辅助 Commentary 和用户追加消息保持直接显示，每个执行组只显示最新一段原生思考，点击后可展开完整的工具命令和结果。显示命令时会省略常见的 PowerShell、zsh、bash 和 sh 启动包装前缀。失败工具仍会在自己的工具面板中标记，但不会让整个执行组显示失败图标或红色边框。执行组默认折叠，并使用稳定的组件标识，使用户在飞书中手动打开的面板在卡片更新后继续保持展开。长任务会根据完整渲染后的卡片内容大小翻页，不再使用固定的消息数或工具数。将 `feishu.thinkingCardLayout` 设为 `timeline` 可临时恢复原版布局。

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
