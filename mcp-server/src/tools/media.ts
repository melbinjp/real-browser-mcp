import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const mediaTool: ToolDefinition = {
  name: 'browser_media',
  description: 'Read video, audio and image sources exposed in the selected frame DOM. Does not fetch network resources. Embedded data URLs are omitted by default; includeData can return large media payloads for authorized local editing or export recovery.',
  inputSchema: z.object({
    includeData: z.boolean().optional().default(false).describe('Include embedded data URLs; potentially large.'),
  }),
  async handler(bridge, params) {
    return textResult(JSON.stringify(await bridge.callTool('browser_media', params), null, 2));
  },
};
