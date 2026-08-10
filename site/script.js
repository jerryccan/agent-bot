const translations = {
  en: {
    documentTitle: "Agent Bot | Local coding agents in Lark",
    description:
      "Agent Bot connects Lark and Feishu to local coding agents such as Codex and TraeX.",
    skip: "Skip to content",
    menu: "Menu",
    navWorkflow: "How it works",
    navCapabilities: "Capabilities",
    navReliability: "Reliability",
    navInstall: "Install",
    heroEyebrow: "Open source · Runs on your machine",
    heroLead:
      "Your local coding agents, available wherever your Lark conversations happen.",
    heroCopy:
      "Connect Codex, TraeX, and compatible agents to Lark or Feishu. Start work, follow progress, and keep projects moving without being at your desk.",
    getStarted: "Get started",
    viewGithub: "View on GitHub",
    worksWith: "Works with",
    statementKicker: "The missing connection",
    statementTitle: "The agent stays local. The conversation goes with you.",
    statementCopy:
      "Agent Bot is the durable bridge between Lark and the coding tools already authenticated on your computer. Your source, credentials, and agent processes stay on the host you control.",
    workflowKicker: "One continuous loop",
    workflowTitle: "From message to merged work",
    workflowIntro:
      "A focused workflow that feels native in chat and remains faithful to the agent running locally.",
    stepOneTitle: "Ask from Lark",
    stepOneCopy:
      "Send a message, image, command, or follow-up from a private chat, group, or topic.",
    stepTwoTitle: "Work locally",
    stepTwoCopy:
      "The selected agent runs inside its own process with the project, model, and permission settings for that task.",
    stepThreeTitle: "Stay in the loop",
    stepThreeCopy:
      "Follow live reasoning and tools, steer when needed, then receive the final answer in the original conversation.",
    productKicker: "Made for active work",
    productTitle: "Progress you can read. Controls where you need them.",
    productCopy:
      "A single turn stays coherent from reaction to progress card to final response, with the task controls close at hand.",
    previewSubtitle: "Local agent · connected",
    online: "Online",
    previewPrompt:
      "Review the release workflow and fix the failing publish step.",
    processing: "Processing: release workflow",
    processingMeta: "18s · 3 tools",
    stop: "Stop",
    activityOne: "Inspecting workflow configuration",
    activityTwo: "Verifying package release settings",
    activityThree: "Applying the workflow fix",
    running: "Running now",
    completed: "Completed: release workflow",
    completedMeta: "42s · 5 tools",
    resultCopy:
      "Fixed the publish job and verified the package. The release workflow is ready to run.",
    capabilitiesKicker: "More than remote prompts",
    capabilitiesTitle: "A complete task workspace in chat",
    capabilitiesIntro:
      "The everyday controls required for parallel, long-running coding work are already part of the conversation.",
    capOneTitle: "Tasks that keep their context",
    capOneCopy:
      "Create, switch, queue, fork, reset, archive, and resume tasks without losing the project or runtime settings behind them.",
    capTwoTitle: "One process per agent",
    capTwoCopy:
      "Codex, TraeX, and compatible agents stay isolated, so different tasks can use different products without sharing process state.",
    capThreeTitle: "Controls that match the moment",
    capThreeCopy:
      "Change model, thinking level, permissions, provider, agent, Goal, title, or project directory from cards or the CLI.",
    capFourTitle: "Files move with the work",
    capFourCopy:
      "Browse project directories, open images, and send generated files directly back to the conversation that requested them.",
    capFiveTitle: "Groups for parallel work",
    capFiveCopy:
      "Turn a new task or a completed point in history into a dedicated Lark group with the right project and agent already attached.",
    agentsKicker: "Bring the tools you trust",
    agentsTitle: "One bridge. Independent agents.",
    appServer: "App Server",
    compatibleAgents: "Compatible agents",
    processProtocol: "Process protocol",
    reliabilityKicker: "Built to stay reachable",
    reliabilityTitle: "Remote access is only useful when it recovers.",
    reliabilityCopy:
      "Agent Bot treats continuity as product behavior, not an operational afterthought.",
    reliableOneTitle: "Supervised processes",
    reliableOneCopy:
      "Worker and agent failures are detected, recorded, and restarted without sharing state between agents.",
    reliableTwoTitle: "Recent task recovery",
    reliableTwoCopy:
      "Interrupted active work is restored after restart with a fresh progress card in the original conversation.",
    reliableThreeTitle: "Safe restarts and updates",
    reliableThreeCopy:
      "Active turns finish before replacement, with rollback protection for installed-package updates.",
    reliableFourTitle: "Isolated profiles",
    reliableFourCopy:
      "Run primary and rescue bots with separate credentials, data, processes, and startup registrations.",
    installKicker: "Ready when your machine is",
    installTitle: "Install Agent Bot",
    installCopy:
      "Requires Node.js 22 or newer and at least one supported local agent. Initialization guides you through creating and authorizing the Lark or Feishu bot.",
    readGuide: "Read the setup guide",
    viewChangelog: "View changelog",
    stable: "Stable",
    installNote: "Configuration and runtime data stay under ~/.agent-bot.",
    footerTagline: "Local agents. Reachable work.",
    footerOpen: "Open source on GitHub",
    copied: "Copied to clipboard",
    copyFailed: "Select and copy the command",
  },
  zh: {
    documentTitle: "Agent Bot | 在飞书中使用本机编程 Agent",
    description:
      "Agent Bot 将飞书连接到本机运行的 Codex、TraeX 和兼容编程 Agent。",
    skip: "跳到正文",
    menu: "菜单",
    navWorkflow: "工作方式",
    navCapabilities: "核心能力",
    navReliability: "可靠性",
    navInstall: "安装",
    heroEyebrow: "开源 · 在你的电脑上运行",
    heroLead: "让本机编程 Agent，出现在每一场飞书对话中。",
    heroCopy:
      "把 Codex、TraeX 和兼容 Agent 连接到飞书。随时开始任务、查看进度、追加指令，让项目在你离开电脑后仍然向前推进。",
    getStarted: "开始使用",
    viewGithub: "在 GitHub 查看",
    worksWith: "支持",
    statementKicker: "补上关键连接",
    statementTitle: "Agent 留在本机，对话跟着你走。",
    statementCopy:
      "Agent Bot 在飞书与你电脑上已经登录的编程工具之间建立可靠连接。代码、凭据和 Agent 进程始终留在你掌控的主机上。",
    workflowKicker: "完整工作闭环",
    workflowTitle: "从一条消息，到工作真正完成",
    workflowIntro:
      "在飞书里保持自然的协作体验，同时忠实连接本机真正执行工作的 Agent。",
    stepOneTitle: "从飞书发起",
    stepOneCopy: "在私聊、群聊或话题中发送消息、图片、命令和后续要求。",
    stepTwoTitle: "在本机执行",
    stepTwoCopy:
      "所选 Agent 在独立进程中运行，并使用当前任务自己的项目、模型和权限设置。",
    stepThreeTitle: "全程保持掌控",
    stepThreeCopy:
      "查看实时思考和工具执行，需要时追加指令，最终结果会回到原来的对话。",
    productKicker: "为真实工作设计",
    productTitle: "进度清晰可读，控制触手可及。",
    productCopy:
      "从 Reaction、思考卡片到最终回复，一轮任务始终连贯，常用控制就在当前会话中。",
    previewSubtitle: "本机 Agent · 已连接",
    online: "在线",
    previewPrompt: "检查发布工作流，并修复失败的发布步骤。",
    processing: "正在处理：发布工作流",
    processingMeta: "18 秒 · 3 个工具",
    stop: "停止",
    activityOne: "检查工作流配置",
    activityTwo: "验证包发布设置",
    activityThree: "应用工作流修复",
    running: "正在执行",
    completed: "已完成：发布工作流",
    completedMeta: "42 秒 · 5 个工具",
    resultCopy: "已修复发布任务并完成包验证，发布工作流可以正常运行。",
    capabilitiesKicker: "不只是远程发送 Prompt",
    capabilitiesTitle: "把完整任务工作区放进飞书",
    capabilitiesIntro:
      "并行、长时间编程任务所需的日常控制，都已经成为对话的一部分。",
    capOneTitle: "始终保留上下文的任务",
    capOneCopy:
      "新建、切换、排队、分支、重置、归档和恢复任务，不丢失任务背后的项目和运行设置。",
    capTwoTitle: "每个 Agent 独立进程",
    capTwoCopy:
      "Codex、TraeX 和兼容 Agent 相互隔离，不同任务可以使用不同产品而不共享进程状态。",
    capThreeTitle: "恰到好处的运行控制",
    capThreeCopy:
      "通过卡片或 CLI 修改模型、思考强度、权限、Provider、Agent、Goal、标题和项目目录。",
    capFourTitle: "文件跟着任务流转",
    capFourCopy:
      "浏览项目目录、查看图片，并把生成的文件直接发送回提出需求的飞书会话。",
    capFiveTitle: "为并行工作创建群聊",
    capFiveCopy:
      "从新任务或任意已完成历史节点创建独立飞书群，并自动绑定正确的项目和 Agent。",
    agentsKicker: "继续使用你信任的工具",
    agentsTitle: "一座桥梁，多个独立 Agent。",
    appServer: "App Server",
    compatibleAgents: "兼容 Agent",
    processProtocol: "进程协议",
    reliabilityKicker: "时刻保持可达",
    reliabilityTitle: "不能恢复的远程访问，没有真正的价值。",
    reliabilityCopy:
      "Agent Bot 把连续可用作为产品行为，而不是留给用户处理的运维问题。",
    reliableOneTitle: "进程持续守护",
    reliableOneCopy:
      "Worker 和 Agent 异常会被检测、记录并重新启动，同时保持不同 Agent 之间的状态隔离。",
    reliableTwoTitle: "近期任务自动恢复",
    reliableTwoCopy:
      "重启后恢复被中断的活跃工作，并在原会话中使用新的思考卡片继续执行。",
    reliableThreeTitle: "安全重启与更新",
    reliableThreeCopy:
      "等待活跃轮次完成后再替换服务，安装包更新同时具备回滚保护。",
    reliableFourTitle: "Profile 完全隔离",
    reliableFourCopy:
      "主机器人和救援机器人可以使用独立凭据、数据、进程与系统启动项。",
    installKicker: "只要电脑在线，就可以开始",
    installTitle: "安装 Agent Bot",
    installCopy:
      "需要 Node.js 22 或更高版本，以及至少一个已安装的本机 Agent。初始化流程会引导你创建并授权飞书机器人。",
    readGuide: "阅读安装指南",
    viewChangelog: "查看更新记录",
    stable: "正式版",
    installNote: "配置与运行数据保存在 ~/.agent-bot 目录中。",
    footerTagline: "本机 Agent，随时可达。",
    footerOpen: "GitHub 开源项目",
    copied: "已复制到剪贴板",
    copyFailed: "请选择并复制命令",
  },
};

