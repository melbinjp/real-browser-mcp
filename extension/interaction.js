// Keep the debugger attached during a tab's working session. Repeated attach /
// detach toggles Edge's infobar and invalidates screenshot coordinates.
export function createInteraction(chromeApi) {
  let attachedTab = null;
  chromeApi.debugger.onDetach.addListener(source => {
    if (source.tabId === attachedTab) attachedTab = null;
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function ensureDebugger(tabId) {
    if (attachedTab === tabId) return;
    if (attachedTab !== null) {
      const previous = attachedTab;
      attachedTab = null;
      try { await chromeApi.debugger.detach({ tabId: previous }); } catch {}
    }
    await chromeApi.debugger.attach({ tabId }, '1.3');
    attachedTab = tabId;
    // Let the infobar's viewport resize settle before resolving coordinates.
    await delay(180);
  }

  async function visibleWindow(tab) {
    const win = await chromeApi.windows.get(tab.windowId);
    if (win.state === 'minimized') {
      throw new Error(`WINDOW_MINIMIZED: window ${win.id}; use browser_tabs focus for tab ${tab.id} to restore it. No input or screenshot was produced.`);
    }
    return win;
  }

  async function focusTab(tabId) {
    const tab = await chromeApi.tabs.get(tabId);
    const win = await chromeApi.windows.get(tab.windowId);
    if (win.state === 'minimized') await chromeApi.windows.update(win.id, { state: 'normal' });
    await chromeApi.tabs.update(tabId, { active: true });
    await chromeApi.windows.update(win.id, { focused: true });
    const actual = await chromeApi.windows.get(win.id);
    if (actual.state === 'minimized' || !actual.focused) throw new Error('WINDOW_FOCUS_FAILED: Edge did not restore/focus the requested window.');
    return { success: true, focused: tabId, windowId: actual.id, windowState: actual.state, windowFocused: actual.focused };
  }

  async function mouseClick(tabId, x, y, button = 'left', doubleClick = false) {
    const buttons = { left: 1, right: 2, middle: 4 };
    const send = params => chromeApi.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
    await send({ type: 'mouseMoved', x, y });
    for (let count = 1; count <= (doubleClick ? 2 : 1); count++) {
      await send({ type: 'mousePressed', x, y, button, buttons: buttons[button], clickCount: count });
      await send({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count });
    }
    return { success: true, trusted: true, dispatched: true, x, y, button, doubleClick };
  }

  return { ensureDebugger, visibleWindow, focusTab, mouseClick };
}

export function keyEvent(key, modifiers = []) {
  const parts = key.split('+');
  if (parts.length > 1) { modifiers = [...modifiers, ...parts.slice(0, -1).map(v => v.toLowerCase())]; key = parts.at(-1); }
  const aliases = { Esc: 'Escape', Return: 'Enter', Space: ' ', Spacebar: ' ' };
  key = aliases[key] || key;
  const specials = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], ' ': [32, 'Space'] };
  let entry = specials[key];
  if (!entry && /^[a-z]$/i.test(key)) entry = [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`];
  if (!entry && /^[0-9]$/.test(key)) entry = [key.charCodeAt(0), `Digit${key}`];
  if (!entry && /^F([1-9]|1[0-2])$/.test(key)) entry = [111 + Number(key.slice(1)), key];
  if (!entry) throw new Error(`Unsupported key: ${key}; use browser_type_trusted for text.`);
  const bits = { alt: 1, ctrl: 2, control: 2, shift: 8, meta: 4, cmd: 4 };
  let mask = 0;
  for (const mod of modifiers) { if (!bits[mod]) throw new Error(`Unknown modifier: ${mod}`); mask |= bits[mod]; }
  return { key, code: entry[1], windowsVirtualKeyCode: entry[0], modifiers: mask };
}

export async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
