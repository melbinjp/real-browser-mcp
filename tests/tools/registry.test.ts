import { describe, it, expect, vi } from 'vitest';
import { allTools, toolMap } from '../../mcp-server/src/tools/index.js';

describe('Tool Registry', () => {
  it('has 27 tools registered', () => {
    expect(allTools.length).toBe(27);
  });

  it('all tools have unique names', () => {
    const names = allTools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have description and inputSchema', () => {
    for (const tool of allTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('toolMap contains all tools', () => {
    expect(toolMap.size).toBe(allTools.length);
    for (const tool of allTools) {
      expect(toolMap.get(tool.name)).toBe(tool);
    }
  });

  const expectedTools = [
    'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll',
    'browser_press_key', 'browser_wait', 'browser_snapshot', 'browser_screenshot', 'browser_media',
    'browser_console', 'browser_network', 'browser_tabs', 'browser_find',
    'browser_text', 'browser_hover', 'browser_select', 'browser_evaluate',
    'browser_click_text', 'browser_handle_dialog',
    'browser_upload_file', 'browser_run_action',
    'browser_drag', 'browser_fill_form', 'browser_type_trusted',
    'browser_webmcp_list_tools', 'browser_webmcp_execute_tool', 'browser_reload_extension',
  ];

  for (const name of expectedTools) {
    it(`includes ${name}`, () => {
      expect(toolMap.has(name)).toBe(true);
    });
  }
});

describe('one-call tab target', () => {
  it('lets every page tool name a tab, but not browser_tabs or the reload', () => {
    for (const tool of allTools) {
      const has = 'tabId' in tool.inputSchema.shape;
      if (tool.name === 'browser_reload_extension') expect(has).toBe(false);
      else expect(has).toBe(true);
    }
    expect(toolMap.get('browser_click')!.inputSchema.safeParse({ ref: 'e1' }).success).toBe(true);
  });

  it('puts the tab on every call the tool makes, and nothing when no tab is named', async () => {
    const callTool = vi.fn(async () => ({ success: true, result: { tools: [] } }));
    const bridge = { callTool } as any;
    await toolMap.get('browser_webmcp_list_tools')!.handler(bridge, { tabId: 77 });
    expect(callTool.mock.calls[0][0]).toBe('browser_evaluate');
    expect(callTool.mock.calls[0][1]).toMatchObject({ tabId: 77 });
    callTool.mockClear();
    await toolMap.get('browser_snapshot')!.handler(bridge, { compact: true });
    expect(callTool.mock.calls[0][1]).not.toHaveProperty('tabId');
  });
});

