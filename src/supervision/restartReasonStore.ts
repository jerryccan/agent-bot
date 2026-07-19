import fs from "node:fs";
import path from "node:path";

export function restartReasonFile(sqlitePath: string): string {
  return path.join(path.dirname(path.resolve(sqlitePath)), "acp-bot-restart-reason.json");
}

export function saveRestartReason(sqlitePath: string, reason: string): void {
  const filePath = restartReasonFile(sqlitePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ reason, requestedAt: new Date().toISOString() }), "utf8");
}

export function takeRestartReason(sqlitePath: string): string | undefined {
  const filePath = restartReasonFile(sqlitePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { reason?: unknown };
    fs.rmSync(filePath, { force: true });
    return typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;
  } catch {
    return undefined;
  }
}
