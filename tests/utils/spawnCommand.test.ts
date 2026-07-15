import { expect, test } from "vitest";
import { prepareCommand } from "../../src/utils/spawnCommand.js";

test("routes command shims through cmd.exe on Windows", () => {
  expect(prepareCommand("codex", ["app-server", "--listen", "stdio://"], "win32", "C:\\Windows\\cmd.exe")).toEqual({
    command: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server --listen stdio://"],
  });
});

test("spawns commands directly on non-Windows platforms", () => {
  expect(prepareCommand("codex", ["app-server"], "linux")).toEqual({ command: "codex", args: ["app-server"] });
});
