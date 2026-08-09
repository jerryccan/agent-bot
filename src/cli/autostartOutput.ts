import type { AutostartRegistrationStatus } from "./AutostartManager.js";
import { cliLanguage, cliText, type CliLanguage } from "./i18n.js";

export interface AutostartServerStatus {
  running: boolean;
  ready: boolean;
}

export interface CombinedAutostartStatus {
  registration: AutostartRegistrationStatus;
  server: AutostartServerStatus;
}

export function formatAutostartStatus(
  status: CombinedAutostartStatus,
  language: CliLanguage = cliLanguage,
): string {
  const registration = status.registration;
  const enabled = registration.supported
    ? registration.enabled
      ? cliText("enabled", "已启用", language)
      : cliText("disabled", "未启用", language)
    : cliText("unsupported", "不支持", language);
  const server = !status.server.running
    ? cliText("not running", "未运行", language)
    : status.server.ready
      ? cliText("running", "运行中", language)
      : cliText("starting", "启动中", language);
  const lines = [
    `${cliText("Agent Bot autostart: ", "Agent Bot 自启动：", language)}${enabled}`,
    `${cliText("Platform: ", "平台：", language)}${platformLabel(registration.platform, language)}`,
    `${cliText("Profile: ", "Profile：", language)}${registration.profilePath}`,
    `${cliText("Config: ", "配置：", language)}${registration.configPath}`,
  ];
  if (registration.name) {
    lines.push(`${cliText("Registration: ", "启动项：", language)}${registration.name}`);
  }
  if (registration.definitionPath) {
    lines.push(`${cliText("Definition: ", "定义文件：", language)}${registration.definitionPath}`);
  }
  if (registration.mechanism) {
    const mechanism = registration.mechanism === "task-scheduler"
      ? "Task Scheduler"
      : registration.mechanism === "startup-folder"
        ? cliText("Startup folder", "启动文件夹", language)
        : registration.mechanism === "launch-agent"
          ? "LaunchAgent"
          : "systemd";
    lines.push(`${cliText("Mechanism: ", "启动机制：", language)}${mechanism}`);
  }
  if (registration.trigger) {
    lines.push(`${cliText("Trigger: ", "触发方式：", language)}${registration.trigger === "boot"
      ? cliText("system boot (systemd linger enabled)", "系统启动（已启用 systemd linger）", language)
      : cliText("user login", "用户登录", language)}`);
  }
  if (registration.loaded !== undefined) {
    lines.push(`${cliText("Loaded by OS: ", "操作系统已加载：", language)}${registration.loaded
      ? cliText("yes", "是", language)
      : cliText("no", "否", language)}`);
  }
  if (registration.platform === "linux") {
    lines.push(`${cliText("Systemd linger: ", "Systemd linger：", language)}${registration.linger
      ? cliText("enabled", "已启用", language)
      : cliText("disabled", "未启用", language)}`);
  }
  lines.push(`${cliText("Agent Bot server: ", "Agent Bot 服务：", language)}${server}`, "");
  return lines.join("\n");
}

function platformLabel(platform: NodeJS.Platform, language: CliLanguage): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return cliText(`${platform} (unsupported)`, `${platform}（不支持）`, language);
}
