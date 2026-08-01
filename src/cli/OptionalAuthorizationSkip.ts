import { createInterface, type Interface } from "node:readline";
import { cliText } from "./i18n.js";

export interface OptionalAuthorizationSkipListener {
  close(): void;
}

export function listenForOptionalAuthorizationSkip(
  onSkip: () => void,
): OptionalAuthorizationSkipListener {
  return listenForAuthorizationSkip(onSkip, {
    prompt: cliText(
      "Skip optional authorization? Enter Y and press Enter to skip.\n",
      "是否跳过可选授权？输入 Y 并按回车键跳过。\n",
    ),
    retry: cliText(
      "Enter Y to skip optional authorization, or keep waiting.\n",
      "输入 Y 跳过可选授权，或继续等待。\n",
    ),
    skipped: cliText(
      "Optional authorization skipped. Initialization will continue.\n",
      "已跳过可选授权，初始化将继续。\n",
    ),
  });
}

export function listenForManualPermissionSkip(
  onSkip: () => void,
): OptionalAuthorizationSkipListener {
  return listenForAuthorizationSkip(onSkip, {
    prompt: cliText(
      "Skip waiting for this permission? Enter Y and press Enter to skip.\n",
      "是否跳过等待此权限？输入 Y 并按回车键跳过。\n",
    ),
    retry: cliText(
      "Enter Y to skip this permission, or keep waiting.\n",
      "输入 Y 跳过此权限，或继续等待。\n",
    ),
    skipped: cliText(
      "Permission wait skipped. Initialization will continue with limited group-message functionality.\n",
      "已跳过权限等待，初始化将继续，但群消息功能受限。\n",
    ),
  });
}

function listenForAuthorizationSkip(
  onSkip: () => void,
  messages: { prompt: string; retry: string; skipped: string },
): OptionalAuthorizationSkipListener {
  if (!process.stdin.isTTY) return { close: () => undefined };

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeReadline(readline, onLine);
  };
  const onLine = (value: string): void => {
    if (!isOptionalAuthorizationSkip(value)) {
      process.stderr.write(messages.retry);
      return;
    }
    process.stderr.write(messages.skipped);
    close();
    onSkip();
  };
  readline.on("line", onLine);
  process.stderr.write(messages.prompt);
  return { close };
}

export function isOptionalAuthorizationSkip(value: string): boolean {
  return value.trim().toLowerCase() === "y";
}

function closeReadline(readline: Interface, onLine: (value: string) => void): void {
  readline.removeListener("line", onLine);
  readline.close();
}
