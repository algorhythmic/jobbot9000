// index.ts — the MCP server entry. Runs over stdio; Claude Code starts it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "./db.js"; // opens + migrates the SQLite database on import
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "jobbot9000", version: "0.1.0" });
registerTools(server);

await server.connect(new StdioServerTransport());
