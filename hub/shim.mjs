#!/usr/bin/env node
/**
 * Per-agent MCP shim. Speaks MCP on stdio to one CLI, forwards every browser
 * call to the shared hub over HTTP. Claude, agy and Codex each run their own
 * copy of this; they all reach the same browser through the same extension.
 *
 * The tool list is the real one from the server, so the agents see exactly the
 * tools real-browser-mcp offers, with the same schemas.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools } from '../mcp-server/dist/tools/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_PORT = parseInt(process.env.HUB_PORT || '7226', 10);
const HUB = `http://127.0.0.1:${HUB_PORT}`;

async function hubUp() {
  try {
    const res = await fetch(`${HUB}/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the hub once, detached, so it outlives whichever agent started it. */
async function ensureHub() {
  if (await hubUp()) return;
  const child = spawn(process.execPath, [join(HERE, 'hub.mjs')], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await hubUp()) return;
  }
  throw new Error('the browser hub did not come up');
}

// Names this agent to the extension, which keeps one working tab per agent.
// The MCP client's name says which CLI it is, and the CLI's process ID tells
// two sessions of the same CLI apart. RB_AGENT overrides both.
function agentName() {
  if (process.env.RB_AGENT) return process.env.RB_AGENT;
  const client = server.server.getClientVersion()?.name || 'agent';
  return `${client}#${process.ppid}`;
}

/** Same shape the tool handlers expect from ExtensionBridge. */
const httpBridge = {
  async callTool(tool, params) {
    await ensureHub();
    const res = await fetch(`${HUB}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, params, agent: agentName() }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error || 'the hub reported no reason');
    return body.result;
  },
};

const server = new McpServer({ name: 'real-browser-mcp (shared)', version: '1.3.0' });

for (const tool of allTools) {
  server.tool(tool.name, tool.description, tool.inputSchema.shape, async params => {
    try {
      return await tool.handler(httpBridge, params);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`[shim] ready; hub at ${HUB}`);
