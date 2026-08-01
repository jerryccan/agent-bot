import net from "node:net";
import type { ControlRequest, ControlResponse } from "./controlProtocol.js";
import { cliText } from "./i18n.js";

export async function sendControlRequest(
  endpoint: string,
  request: ControlRequest,
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let input = "";
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(cliText(
      "Timed out connecting to the Agent Bot control endpoint.",
      "连接 Agent Bot 控制端点超时。",
    )))), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(input.slice(0, newline)) as ControlResponse;
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error(cliText(
        "The Agent Bot control endpoint returned no response.",
        "Agent Bot 控制端点未返回响应。",
      ))));
    });
  });
}

export async function isServerRunning(endpoint: string): Promise<boolean> {
  try {
    const response = await sendControlRequest(endpoint, { action: "health" }, 1_000);
    if (!response.ok) return false;
    if (!response.data || typeof response.data !== "object") return true;
    return (response.data as Record<string, unknown>).ready !== false;
  } catch {
    return false;
  }
}

export async function isServerReachable(endpoint: string): Promise<boolean> {
  try {
    await sendControlRequest(endpoint, { action: "health" }, 1_000);
    return true;
  } catch {
    return false;
  }
}
