import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  generateGroupAvatarPng,
  groupAvatarLabel,
  resolveGroupAvatarProjectName,
} from "../../src/feishu/GroupAvatarGenerator.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("GroupAvatarGenerator", () => {
  test.each([
    ["Agent Bot", "Agent"],
    ["task-runner", "task"],
    ["广州天气", "广州天气"],
    ["智能客服自动化平台", "智能客服"],
  ])("derives the avatar label from %s", (projectName, expected) => {
    expect(groupAvatarLabel(projectName)).toBe(expected);
  });

  test("prefers package.json name and falls back to the project directory", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "group-avatar-project-"));
    temporaryDirectories.push(project);
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "@scope/agent-bot" }));
    expect(resolveGroupAvatarProjectName(project, "Fallback")).toBe("agent-bot");
    fs.rmSync(path.join(project, "package.json"));
    expect(resolveGroupAvatarProjectName(project, "Fallback")).toBe(path.basename(project));
    expect(resolveGroupAvatarProjectName(undefined, "广州天气")).toBe("广州天气");
  });

  test("renders a deterministic 512 by 512 PNG", () => {
    const first = generateGroupAvatarPng("agent-bot");
    const second = generateGroupAvatarPng("agent-bot");
    expect(first).toEqual(second);
    expect(Array.from(first.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = Buffer.from(first).subarray(16, 24);
    expect(view.readUInt32BE(0)).toBe(512);
    expect(view.readUInt32BE(4)).toBe(512);
    expect(first.byteLength).toBeLessThan(10 * 1024 * 1024);
  });

  test("uses the full project path as the visual seed", () => {
    const firstProject = path.join(os.tmpdir(), "workspace-a", "aha");
    const secondProject = path.join(os.tmpdir(), "workspace-b", "aha");
    const first = generateGroupAvatarPng("aha", firstProject);

    expect(generateGroupAvatarPng("aha", firstProject)).toEqual(first);
    expect(generateGroupAvatarPng("aha", secondProject)).not.toEqual(first);
  });
});
