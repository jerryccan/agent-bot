import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "agent-bot-package-"),
);

try {
  const packResult = runNpm(
    ["pack", "--pack-destination", temporaryRoot, "--silent"],
    repositoryRoot,
  );
  const tarballName = packResult.stdout
    .trim()
    .split(/\r?\n/)
    .findLast((line) => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(
      `Could not determine packed tarball name from:\n${packResult.stdout}`,
    );
  }

  const installRoot = path.join(temporaryRoot, "install");
  const homeRoot = path.join(temporaryRoot, "home");
  const mockBinRoot = path.join(temporaryRoot, "mock-bin");
  fs.mkdirSync(installRoot);
  installMockCodex(mockBinRoot);
  fs.writeFileSync(
    path.join(installRoot, "package.json"),
    JSON.stringify({ name: "agent-bot-package-smoke", private: true }, null, 2),
  );

  runNpm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      path.join(temporaryRoot, tarballName),
    ],
    installRoot,
  );

  const installedPackageRoot = path.join(
    installRoot,
    "node_modules",
    ...packageJson.name.split("/"),
  );
  const executableShims = new Map();
  for (const executable of ["agentbot", "agent-bot"]) {
    const executableShim = path.join(
      installRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${executable}.cmd` : executable,
    );
    if (!fs.existsSync(executableShim)) {
      throw new Error(`npm did not install the ${executable} executable shim.`);
    }
    executableShims.set(executable, executableShim);
  }

  const cliEntry = path.join(installedPackageRoot, "dist", "cli.js");
  const helpResult = run(process.execPath, [cliEntry, "--help"], installRoot);
  for (const expected of [packageJson.version, "agentbot server start", "-v, --version"]) {
    if (!helpResult.stdout.includes(expected)) {
      throw new Error(`Packaged CLI help is missing: ${expected}`);
    }
  }
  const versionResult = runInstalledCli(executableShims.get("agentbot"), ["--version"], installRoot);
  if (versionResult.stdout.trim() !== packageJson.version) {
    throw new Error(
      `Packaged CLI reported version ${versionResult.stdout.trim()} instead of ${packageJson.version}.`,
    );
  }
  const deprecatedVersionResult = runInstalledCli(
    executableShims.get("agent-bot"),
    ["--version"],
    installRoot,
  );
  if (deprecatedVersionResult.stdout.trim() !== packageJson.version) {
    throw new Error("Deprecated CLI entry did not forward arguments to the primary CLI.");
  }
  if (
    !deprecatedVersionResult.stderr.includes("agent-bot") ||
    !deprecatedVersionResult.stderr.includes("agentbot")
  ) {
    throw new Error("Deprecated CLI entry did not print its migration warning.");
  }
  const initializationEnvironment = {
    ...process.env,
    AGENT_BOT_HOME: homeRoot,
    NO_COLOR: "1",
    PATH: [mockBinRoot, path.dirname(process.execPath)].join(path.delimiter),
  };
  delete initializationEnvironment.AGENT_BOT_CONFIG;
  delete initializationEnvironment.AGENT_BOT_EXPLICIT_PROFILE;
  const initResult = run(
    process.execPath,
    [cliEntry, "init", "--skip-feishu", "--json"],
    installRoot,
    initializationEnvironment,
  );
  const initialized = JSON.parse(initResult.stdout);

  for (const key of ["config", "env", "data", "logs"]) {
    if (!fs.existsSync(initialized[key]?.path)) {
      throw new Error(`Packaged CLI did not initialize ${key}.`);
    }
  }
  if (initialized.server?.status !== "skipped") {
    throw new Error("Console-only initialization unexpectedly started the server.");
  }
  if (
    initialized.defaultAgent?.name !== "codex"
    || initialized.defaultAgent?.status !== "selected"
    || initialized.configuredAgents?.join(",") !== "codex"
  ) {
    throw new Error(
      `Packaged non-interactive initialization did not configure the detected Agent: ${JSON.stringify({
        agents: initialized.agents,
        configuredAgents: initialized.configuredAgents,
        defaultAgent: initialized.defaultAgent,
      })}`,
    );
  }

  const installedResources = [
    ".env.example",
    "assets/agent-bot-logo.png",
    "config.example.yaml",
    "skills/agent-bot/SKILL.md",
  ];
  for (const resource of installedResources) {
    if (!fs.existsSync(path.join(installedPackageRoot, resource))) {
      throw new Error(`Installed package is missing ${resource}.`);
    }
  }

  process.stdout.write(
    `Installed and initialized ${packageJson.name}@${packageJson.version} successfully.\n`,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const npmExecutable = process.env.npm_execpath;
  return npmExecutable
    ? run(process.execPath, [npmExecutable, ...args], cwd)
    : run("npm", args, cwd, process.env, process.platform === "win32");
}

function installMockCodex(directory) {
  fs.mkdirSync(directory);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(directory, "codex.cmd"), "@echo codex-cli 999.0.0\r\n");
    return;
  }
  fs.writeFileSync(
    path.join(directory, "codex"),
    "#!/bin/sh\nprintf 'codex-cli 999.0.0\\n'\n",
    { mode: 0o755 },
  );
}

function runInstalledCli(command, args, cwd) {
  if (!command) throw new Error("Installed CLI shim was not registered.");
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], cwd);
  }
  return run(command, args, cwd);
}

function run(command, args, cwd, env = process.env, shell = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
  }
  return result;
}
