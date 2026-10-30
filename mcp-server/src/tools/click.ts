import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  description:
    'Dispatch a trusted click using a main-frame ref/selector or top-level screenshot coordinates in CSS pixels. Capture a screenshot first to stabilize the debugger viewport. Success confirms input dispatch; verify the application result before retrying a submission.',
  inputSchema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the element'),
    x: z.number().optional().describe('Viewport x in CSS pixels, used when no ref or selector is given'),
    y: z.number().optional().describe('Viewport y in CSS pixels, used when no ref or selector is given'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_click', params);
    return textResult(JSON.stringify(result, null, 2));
  },
};
