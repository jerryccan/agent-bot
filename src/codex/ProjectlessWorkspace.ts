import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ProjectlessWorkspace {
  cwd: string;
  outputDirectory: string;
  workspaceRoot: string;
}

export function createProjectlessWorkspace(options: {
  prompt?: string;
  directoryName?: string;
  homeDirectory?: string;
  now?: Date;
} = {}): ProjectlessWorkspace {
  const workspaceRoot = path.join(options.homeDirectory ?? os.homedir(), "Documents", "Codex");
  const dateDirectory = path.join(workspaceRoot, formatDate(options.now ?? new Date()));
  ensureRealDirectory(workspaceRoot);
  ensureRealDirectory(dateDirectory);

  const baseName = projectlessDirectoryName(options.directoryName, options.prompt);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    const workspace = tryCreateWorkspace(dateDirectory, name, workspaceRoot);
    if (workspace) return workspace;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const workspace = tryCreateWorkspace(dateDirectory, `${baseName}-${suffix}`, workspaceRoot);
    if (workspace) return workspace;
  }
  throw new Error("Unable to create a unique Codex projectless task directory.");
}

export function detectProjectlessWorkspace(cwd: string): ProjectlessWorkspace | undefined {
  const normalized = path.resolve(cwd);
  const match = normalized.match(/^(.*[\\/]Documents[\\/]Codex)[\\/]\d{4}-\d{2}-\d{2}[\\/][a-z0-9][a-z0-9-]*[\\/]*$/i);
  if (!match?.[1]) return undefined;
  return {
    cwd: normalized,
    outputDirectory: path.join(normalized, "outputs"),
    workspaceRoot: match[1],
  };
}

function projectlessDirectoryName(directoryName?: string, prompt?: string): string {
  const words = (directoryName ?? prompt)?.toLowerCase().match(/[a-z0-9]+/g);
  if (!words?.length) return "new-chat";
  return (directoryName === undefined ? words.slice(0, 6) : words).join("-").slice(0, 80);
}

function tryCreateWorkspace(
  dateDirectory: string,
  directoryName: string,
  workspaceRoot: string,
): ProjectlessWorkspace | undefined {
  const cwd = path.join(dateDirectory, directoryName);
  try {
    fs.mkdirSync(cwd);
  } catch (error) {
    if (isAlreadyExists(error)) return undefined;
    throw error;
  }
  const outputDirectory = path.join(cwd, "outputs");
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(path.join(cwd, "work"));
  return { cwd, outputDirectory, workspaceRoot };
}

function ensureRealDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Codex projectless task directory must be a real directory: ${directory}`);
  }
}

function formatDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
