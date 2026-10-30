import { describe, it, expect, vi } from 'vitest';
// The production extension module is deliberately dependency-free.
// @ts-ignore JavaScript extension module
import { createInteraction, keyEvent, bounded } from '../extension/interaction.js';

function browser(state = 'normal') {
  let listener: (source: any) => void = () => {};
  const win = { id: 8, state, focused: false };
  const api = {
    debugger: {
      onDetach: { addListener: vi.fn(fn => { listener = fn; }) },
      attach: vi.fn(async () => {}), detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    windows: {
      get: vi.fn(async () => ({ ...win })),
      update: vi.fn(async (_id, change) => Object.assign(win, change)),
    },
    tabs: { get: vi.fn(async id => ({ id, windowId: 8 })), update: vi.fn(async () => {}) },
  };
  return { api, win, detach: (id: number) => listener({ tabId: id }) };
}

describe('browser interaction reliability', () => {
  it('explicit focus restores a minimized window before focusing it', async () => {
    const { api } = browser('minimized');
    const result = await createInteraction(api).focusTab(12);
    expect(api.windows.update.mock.calls).toEqual([[8, { state: 'normal' }], [8, { focused: true }]]);
    expect(result).toMatchObject({ focused: 12, windowState: 'normal', windowFocused: true });
  });
  it('preserves maximized state on focus', async () => {
    const { api } = browser('maximized');
    await createInteraction(api).focusTab(12);
    expect(api.windows.update.mock.calls).toEqual([[8, { focused: true }]]);
  });
  it('rejects minimized captures/inputs without restoring or dispatching', async () => {
    const { api } = browser('minimized');
    await expect(createInteraction(api).visibleWindow({ id: 12, windowId: 8 })).rejects.toThrow('WINDOW_MINIMIZED');
    expect(api.windows.update).not.toHaveBeenCalled();
    expect(api.debugger.sendCommand).not.toHaveBeenCalled();
  });
  it('keeps one attachment across successive commands and respects user detachment', async () => {
    vi.useFakeTimers();
    try {
      const { api, detach } = browser();
      const i = createInteraction(api);
      let ready = i.ensureDebugger(12); await vi.runAllTimersAsync(); await ready;
      await i.ensureDebugger(12);
      expect(api.debugger.attach).toHaveBeenCalledTimes(1);
      ready = i.ensureDebugger(13); await vi.runAllTimersAsync(); await ready;
      expect(api.debugger.detach).toHaveBeenCalledWith({ tabId: 12 });
      detach(13);
      ready = i.ensureDebugger(13); await vi.runAllTimersAsync(); await ready;
      expect(api.debugger.attach).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('sends one trusted press/release pair for one click', async () => {
    const { api } = browser();
    await createInteraction(api).mouseClick(12, 90, 70);
    expect(api.debugger.sendCommand.mock.calls.map(c => c[2].type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(api.debugger.sendCommand.mock.calls[1][2]).toMatchObject({ buttons: 1, clickCount: 1 });
    expect(api.debugger.sendCommand.mock.calls[2][2]).toMatchObject({ buttons: 0, clickCount: 1 });
  });
  it('maps native editing and navigation keys and rejects unknown keys', () => {
    expect(keyEvent('Ctrl+A')).toMatchObject({ key: 'A', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    expect(keyEvent('Tab', ['shift'])).toMatchObject({ code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
    expect(keyEvent('End', ['ctrl'])).toMatchObject({ code: 'End', modifiers: 2 });
    expect(() => keyEvent('invented')).toThrow('Unsupported key');
  });
  it('bounds a stalled capture without reporting success', async () => {
    vi.useFakeTimers();
    try {
      const result = expect(bounded(new Promise(() => {}), 4500, 'CAPTURE_TIMEOUT')).rejects.toThrow('CAPTURE_TIMEOUT');
      await vi.advanceTimersByTimeAsync(4500); await result;
    } finally { vi.useRealTimers(); }
  });
});
