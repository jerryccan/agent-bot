import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveSystemSkillsRoot, SkillRegistry } from "../../src/cli/SkillRegistry.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(): { root: string; source: string; skillsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-skill-registry-"));
  directories.push(root);
  const source = path.join(root, "bundled", "agent-bot");
  const skillsRoot = path.join(root, ".agents", "skills");
  fs.mkdirSync(path.join(source, "agents"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: agent-bot\ndescription: test\n---\n", "utf8");
  fs.writeFileSync(path.join(source, "agents", "openai.yaml"), "interface: {}\n", "utf8");
  return { root, source, skillsRoot };
}

describe("SkillRegistry", () => {
  test("defaults to the system-wide agent skills directory", () => {
    expect(resolveSystemSkillsRoot({}, "C:\\Users\\tester")).toBe(path.resolve("C:\\Users\\tester", ".agents", "skills"));
    expect(resolveSystemSkillsRoot({ AGENT_BOT_SKILLS_DIR: "D:\\shared-skills" }, "ignored"))
      .toBe(path.resolve("D:\\shared-skills"));
  });

  test("registers, updates, and unregisters its managed skill", () => {
    const { source, skillsRoot } = fixture();
    const registry = new SkillRegistry(source, skillsRoot);

    expect(registry.status()).toMatchObject({ registered: false, managed: false, upToDate: false });
    expect(registry.install()).toMatchObject({ updated: true, status: { registered: true, managed: true, upToDate: true } });
    expect(fs.readFileSync(path.join(registry.targetPath, "SKILL.md"), "utf8")).toContain("name: agent-bot");
    expect(registry.install()).toMatchObject({ updated: false });

    fs.appendFileSync(path.join(source, "SKILL.md"), "\nupdated\n", "utf8");
    expect(registry.status().upToDate).toBe(false);
    expect(registry.install()).toMatchObject({ updated: true, status: { upToDate: true } });

    expect(registry.uninstall()).toBe(true);
    expect(fs.existsSync(registry.targetPath)).toBe(false);
    expect(registry.uninstall()).toBe(false);
  });

  test("refuses to replace or remove an unmanaged skill", () => {
    const { source, skillsRoot } = fixture();
    const target = path.join(skillsRoot, "agent-bot");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "user content", "utf8");
    const registry = new SkillRegistry(source, skillsRoot);

    expect(registry.status()).toMatchObject({ registered: true, managed: false, upToDate: false });
    expect(() => registry.install()).toThrow("not managed by Agent Bot");
    expect(() => registry.uninstall()).toThrow("Refusing to remove");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("user content");
  });
});
