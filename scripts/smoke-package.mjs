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
  fs.mkdirSync(installRoot);
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
  const executableShim = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-bot.cmd" : "agent-bot",
  );
  if (!fs.existsSync(executableShim)) {
    throw new Error("npm did not install the agent-bot executable shim.");
  }

  const cliEntry = path.join(installedPackageRoot, "dist", "cli.js");
  const helpResult = run(process.execPath, [cliEntry, "--help"], installRoot);
  for (const expected of [packageJson.version, "agent-bot server start", "-v, --version"]) {
    if (!helpResult.stdout.includes(expected)) {
      throw new Error(`Packaged CLI help is missing: ${expected}`);
    }
  }
  const versionResult = run(process.execPath, [cliEntry, "--version"], installRoot);
  if (versionResult.stdout.trim() !== packageJson.version) {
    throw new Error(
      `Packaged CLI reported version ${versionResult.stdout.trim()} instead of ${packageJson.version}.`,
    );
  }
  const initResult = run(
    process.execPath,
    [cliEntry, "init", "--skip-feishu", "--json"],
    installRoot,
    {
      ...process.env,
      AGENT_BOT_HOME: homeRoot,
      NO_COLOR: "1",
    },
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
