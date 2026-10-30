import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

const tabGroupColor = z.enum([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  description:
    'Manage browser tabs, windows, frames and the extension-managed tab group. Tools act on the working tab, so you can work on a tab while the person uses another. select makes a tab the working tab without showing it. create opens a tab in the background and makes it the working tab. focus shows a tab and makes it the working tab. Without a working tab, tools act on the active tab. list/create/close/focus tabs. Focus restores a minimized window. List includes window state. frames lists accessible frames; select_frame scopes DOM tools to an observed frame ID (0 returns to main page). name puts the tab into a Real Browser MCP tab group and sets the group title (emoji in the title is shown as the group icon). ungroup removes the tab from its group.',
  inputSchema: z.object({
    action: z
      .enum(['list', 'create', 'close', 'focus', 'select', 'frames', 'select_frame', 'name', 'ungroup'])
      .describe('Tab action. name creates or updates the managed tab group title.'),
    tabId: z.number().optional().describe('Tab ID for close/focus/select/name/ungroup. Defaults to the active tab for name/ungroup.'),
    url: z.string().optional().describe('URL for create action'),
    frameId: z.number().int().min(0).optional().describe('Frame from frames listing for select_frame'),
    title: z
      .string()
      .optional()
      .describe('Group title for name. Emoji is allowed and Chrome shows it as the group icon.'),
    color: tabGroupColor
      .optional()
      .describe('Tab group color for name. Random if omitted when creating a new group.'),
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_tabs', params);
    return textResult(JSON.stringify(result, null, 2));
  },
};
