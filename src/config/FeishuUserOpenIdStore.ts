import fs from "node:fs";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";

const USER_OPEN_ID_KEY = "FEISHU_USER_OPEN_ID";

export interface FeishuUserOpenIdPersistenceResult {
  status: "stored" | "existing";
  userOpenId: string;
}

export function persistFeishuUserOpenIdIfMissing(
  envPath: string,
  userOpenId: string,
): FeishuUserOpenIdPersistenceResult {
  if (!/^ou_[A-Za-z0-9_-]+$/u.test(userOpenId)) {
    throw new Error("Cannot persist an invalid Lark user Open ID.");
  }

  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const existing = parseDotEnv(original)[USER_OPEN_ID_KEY]?.trim();
  if (existing) return { status: "existing", userOpenId: existing };

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  writeFileAtomically(envPath, upsertDotEnvValue(original, USER_OPEN_ID_KEY, userOpenId));
  return { status: "stored", userOpenId };
}

function upsertDotEnvValue(contents: string, key: string, value: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.length > 0 ? contents.split(/\r?\n/u) : [];
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!matcher.test(line)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  while (updated.length > 0 && updated.at(-1) === "") updated.pop();
  if (!replaced) updated.push(`${key}=${value}`);
  return `${updated.join(newline)}${newline}`;
}

function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let temporaryFile: number | undefined;
  try {
    const mode = fs.statSync(filePath, { throwIfNoEntry: false })?.mode ?? 0o600;
    temporaryFile = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(temporaryFile, contents, "utf8");
    fs.fsyncSync(temporaryFile);
    fs.closeSync(temporaryFile);
    temporaryFile = undefined;
    fs.renameSync(temporaryPath, filePath);
    restrictFilePermissions(filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (temporaryFile !== undefined) fs.closeSync(temporaryFile);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function restrictFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX modes.
  }
}

function syncDirectory(directoryPath: string): void {
  let directory: number | undefined;
  try {
    directory = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directory);
  } catch {
    // Directory fsync is not supported on every Windows or mounted filesystem.
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}
