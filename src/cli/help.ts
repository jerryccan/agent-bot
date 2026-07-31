export type CliLanguage = "en" | "zh";

export function resolveCliLanguage(
  env: NodeJS.ProcessEnv = process.env,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
): CliLanguage {
  const configuredLocale = [
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANGUAGE,
    env.LANG,
  ].find((value) => value?.trim());
  return isChineseLocale(configuredLocale ?? systemLocale) ? "zh" : "en";
}

export function renderCliHelp(version: string, language = resolveCliLanguage()): string {
  return language === "zh" ? renderChineseHelp(version) : renderEnglishHelp(version);
}

function renderChineseHelp(version: string): string {
  return `Agent Bot ${version}
通过飞书/Lark 使用本机 Codex 与 ACP Agent。

用法：
  agent-bot [选项] <命令>

常用命令：
  init                              初始化配置、数据目录和飞书应用
  console                           打开本地 Console
  server start                      在后台启动 Agent Bot
  server status                     查看服务和安全重启状态
  server restart                    安排安全重启
  server stop                       停止 Agent Bot
  task list                         列出任务
  task status <task>                查看任务状态
  task chat <task>                  查看任务绑定的飞书会话
  task prompt <task> <prompt>       向指定任务发送 Prompt
  task stop <task>                  停止指定任务
  task title <task> <title>         修改任务标题
  skills status                     查看内置 Skill 状态
  skills install                    安装内置 Skill

选项：
  --profile <directory>             使用指定目录中的独立 Profile
  --config <path>                   使用指定配置文件
  --json                            在支持的命令中输出 JSON
  -h, --help                        显示帮助
  -v, --version                     显示版本

示例：
  agent-bot init
  agent-bot --profile ~/.agent-bot-rescue init
  agent-bot server start
  agent-bot server status
  agent-bot task list
  agent-bot server restart --reason "升级 Agent Bot"
`;
}

function renderEnglishHelp(version: string): string {
  return `Agent Bot ${version}
Use local Codex and ACP agents from Lark/Feishu.

Usage:
  agent-bot [options] <command>

Common commands:
  init                              Initialize config, data directories, and the Lark app
  console                           Open the local console
  server start                      Start Agent Bot in the background
  server status                     Show server and safe-restart status
  server restart                    Schedule a safe restart
  server stop                       Stop Agent Bot
  task list                         List tasks
  task status <task>                Show task status
  task chat <task>                  Show the task's Lark chat binding
  task prompt <task> <prompt>       Send a Prompt to a task
  task stop <task>                  Stop a task
  task title <task> <title>         Rename a task
  skills status                     Show the built-in Skill status
  skills install                    Install the built-in Skill

Options:
  --profile <directory>             Use an isolated profile directory
  --config <path>                   Use a specific config file
  --json                            Print JSON when supported
  -h, --help                        Show help
  -v, --version                     Show version

Examples:
  agent-bot init
  agent-bot --profile ~/.agent-bot-rescue init
  agent-bot server start
  agent-bot server status
  agent-bot task list
  agent-bot server restart --reason "Update Agent Bot"
`;
}

function isChineseLocale(value: string): boolean {
  const locale = value.trim().split(":")[0]?.split(/[.@]/)[0]?.replaceAll("_", "-").toLowerCase();
  return locale === "zh" || Boolean(locale?.startsWith("zh-"));
}
