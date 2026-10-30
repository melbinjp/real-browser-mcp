import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const reloadExtensionTool: ToolDefinition = {
  name: 'browser_reload_extension',
  description:
    'Reload the browser extension so it runs its current files, for example after git pull. The connection drops for a few seconds and comes back by itself; wait, then call browser_tabs list to see the new extensionVersion.',
  inputSchema: z.object({}),
  async handler(bridge, params) {
    return textResult(JSON.stringify(await bridge.callTool('browser_reload_extension', params), null, 2));
  },
};
