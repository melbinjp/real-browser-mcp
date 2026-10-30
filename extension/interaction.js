// Keep the debugger attached during a tab's working session. Repeated attach /
// detach toggles Edge's infobar and invalidates screenshot coordinates.
// The session from debugger-session.js owns the attachment; this only waits
// for the viewport to settle after a new attach. Do not call ensureDebugger
// from inside session.withDebugger: the session queue would wait on itself.
export function createInteraction(chromeApi, session) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function ensureDebugger(tabId) {
    const wasAttached = session.attachedTabId() === tabId;
    await session.withDebugger(tabId, ({ attached }) => {
      if (!attached) throw new Error('DEBUGGER_BUSY: could not attach the debugger. Close DevTools on this tab or accept the debug infobar.');
    });
    // Let the infobar's viewport resize settle before resolving coordinates.
    if (!wasAttached) await delay(180);
  }

  async function pageVisibility(tab) {
    try {
      const [frame] = await bounded(
        chromeApi.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => document.visibilityState }),
        3000, 'PAGE_UNRESPONSIVE');
      return frame?.result;
    } catch (err) {
      if (err.message === 'PAGE_UNRESPONSIVE') {
        throw new Error(`PAGE_UNRESPONSIVE: tab ${tab.id} did not answer within 3 seconds. Nothing was sent to it.`);
      }
      // Pages that take no scripts (browser pages, the web store) are left to the
      // caller, which fails on its own there.
      return undefined;
    }
  }

  // A screenshot needs pixels on the screen, so a covered or minimized window
  // cannot give one.
  async function visibleWindow(tab) {
    const win = await chromeApi.windows.get(tab.windowId);
    if (win.state === 'minimized') {
      throw new Error(`WINDOW_MINIMIZED: window ${win.id}; use browser_tabs focus for tab ${tab.id} to restore it. No screenshot was taken.`);
    }
    if (await pageVisibility(tab) === 'hidden') {
      throw new Error(`WINDOW_HIDDEN: tab ${tab.id} is not on the screen, because its window is covered or in the background. Use browser_tabs focus for tab ${tab.id} to take a screenshot. No screenshot was taken.`);
    }
    return win;
  }

  // Input does not need the window on the screen. A covered or minimized
  // window marks its page hidden, and the browser can then hold debugger input
  // until the page paints again. The debugger session asks the page to stay
  // active (see debugger-session.js). A harmless pointer move outside the page
  // then proves that input gets through, before the real input is sent.
  async function inputReady(tab) {
    const win = await chromeApi.windows.get(tab.windowId);
    if (win.state !== 'minimized' && await pageVisibility(tab) !== 'hidden') return;
    await ensureDebugger(tab.id);
    try {
      await bounded(
        chromeApi.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: -1, y: -1 }),
        1500, 'INPUT_HELD');
    } catch {
      // Detaching cancels the held probe, so it cannot arrive later.
      await session.abort();
      throw new Error(`WINDOW_HIDDEN: the browser holds input for tab ${tab.id} while its window is covered or minimized. Use browser_tabs focus for tab ${tab.id}, then try again. No input was sent.`);
    }
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

  return { ensureDebugger, visibleWindow, inputReady, focusTab };
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

// Runs commands one at a time. A command that runs past its time limit must not
// block every later command, so onStuck answers for it and cancels its pending
// input, and the queue moves on.
export function createCommandQueue(run, { limitFor, onStuck }) {
  let tail = Promise.resolve();

  async function runLimited(msg) {
    let timer;
    const stuck = new Promise(resolve => { timer = setTimeout(() => resolve(true), limitFor(msg)); });
    const done = Promise.resolve().then(() => run(msg)).then(() => false, () => false);
    try {
      if (await Promise.race([done, stuck])) await onStuck(msg);
    } finally { clearTimeout(timer); }
  }

  return function enqueue(msg) {
    const next = tail.then(() => runLimited(msg));
    tail = next.catch(() => {});
    return next;
  };
}

export async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
