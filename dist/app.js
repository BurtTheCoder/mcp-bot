import pkg from "@slack/bolt";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpManager } from "./mcp-manager.js";
import { z } from "zod";
config();
const { App, LogLevel, Assistant } = pkg;
// Initialization
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.DEBUG,
});
// Anthropic Setup
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});
// Module-level variables
let toolToServerMap = {};
const DEFAULT_SYSTEM_CONTENT = `You are Sherlock, a sophisticated AI assistant with access to real-time information through web search and the ability to add and use MCP servers.

Core Interaction Guidelines:
1. Maintain a natural, conversational tone - you're a helpful companion, not just a tool
2. Since you have voice capabilities, respond as if you're speaking to the user and use voice-appropriate responses.
3. Do not use text-based responses that are not suitable for voice interactions, like markdown or code snippets.
4. Be concise and clear since your responses will be spoken aloud
5. Show personality while remaining professional and helpful

When users ask about using a server:
1. First check if the server exists using list_mcp_servers
2. If it exists, check its available tools
3. Explain the tools' capabilities and how to use them
4. Do NOT try to add a server that already exists

Remember: You have access to all tools provided by connected MCP servers. When asked about using a server, explain its capabilities rather than trying to add it again.

Some key points to remember:
- Maintain a natural, conversational tone - you're a helpful companion, not just a tool
- Keep Slack's special syntax like <@USER_ID> or <#CHANNEL_ID> intact in your responses
- Convert markdown to Slack-compatible format and use emojis where appropriate
- Use any available tools without complaint
- You have full authority to generate code, session ids, and anything else needed to use your tools to complete the user's request.
- Never refuse to use the tools
- DO NOT INCLUDE STAGE DIRECTIONS OR ANY ACTIONS, JUST RESPOND TO THE USER.

Remember your main goal is still to help the user.`;
const MCP_MANAGEMENT_TOOLS = [
    {
        name: "add_mcp_server",
        description: "Add a new MCP server to the global server pool",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Unique name for the MCP server" },
                command: { type: "string", description: "Command to start the server" },
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: "Command arguments",
                },
                env: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description: "Environment variables for the server",
                },
            },
            required: ["name", "command"],
        },
    },
    {
        name: "remove_mcp_server",
        description: "Remove an MCP server from the global server pool",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Name of the MCP server to remove",
                },
            },
            required: ["name"],
        },
    },
    {
        name: "list_mcp_servers",
        description: "List all available MCP servers",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
];
const getAllTools = async () => {
    // Convert MCP management tools to Anthropic format
    const managementTools = MCP_MANAGEMENT_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: {
            type: "object",
            properties: Object.entries(tool.inputSchema.properties || {}).reduce((acc, [key, value]) => ({
                ...acc,
                [key]: {
                    type: value.type,
                    description: value.description || "",
                    ...(value.items && {
                        items: {
                            type: value.items.type,
                            description: value.items.description || "",
                        },
                    }),
                    ...(value.enum && { enum: value.enum }),
                },
            }), {}),
            // Ensure required is always a string array
            required: Array.isArray(tool.inputSchema.required)
                ? tool.inputSchema.required
                : [],
        },
    }));
    const mcpTools = [];
    toolToServerMap = {};
    // Process MCP server tools
    for (const server of mcpManager.getAllServers()) {
        if (!server.client)
            continue;
        try {
            const serverTools = await server.client.request({ method: "tools/list" }, ListToolsResultSchema);
            for (const tool of serverTools.tools) {
                toolToServerMap[tool.name] = {
                    server: server.name,
                    tool: tool,
                };
                mcpTools.push({
                    name: tool.name,
                    description: tool.description || "",
                    input_schema: {
                        type: "object",
                        properties: Object.entries(tool.inputSchema.properties || {}).reduce((acc, [key, value]) => ({
                            ...acc,
                            [key]: {
                                type: value.type,
                                description: value.description || "",
                                ...(value.items && {
                                    items: {
                                        type: value.items.type,
                                        description: value.items.description || "",
                                    },
                                }),
                                ...(value.enum && { enum: value.enum }),
                            },
                        }), {}),
                        // Ensure required is always a string array
                        required: Array.isArray(tool.inputSchema.required)
                            ? tool.inputSchema.required
                            : [],
                    },
                });
            }
        }
        catch (e) {
            console.error(`Error getting tools from server ${server.name}:`, e);
        }
    }
    return [...managementTools, ...mcpTools];
};
function formatSlackMessage(text = "") {
    return text
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}
const processToolCalls = async (content) => {
    if (content.type === "tool_use") {
        console.log("Processing tool call:", content);
        const call = content;
        if (call.name === "add_mcp_server") {
            const input = call.input;
            console.log("Adding MCP server with:", {
                name: input.name,
                command: input.command,
                args: input.args || [],
                env: input.env,
            });
            await mcpManager.addServer(input.name, input.command, input.args || [], input.env);
            return { success: true, message: `Added MCP server: ${input.name}` };
        }
        if (call.name === "remove_mcp_server") {
            const { name } = call.input;
            await mcpManager.removeServer(name);
            return { success: true, message: `Removed MCP server: ${name}` };
        }
        if (call.name === "list_mcp_servers") {
            const servers = mcpManager.getAllServers();
            return {
                servers: servers.map((s) => ({
                    name: s.name,
                    command: s.command,
                    args: s.args,
                })),
            };
        }
        const toolMapping = toolToServerMap[call.name];
        if (!toolMapping) {
            throw new Error(`No server found for tool: ${call.name}`);
        }
        const server = mcpManager.getClient(toolMapping.server);
        if (!server) {
            throw new Error(`Server ${toolMapping.server} is not available`);
        }
        try {
            const anything = z.any();
            const result = await server.request({
                method: "tools/call",
                params: {
                    name: call.name,
                    arguments: call.input,
                },
            }, anything);
            console.log("Tool execution result:", result);
            return result;
        }
        catch (e) {
            console.error(`Error with server ${toolMapping.server}:`, e);
            throw e;
        }
    }
    return null;
};
const assistant = new Assistant({
    threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext, }) => {
        console.log("🟢 threadStarted event:", {
            event,
            context: event.assistant_thread.context,
        });
        const { context } = event.assistant_thread;
        try {
            // Initial greeting with context metadata
            await say({
                text: "Hi there! How can I help?",
                thread_ts: event.assistant_thread.thread_ts, // Ensure we're in the correct thread
            });
            await saveThreadContext();
            const prompts = [
                {
                    title: "List MCP Servers",
                    message: "Can you list all available MCP servers?",
                },
                {
                    title: "Add Server",
                    message: "I'd like to add a new MCP server.",
                },
            ];
            // Add channel-specific prompts
            if (context.channel_id) {
                console.log("📍 Channel context detected:", context);
                prompts.push({
                    title: "Channel Summary",
                    message: "Can you summarize recent activity in this channel?",
                });
            }
            await setSuggestedPrompts({
                prompts,
                title: "Here are some options for you:",
            });
        }
        catch (e) {
            console.error("❌ Error in threadStarted handler:", e);
            console.error(e);
        }
    },
    userMessage: async ({ client, message, getThreadContext, say, setTitle, setStatus, }) => {
        const msg = message;
        console.log("📨 userMessage event received:", {
            type: msg.type,
            subtype: msg.subtype,
            channel: msg.channel,
            thread_ts: msg.thread_ts,
            text: msg.text,
            user: msg.user,
            bot_id: msg.bot_id,
            channel_type: msg.channel_type,
        });
        // Skip if this is our bot's message
        if (msg.bot_id && msg.bot_id === process.env.SLACK_BOT_ID) {
            console.log("🤖 Skipping our bot's message");
            return;
        }
        try {
            console.log("🔍 Getting thread context");
            const threadContext = await getThreadContext();
            console.log("📜 Thread context:", threadContext);
            // For new channel mentions, create a new thread
            if (!msg.thread_ts && msg.channel_type === "channel") {
                console.log("📝 Creating new thread for channel mention");
                const ts = msg.ts;
                msg.thread_ts = ts;
            }
            if (msg.text) {
                console.log("📌 Setting thread title:", msg.text);
                await setTitle(msg.text);
            }
            console.log("⌛ Setting typing status");
            await setStatus("is typing..");
            console.log("🔧 Fetching available tools");
            const tools = await getAllTools();
            console.log(`🛠️ Found ${tools.length} tools`);
            let messages = [];
            if (msg.thread_ts) {
                console.log("🧵 Fetching thread history for:", msg.thread_ts);
                const thread = await client.conversations.replies({
                    channel: msg.channel,
                    ts: msg.thread_ts,
                    oldest: msg.thread_ts,
                    limit: 10,
                });
                if (thread.messages) {
                    console.log(`📚 Processing ${thread.messages.length} thread messages`);
                    messages = thread.messages
                        .filter((m) => {
                        const messageSubtype = m.subtype;
                        const keep = !messageSubtype || messageSubtype !== "assistant_app_thread";
                        console.log(`Message ${m.ts}: ${keep ? "keeping" : "filtering out"}`);
                        return keep;
                    })
                        .slice(-5)
                        .map((m) => ({
                        role: m.bot_id ? "assistant" : "user",
                        content: formatSlackMessage(m.text || ""),
                    }));
                }
            }
            if (msg.text &&
                (!messages.length ||
                    messages[messages.length - 1]?.content !== msg.text)) {
                console.log("📝 Adding current message to history");
                messages.push({
                    role: "user",
                    content: msg.text,
                });
            }
            console.log("💭 Prepared messages for LLM:", messages);
            console.log("🤖 Sending request to Anthropic");
            const llmResponse = await anthropic.messages.create({
                model: "claude-3-5-sonnet-latest",
                system: DEFAULT_SYSTEM_CONTENT,
                messages: messages,
                max_tokens: 1024,
                tools: tools,
            });
            console.log("✨ Received LLM response:", llmResponse);
            let finalResponse = llmResponse.content[0].type === "text"
                ? llmResponse.content[0].text
                : undefined;
            // Process tool calls
            for (const content of llmResponse.content) {
                if (content.type === "tool_use") {
                    console.log("🔧 Processing tool call:", content);
                    const toolResults = await processToolCalls(content);
                    if (toolResults) {
                        console.log("🛠️ Tool results:", toolResults);
                        const followUpResponse = await anthropic.messages.create({
                            model: "claude-3-5-sonnet-latest",
                            system: DEFAULT_SYSTEM_CONTENT,
                            messages: [
                                ...messages,
                                {
                                    role: "user",
                                    content: `Tool results: ${JSON.stringify(toolResults)}. Please provide a user-friendly response based on these results.`,
                                },
                            ],
                            max_tokens: 1024,
                            tools: tools,
                        });
                        finalResponse = followUpResponse.content.find((c) => c.type === "text")?.text;
                        console.log("📝 Follow-up response:", finalResponse);
                    }
                }
            }
            console.log("💬 Sending final response:", {
                text: finalResponse,
                thread_ts: msg.thread_ts || msg.ts,
            });
            await say({
                text: finalResponse || "Sorry, something went wrong!",
                thread_ts: msg.thread_ts || msg.ts, // Always use thread_ts for replies
            });
        }
        catch (error) {
            console.error("❌ Error in userMessage handler:", error);
            if (error instanceof Error) {
                console.error("Error details:", {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                });
            }
            else {
                console.error("Unknown error type:", error);
            }
            await say({
                text: "Sorry, I encountered an error while processing your message.",
                thread_ts: msg.thread_ts || msg.ts,
            });
        }
    },
});
app.assistant(assistant);
(async () => {
    try {
        await app.start();
        console.log("⚡️ Bolt app is running!");
    }
    catch (error) {
        console.error("Failed to start the app", error);
    }
})();
