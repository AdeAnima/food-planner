#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "groceries-mcp", version: "0.1.0" });

// tools registered in Task 9

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("groceries-mcp started");
