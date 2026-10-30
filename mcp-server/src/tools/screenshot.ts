import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { imageResult, textResult } from './types.js';

export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Capture the current visible page with timestamp, CSS viewport and pixel-ratio metadata. Rejects minimized/hidden windows; explicitly focus the tab to restore it. Retains debugger attachment to keep coordinates stable.',
  inputSchema: z.object({
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    quality: z.number().min(0).max(100).optional().default(80).describe('JPEG quality (ignored for PNG)'),
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_screenshot', params) as {
      success: boolean;
      format: string;
      data?: string;
      error?: string;
      [key: string]: unknown;
    };
    if (result.data) {
      const mimeType = result.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const { data, ...metadata } = result;
      const output = imageResult(data, mimeType);
      output.content.push({ type: 'text', text: JSON.stringify(metadata) });
      return output;
    }
    return { ...textResult(result.error || 'Capture failed; no image returned'), isError: true };
  },
};
