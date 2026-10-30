import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import type { ExtensionBridge } from '../bridge.js';
import { navigateTool } from './navigate.js';
import { clickTool } from './click.js';
import { typeTool } from './type.js';
import { typeTrustedTool } from './type-trusted.js';
import { scrollTool } from './scroll.js';
import { pressKeyTool } from './press-key.js';
import { waitTool } from './wait.js';
import { snapshotTool } from './snapshot.js';
import { mediaTool } from './media.js';
import { reloadExtensionTool } from './reload-extension.js';
import { screenshotTool } from './screenshot.js';
import { consoleTool } from './console.js';
import { networkTool } from './network.js';
import { tabsTool } from './tabs.js';
import { findTool } from './find.js';
import { textTool } from './text.js';
import { hoverTool } from './hover.js';
import { selectTool } from './select.js';
import { evaluateTool } from './evaluate.js';
import { clickTextTool } from './click-text.js';
import { dialogTool } from './dialog.js';
import { uploadFileTool } from './upload-file.js';
import { runActionTool } from './run-action.js';
import { dragTool } from './drag.js';
import { fillFormTool } from './fill-form.js';
import { webmcpListTool, webmcpExecuteTool } from './webmcp.js';

const baseTools: ToolDefinition[] = [
  navigateTool,
  clickTool,
  typeTool,
  typeTrustedTool,
  scrollTool,
  pressKeyTool,
  waitTool,
  snapshotTool,
  mediaTool,
  reloadExtensionTool,
  screenshotTool,
  consoleTool,
  networkTool,
  tabsTool,
  findTool,
  textTool,
  hoverTool,
  selectTool,
  evaluateTool,
  clickTextTool,
  dialogTool,
  uploadFileTool,
  runActionTool,
  dragTool,
  fillFormTool,
  webmcpListTool,
  webmcpExecuteTool,
];

// Every page tool can act on one named tab for a single call, instead of the
// agent's working tab. browser_tabs has its own tabId; the reload has no tab.
const TAB_TARGET = {
  tabId: z
    .number()
    .int()
    .optional()
    .describe('Act on this tab for this call only, instead of your working tab. Tab IDs come from browser_tabs list.'),
};
const HAS_OWN_TAB_PARAM = new Set(['browser_tabs', 'browser_reload_extension']);

function withTabTarget(tool: ToolDefinition): ToolDefinition {
  if (HAS_OWN_TAB_PARAM.has(tool.name)) return tool;
  return {
    ...tool,
    inputSchema: tool.inputSchema.extend(TAB_TARGET),
    async handler(bridge, params) {
      const { tabId, ...rest } = params;
      if (tabId == null) return tool.handler(bridge, rest);
      // Some tools call a different extension tool (WebMCP calls evaluate), so
      // the tab goes onto every call the tool makes.
      const targeted = Object.create(bridge, {
        callTool: { value: (name: string, p: Record<string, unknown>) => bridge.callTool(name, { ...p, tabId }) },
      }) as ExtensionBridge;
      return tool.handler(targeted, rest);
    },
  };
}

export const allTools: ToolDefinition[] = baseTools.map(withTabTarget);

export const toolMap = new Map<string, ToolDefinition>(
  allTools.map(t => [t.name, t]),
);
