import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKILL_NAME = "acp-bot";
const MARKER_FILE = ".acp-bot-managed.json";

interface RegistrationMarker {
  schemaVersion: 1;
  managedBy: "acp-bot";
  installedAt: string;
  sourceDigest: string;
}

export interface SkillRegistrationStatus {
  sourcePath: string;
  skillsRoot: string;
  targetPath: string;
  registered: boolean;
  managed: boolean;
  upToDate: boolean;
  sourceDigest: string;
  installedDigest?: string;
}

export function resolveSystemSkillsRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.resolve(env.ACP_BOT_SKILLS_DIR ?? path.join(homeDirectory, ".agents", "skills"));
}

export class SkillRegistry {
  readonly sourcePath: string;
  readonly skillsRoot: string;
  readonly targetPath: string;

  constructor(sourcePath: string, skillsRoot = resolveSystemSkillsRoot()) {
    this.sourcePath = path.resolve(sourcePath);
    this.skillsRoot = path.resolve(skillsRoot);
    this.targetPath = path.join(this.skillsRoot, SKILL_NAME);
    this.assertSafeTarget();
  }

  status(): SkillRegistrationStatus {
    this.assertValidSource();
    const registered = fs.existsSync(path.join(this.targetPath, "SKILL.md"));
    const managed = registered && this.readMarker()?.managedBy === "acp-bot";
    const sourceDigest = digestDirectory(this.sourcePath);
    const installedDigest = registered ? digestDirectory(this.targetPath) : undefined;
    return {
      sourcePath: this.sourcePath,
      skillsRoot: this.skillsRoot,
      targetPath: this.targetPath,
      registered,
      managed,
      upToDate: managed && installedDigest === sourceDigest,
      sourceDigest,
      installedDigest,
    };
  }

  install(): { updated: boolean; status: SkillRegistrationStatus } {
    this.assertValidSource();
    const existing = fs.existsSync(this.targetPath);
    if (existing && this.readMarker()?.managedBy !== "acp-bot") {
      throw new Error(`目标目录已存在且不由 acp-bot 管理：${this.targetPath}`);
    }

    const before = existing ? this.status() : undefined;
    if (before?.upToDate) return { updated: false, status: before };

    fs.mkdirSync(this.skillsRoot, { recursive: true });
    const temporaryPath = path.join(this.skillsRoot, `.${SKILL_NAME}.install-${process.pid}-${randomUUID()}`);
    try {
      fs.cpSync(this.sourcePath, temporaryPath, { recursive: true, errorOnExist: true });
      const marker: RegistrationMarker = {
        schemaVersion: 1,
        managedBy: "acp-bot",
        installedAt: new Date().toISOString(),
        sourceDigest: digestDirectory(this.sourcePath),
      };
      fs.writeFileSync(path.join(temporaryPath, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      if (existing) this.removeManagedTarget();
      fs.renameSync(temporaryPath, this.targetPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { recursive: true, force: true });
    }
    return { updated: true, status: this.status() };
  }

  uninstall(): boolean {
    if (!fs.existsSync(this.targetPath)) return false;
    if (this.readMarker()?.managedBy !== "acp-bot") {
      throw new Error(`拒绝删除不由 acp-bot 管理的目录：${this.targetPath}`);
    }
    this.removeManagedTarget();
    return true;
  }

  private assertValidSource(): void {
    if (!fs.existsSync(path.join(this.sourcePath, "SKILL.md"))) {
      throw new Error(`找不到内置 acp-bot Skill：${this.sourcePath}`);
    }
  }

  private assertSafeTarget(): void {
    if (path.dirname(this.targetPath) !== this.skillsRoot || path.basename(this.targetPath) !== SKILL_NAME) {
      throw new Error(`不安全的 Skill 目标路径：${this.targetPath}`);
    }
  }

  private readMarker(): RegistrationMarker | undefined {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(this.targetPath, MARKER_FILE), "utf8")) as Partial<RegistrationMarker>;
      if (marker.schemaVersion !== 1 || marker.managedBy !== "acp-bot") return undefined;
      return marker as RegistrationMarker;
    } catch {
      return undefined;
    }
  }

  private removeManagedTarget(): void {
    this.assertSafeTarget();
    fs.rmSync(this.targetPath, { recursive: true, force: true });
  }
}

function digestDirectory(directory: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(directory)) {
    const relativePath = path.relative(directory, file).replaceAll(path.sep, "/");
    if (relativePath === MARKER_FILE) continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}
