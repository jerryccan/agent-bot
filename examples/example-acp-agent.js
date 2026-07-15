import readline from "node:readline";

let nextSession = 1;

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

reader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (!("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: {
        name: "example-acp-agent",
        title: "Example ACP Agent",
        version: "0.1.0",
      },
      authMethods: [],
    });
    return;
  }

  if (message.method === "session/new") {
    respond(message.id, {
      sessionId: `example-${nextSession++}`,
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "chat",
          options: [
            { value: "chat", name: "Chat" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    });
    return;
  }

  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const text = message.params.prompt?.map((block) => block.text).filter(Boolean).join("\n") ?? "";
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Echo from example ACP agent:\n${text}`,
        },
      },
    });
    respond(message.id, { stopReason: "end_turn" });
    return;
  }

  if (message.method === "session/set_config_option") {
    respond(message.id, {
      configOptions: [
        {
          id: message.params.configId,
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: message.params.value,
          options: [
            { value: "chat", name: "Chat" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    });
    return;
  }

  if (message.method === "session/cancel") {
    return;
  }

  if (message.method === "session/close") {
    respond(message.id, {});
    return;
  }

  respondError(message.id, -32601, `Unknown method: ${message.method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
