import { describe, expect, test } from "vitest";
import {
  FEISHU_GROUP_NAME_MAX_LENGTH,
  formatGroupNameDate,
  formatNewGroupName,
  groupNameOs,
  parseTaskNameFromGroupName,
} from "../../src/feishu/GroupNameFormatter.js";

describe("GroupNameFormatter", () => {
  test("preserves the default project and Projectless group names", () => {
    expect(formatNewGroupName({
      agentName: "codex",
      projectCwd: "D:\\dev\\agent-bot",
      taskName: "Fix group names",
    })).toBe("[codex] [dev\\agent-bot] Fix group names");

    expect(formatNewGroupName({
      agentName: "traex",
      taskName: "Projectless task",
    })).toBe("[traex] Projectless task");
  });

  test("renders OS, Agent, Project, task, and configurable dates", () => {
    const format = {
      project: "{os}·{agent}·{project}·{taskname}·{date}·{date:HHmm}",
      projectless: "{os}·{agent}·{taskname}·{date}",
      dateFormat: "yyyy/MM/dd",
    };
    const date = new Date(2026, 7, 20, 14, 5, 9);

    expect(formatNewGroupName({
      agentName: "codex",
      projectCwd: "D:\\work\\demo",
      taskName: "Review",
      date,
      platform: "win32",
      format,
    })).toBe("win·codex·work\\demo·Review·2026/08/20·1405");
  });

  test("extracts a renamed task title from a custom format", () => {
    const format = {
      project: "{os}/{agent}/{project}/{taskname}/{date:yyyy-MM-dd}",
      projectless: "{os}/{agent}/{taskname}/{date:yyyy-MM-dd}",
      dateFormat: "MM-dd",
    };

    expect(parseTaskNameFromGroupName({
      agentName: "codex",
      groupName: "win/codex/dev\\agent-bot/renamed task/2026-08-20",
      projectCwd: "D:\\dev\\agent-bot",
      platform: "win32",
      format,
    })).toBe("renamed task");
  });

  test("truncates the task name before the configured suffix", () => {
    const name = formatNewGroupName({
      agentName: "codex",
      taskName: "long task ".repeat(20),
      date: new Date(2026, 7, 20),
      format: {
        project: "{agent}-{project}-{taskname}-{date}",
        projectless: "{agent}-{taskname}-{date}",
        dateFormat: "yyyy-MM-dd",
      },
    });

    expect(Array.from(name)).toHaveLength(FEISHU_GROUP_NAME_MAX_LENGTH);
    expect(name).toMatch(/\.\.\.-2026-08-20$/u);
  });

  test("uses stable OS labels and common date tokens", () => {
    expect(groupNameOs("win32")).toBe("win");
    expect(groupNameOs("darwin")).toBe("mac");
    expect(groupNameOs("linux")).toBe("linux");
    expect(formatGroupNameDate(new Date(2026, 0, 2, 3, 4, 5), "yyyy-MM-dd HH:mm:ss"))
      .toBe("2026-01-02 03:04:05");
  });
});
