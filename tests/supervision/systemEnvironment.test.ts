import { describe, expect, test, vi } from "vitest";
import {
  mergeWindowsEnvironment,
  refreshedSystemEnvironment,
} from "../../src/supervision/systemEnvironment.js";

describe("mergeWindowsEnvironment", () => {
  test("applies fresh Machine and User values while retaining process-local values", () => {
    const environment = mergeWindowsEnvironment({
      PATH: "C:\\OldTools;C:\\ProcessOnly",
      SystemRoot: "C:\\Windows",
      SHARED: "old",
      TRANSIENT: "keep",
      AGENT_BOT_HOME: "C:\\Profiles\\rescue",
      FEISHU_APP_ID: "profile-app",
    }, {
      machine: {
        Path: "%SystemRoot%\\System32;C:\\Tools",
        SHARED: "machine",
        MACHINE_ONLY: "yes",
        AGENT_BOT_HOME: "C:\\Profiles\\main",
      },
      user: {
        PATH: "C:\\Users\\me\\bin;C:\\Tools\\",
        SHARED: "user",
        USER_ONLY: "yes",
        FEISHU_APP_ID: "global-app",
      },
    });

    expect(environment).toMatchObject({
      Path: "C:\\Windows\\System32;C:\\Tools;C:\\Users\\me\\bin;C:\\OldTools;C:\\ProcessOnly",
      SHARED: "user",
      TRANSIENT: "keep",
      MACHINE_ONLY: "yes",
      USER_ONLY: "yes",
      AGENT_BOT_HOME: "C:\\Profiles\\rescue",
      FEISHU_APP_ID: "profile-app",
    });
    expect(Object.keys(environment).filter((name) => name.toLowerCase() === "path")).toHaveLength(1);
  });
});

describe("refreshedSystemEnvironment", () => {
  test("does not query Windows environment values on other platforms", () => {
    const loader = vi.fn();

    expect(refreshedSystemEnvironment({ PATH: "original" }, "linux", loader)).toEqual({
      environment: { PATH: "original" },
      refreshed: false,
      pathChanged: false,
    });
    expect(loader).not.toHaveBeenCalled();
  });

  test("reports a changed Path after a successful Windows refresh", () => {
    const result = refreshedSystemEnvironment({ PATH: "C:\\Old" }, "win32", () => ({
      machine: { Path: "C:\\Windows" },
      user: { Path: "C:\\Users\\me\\bin" },
    }));

    expect(result).toMatchObject({ refreshed: true, pathChanged: true });
    expect(result.environment.Path).toBe("C:\\Windows;C:\\Users\\me\\bin;C:\\Old");
  });

  test("falls back to the inherited environment when refresh fails", () => {
    const result = refreshedSystemEnvironment({ PATH: "original" }, "win32", () => {
      throw new Error("registry unavailable");
    });

    expect(result).toEqual({
      environment: { PATH: "original" },
      refreshed: false,
      pathChanged: false,
      error: "registry unavailable",
    });
  });
});
