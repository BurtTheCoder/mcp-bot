import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs/promises";
import path from "path";
class MCPServerManager {
    constructor() {
        this.servers = new Map();
        this.storageFile = path.join(process.cwd(), "data", "servers.json");
        this.loadServers().catch(console.error);
    }
    async loadServers() {
        try {
            // Ensure the data directory exists
            await fs.mkdir(path.dirname(this.storageFile), { recursive: true });
            // Try to read the storage file
            const data = await fs
                .readFile(this.storageFile, "utf-8")
                .catch(() => "[]");
            const storedServers = JSON.parse(data);
            // Reconnect to each stored server
            for (const server of storedServers) {
                await this.addServer(server.name, server.command, server.args, server.env);
            }
            console.log(`Loaded ${storedServers.length} servers from storage`);
        }
        catch (error) {
            console.error("Error loading servers:", error);
        }
    }
    async saveServers() {
        try {
            const serversToStore = Array.from(this.servers.values()).map(({ name, command, args, env }) => ({
                name,
                command,
                args,
                env,
            }));
            await fs.writeFile(this.storageFile, JSON.stringify(serversToStore, null, 2));
        }
        catch (error) {
            console.error("Error saving servers:", error);
        }
    }
    async addServer(name, command, args, env) {
        if (this.servers.has(name)) {
            throw new Error(`Server ${name} already exists`);
        }
        const client = new Client({
            name: `mcp-client-${name}`,
            version: "1.0.0",
        }, {
            capabilities: {},
        });
        // Combine and filter environment variables
        const combinedEnv = {
            ...Object.entries(process.env)
                .filter(([_, value]) => value !== undefined)
                .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
            ...(env || {}),
        };
        const transport = new StdioClientTransport({
            command,
            args,
            env: combinedEnv,
        });
        await client.connect(transport);
        this.servers.set(name, { name, command, args, env, client });
        await this.saveServers();
    }
    async removeServer(name) {
        const server = this.servers.get(name);
        if (!server) {
            throw new Error(`Server ${name} not found`);
        }
        if (server.client) {
            // Add disconnect logic if needed
            delete server.client;
        }
        this.servers.delete(name);
        await this.saveServers();
    }
    getClient(name) {
        return this.servers.get(name)?.client;
    }
    getAllServers() {
        return Array.from(this.servers.values());
    }
}
export const mcpManager = new MCPServerManager();
