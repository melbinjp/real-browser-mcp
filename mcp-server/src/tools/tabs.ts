import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  description: 'Manage tabs and windows. Focus restores a minimized window. List includes window state. Frames lists accessible frames; select_frame scopes DOM tools to an observed frame ID (0 returns to main page).',
  inputSchema: z.object({
    action: z.enum(['list', 'create', 'close', 'focus', 'frames', 'select_frame']).describe('Tab action'),
    tabId: z.number().optional().describe('Tab ID for close/focus'),
    url: z.string().optional().describe('URL for create action'),
    frameId: z.number().int().min(0).optional().describe('Frame from frames listing for select_frame'),
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_tabs', params);
    return textResult(JSON.stringify(result, null, 2));
  },
};