const header = document.querySelector("[data-header]");
const menuButton = document.querySelector("[data-menu-button]");
const mobileNav = document.querySelector("[data-mobile-nav]");
const languageButtons = [...document.querySelectorAll("[data-language]")];
const copyToast = document.querySelector("[data-copy-toast]");
const guideLink = document.querySelector(".install-links a:first-child");
let toastTimer;

function preferredLanguage() {
  const saved = localStorage.getItem("agent-bot-language");
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function setLanguage(language) {
  const selected = translations[language] ? language : "en";
  const dictionary = translations[selected];
  document.documentElement.lang = selected === "zh" ? "zh-CN" : "en";
  document.title = dictionary.documentTitle;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", dictionary.description);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (dictionary[key]) element.textContent = dictionary[key];
  });
  languageButtons.forEach((button) => {
    const active = button.dataset.language === selected;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (guideLink) {
    guideLink.href =
      selected === "zh"
        ? "https://github.com/keyou/agent-bot/blob/master/README.zh.md"
        : "https://github.com/keyou/agent-bot/blob/master/README.md";
  }
  localStorage.setItem("agent-bot-language", selected);
}

function closeMenu() {
  document.body.classList.remove("menu-open");
  header?.classList.remove("is-menu-open");
  menuButton?.setAttribute("aria-expanded", "false");
}

function showToast(key = "copied") {
  const language = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
  if (!copyToast) return;
  copyToast.textContent = translations[language][key];
  copyToast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => copyToast.classList.remove("is-visible"),
    1800,
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast();
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    showToast(copied ? "copied" : "copyFailed");
  }
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.language));
});

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  document.body.classList.toggle("menu-open", open);
  header?.classList.toggle("is-menu-open", open);
  menuButton.setAttribute("aria-expanded", String(open));
});

mobileNav
  ?.querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", closeMenu));

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => copyText(button.dataset.copy ?? ""));
});

document.querySelectorAll("[data-channel]").forEach((button) => {
  button.addEventListener("click", () => {
    const channel = button.dataset.channel;
    document.querySelectorAll("[data-channel]").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    const command =
      channel === "alpha"
        ? "npm install --global @keyou007/agent-bot@alpha"
        : "npm install --global @keyou007/agent-bot";
    const commandElement = document.querySelector("[data-install-command]");
    const copyButton = document.querySelector(".terminal-copy");
    if (commandElement) commandElement.textContent = command;
    if (copyButton) copyButton.dataset.copy = `${command}\nagentbot init`;
  });
});

function updateHeader() {
  header?.classList.toggle("is-scrolled", window.scrollY > 12);
}

window.addEventListener("scroll", updateHeader, { passive: true });
window.addEventListener("resize", () => {
  if (window.innerWidth > 880) closeMenu();
});

document.querySelector("[data-year]").textContent = String(
  new Date().getFullYear(),
);
setLanguage(preferredLanguage());
updateHeader();
