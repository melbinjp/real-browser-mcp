import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const typeTrustedTool: ToolDefinition = {
  name: 'browser_type_trusted',
  description:
    'Type into an element with trusted input, through the debugger. Use this for rich text editors (Draft.js, ProseMirror, CodeMirror, Monaco) and anywhere browser_type appears to work but the page does not keep the text: those editors hold their own model and ignore synthetic events, so the text shows on screen and is missing from what the page saves. Slower than browser_type because it attaches the debugger, so prefer browser_type for plain inputs.',
  inputSchema: z.object({
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the element to focus'),
    text: z.string().describe('Text to type. Newlines create new blocks in a rich text editor'),
    clear: z.boolean().optional().default(false).describe('Select all and delete before typing'),
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_type_trusted', params);
    return textResult(JSON.stringify(result, null, 2));
  },
};
