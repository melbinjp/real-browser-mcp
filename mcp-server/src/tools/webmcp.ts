import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

const LIST_EXPRESSION = `
const mc = document.modelContext;
if (!mc || typeof mc.getTools !== 'function') {
  return { supported: false, tools: [] };
}
const tools = await mc.getTools();
return {
  supported: true,
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
};
`;

export const webmcpListTool: ToolDefinition = {
  name: 'browser_webmcp_list_tools',
  description:
    'List WebMCP tools the current page registers for agents (document.modelContext.getTools()). Returns supported:false when the browser or page has no WebMCP support.',
  inputSchema: z.object({}),
  async handler(bridge) {
    const result = await bridge.callTool('browser_evaluate', { expression: LIST_EXPRESSION });
    return textResult(JSON.stringify(result, null, 2));
  },
};

export const webmcpExecuteTool: ToolDefinition = {
  name: 'browser_webmcp_execute_tool',
  description:
    'Execute a WebMCP tool on the current page by name with a JSON input object. Use browser_webmcp_list_tools first to discover names and schemas. Returns null when the tool triggers a navigation.',
  inputSchema: z.object({
    name: z.string().describe('Tool name from browser_webmcp_list_tools'),
    input: z.record(z.string(), z.unknown()).optional().describe('Input arguments matching the tool inputSchema'),
  }),
  async handler(bridge, params) {
    const expression = `
const mc = document.modelContext;
if (!mc || typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
  return { supported: false, error: 'WebMCP not available on this page/browser' };
}
const tools = await mc.getTools();
const tool = tools.find((t) => t.name === ${JSON.stringify(params.name as string)});
if (!tool) {
  return { supported: true, error: 'tool not found', available: tools.map((t) => t.name) };
}
const result = await mc.executeTool(tool, ${JSON.stringify(params.input ?? {})});
return { supported: true, result };
`;
    const result = await bridge.callTool('browser_evaluate', { expression });
    return textResult(JSON.stringify(result, null, 2));
  },
};
