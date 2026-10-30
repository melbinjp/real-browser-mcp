import { createInteraction, createCommandQueue, keyEvent, bounded } from './interaction.js';
import { createTabGroups } from './tab-groups.js';
import { createDebuggerSession } from './debugger-session.js';
// Commands run one at a time. A command still running after its limit is
// answered with an error and its debugger input is cancelled, so one stuck
// command cannot hold every agent. Its late answer is dropped.
const COMMAND_LIMIT_MS = { browser_navigate: 65_000, browser_wait: 65_000 };
const abandonedCommands = new Set();
const enqueueCommand = createCommandQueue(handleMessage, {
  limitFor: msg => COMMAND_LIMIT_MS[msg.tool] ?? 35_000,
  async onStuck(msg) {
    const seconds = (COMMAND_LIMIT_MS[msg.tool] ?? 35_000) / 1000;
    sendResponse(msg.id, { success: false, error: `COMMAND_STUCK: ${msg.tool} did not finish in ${seconds} seconds. The debugger was detached to cancel its pending input. The action may have partly run, so check the page before you try again.` });
    abandonedCommands.add(msg.id);
    await debuggerSession.abort();
  },
});
const selectedFrames = new Map();
let requestFrameId = 0;

const DEFAULT_WS_PORT = 7225;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MIN = 0.4; // ~24s, under Chrome's 30s limit

let wsPort = DEFAULT_WS_PORT;
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let nextRetryMs = 0;
let connectedSince = null;
let lastError = null;
let consoleMessages = [];
let networkRequests = [];
let currentActivity = null;
let activeTabId = null;
let pendingDialog = null;
const tabGroups = createTabGroups(chrome);
/** Last visual/CDP pointer position per tab, used to animate movement. */
const lastPointer = new Map();
const POINTER_STEPS = 8;
const POINTER_STEP_MS = 24;
const DEBUGGER_ATTACH_ERROR =
  'Could not attach debugger. Close DevTools on this tab or accept the debug infobar.';

// --- Connection Management ---

async function initConnection() {
  try {
    const stored = await chrome.storage.local.get('wsPort');
    if (stored.wsPort) wsPort = stored.wsPort;
  } catch {}

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  tabGroups.ensureLoaded().catch(() => {});
  connect();
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(`ws://localhost:${wsPort}`);

    ws.onopen = () => {
      isConnected = true;
      reconnectAttempts = 0;
      connectedSince = Date.now();
      lastError = null;
      updateBadge('connected');
      broadcastStatus('Connected');
    };

    ws.onclose = () => {
      isConnected = false;
      connectedSince = null;
      ws = null;
      updateBadge('disconnected');
      broadcastStatus('Disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      isConnected = false;
      lastError = `Connection refused on port ${wsPort}`;
      updateBadge('error');
      broadcastStatus(lastError);
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        await enqueueCommand(msg);
      } catch (err) {
        console.error('[RealBrowser] Message error:', err);
      }
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  const jitter = Math.random() * 500;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts) + jitter, RECONNECT_MAX_MS);
  reconnectAttempts++;
  nextRetryMs = delay;
  broadcastStatus(`Retry #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  reconnectTimeout = setTimeout(connect, delay);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !isConnected) connect();
});

// --- Badge ---

function updateBadge(status) {
  const config = {
    connected: { color: '#22c55e', text: 'ON' },
    active: { color: '#3b82f6', text: '...' },
    disconnected: { color: '#6b7280', text: '' },
    error: { color: '#ef4444', text: '!' },
  };
  const c = config[status] || config.disconnected;
  chrome.action.setBadgeBackgroundColor({ color: c.color });
  chrome.action.setBadgeText({ text: c.text });
}

// --- Activity Overlay ---

async function showOverlay(tabId, label) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (lbl) => {
        let el = document.getElementById('__rbmcp-overlay');
        if (!el) {
          el = document.createElement('div');
          el.id = '__rbmcp-overlay';
          el.style.cssText =
            'position:fixed;top:12px;right:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;' +
            'padding:6px 14px;border-radius:16px;font:500 13px system-ui,sans-serif;z-index:2147483647;' +
            'display:flex;align-items:center;gap:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
            'animation:rbIn .2s ease-out';
          const s = document.createElement('style');
          s.textContent = '@keyframes rbIn{from{transform:translateX(80px);opacity:0}to{transform:none;opacity:1}}';
          document.head.appendChild(s);
          document.body.appendChild(el);
        }
        el.textContent = lbl;
      },
      args: [label],
    });
  } catch {}
}

async function hideOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById('__rbmcp-overlay')?.remove(),
    });
  } catch {}
}

function getConnectionState() {
  if (isConnected) return 'connected';
  if (reconnectAttempts > 0) return 'reconnecting';
  return 'disconnected';
}

function buildStatusPayload(message) {
  return {
    type: 'status',
    connectionState: getConnectionState(),
    port: wsPort,
    reconnectAttempts,
    nextRetryMs,
    connectedSince,
    lastError,
    activity: currentActivity,
    statusMessage: message || null,
  };
}

function broadcastStatus(message) {
  chrome.runtime.sendMessage(buildStatusPayload(message)).catch(() => {});
}

// --- Message Router ---

async function handleMessage(msg) {
  const { id, tool, params } = msg;

  let tabId = null;
  try {
    tabId = (await getActiveTab()).id;
  } catch {}

  currentActivity = tool;
  activeTabId = tabId;
  updateBadge('active');
  if (tabId) await showOverlay(tabId, tool.replace('browser_', ''));

  try {
    const result = await dispatch(tool, params || {});
    sendResponse(id, { success: true, result });
  } catch (err) {
    sendResponse(id, { success: false, error: err.message || String(err) });
  } finally {
    currentActivity = null;
    updateBadge(isConnected ? 'connected' : 'disconnected');
    if (tabId) await hideOverlay(tabId);
  }
}

function sendResponse(id, response) {
  if (abandonedCommands.delete(id)) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, ...response }));
  }
}

// --- Tool Dispatch ---

async function dispatch(tool, params) {
  const handlers = {
    browser_navigate: handleNavigate,
    browser_click: handleClick,
    browser_type: handleType,
    browser_type_trusted: handleTypeTrusted,
    browser_scroll: handleScroll,
    browser_press_key: handlePressKey,
    browser_wait: handleWait,
    browser_snapshot: handleSnapshot,
    browser_media: handleMedia,
    browser_reload_extension: handleReloadExtension,
    browser_screenshot: handleScreenshot,
    browser_console: handleConsole,
    browser_network: handleNetwork,
    browser_tabs: handleTabs,
    browser_hover: handleHover,
    browser_select: handleSelect,
    browser_evaluate: handleEvaluate,
    browser_click_text: handleClickByText,
    browser_handle_dialog: handleDialog,
    browser_upload_file: handleUploadFile,
    browser_run_action: handleRunAction,
    browser_drag: handleDrag,
    browser_fill_form: handleFillForm,
    find: handleFind,
    browser_find: handleFind,
    get_page_text: handleGetPageText,
    browser_text: handleGetPageText,
  };

  const tab = await getActiveTab().catch(() => null);
  requestFrameId = params.frameId ?? selectedFrames.get(tab?.id) ?? 0;
  const handler = handlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(params);
}

// --- Helpers ---

// The tab the tools act on. browser_tabs select, create and focus set it, so
// an agent can work on one tab while the person uses another. It is kept in
// local storage because the service worker stops when idle and an extension
// reload clears session storage; it is cleared when the browser starts,
// because tab IDs are reused then. Without it, tools act on the active tab.
let workingTabId;
const WORKING_TAB_KEY = 'workingTabId';

async function loadWorkingTab() {
  if (workingTabId === undefined) {
    try { workingTabId = (await chrome.storage.local.get(WORKING_TAB_KEY))[WORKING_TAB_KEY] ?? null; }
    catch { workingTabId = null; }
  }
  return workingTabId;
}

async function setWorkingTab(tabId) {
  workingTabId = tabId;
  try { await chrome.storage.local.set({ [WORKING_TAB_KEY]: tabId }); } catch {}
}

chrome.runtime.onStartup.addListener(() => setWorkingTab(null));

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await loadWorkingTab() === tabId) await setWorkingTab(null);
});

async function getActiveTab() {
  const working = await loadWorkingTab();
  if (working != null) {
    try { return await chrome.tabs.get(working); } catch { await setWorkingTab(null); }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function execInTab(tabId, func, args = []) {
  const sanitized = args.map(a => a === undefined ? null : a);
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [requestFrameId] }, func, args: sanitized });
  return results[0]?.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mouseButtonName(button) {
  if (button === 'right') return 'right';
  if (button === 'middle') return 'middle';
  return 'left';
}

function mouseButtonsMask(button, down) {
  if (!down) return 0;
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

async function sendMouse(tabId, type, x, y, extras = {}) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    ...extras,
  });
}

/** Inject a blue-glow cursor + optional click ripple. Survives until detach or navigation. */
async function showVisualCursor(tabId, x, y, click) {
  try {
    await execInTab(tabId, (_x, _y, _click) => {
      const HOST_ID = '__rbmcp-cursor-host';
      let host = document.getElementById(HOST_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = HOST_ID;
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <style>
            .glow {
              position: fixed;
              width: 48px;
              height: 48px;
              margin: -24px 0 0 -24px;
              border-radius: 50%;
              background: radial-gradient(circle, rgba(59,130,246,0.50) 0%, rgba(59,130,246,0.22) 45%, rgba(59,130,246,0) 72%);
              pointer-events: none;
              will-change: left, top;
              transition: left 180ms ease-out, top 180ms ease-out;
            }
            .arrow {
              position: fixed;
              width: 18px;
              height: 18px;
              margin: -1px 0 0 -1px;
              pointer-events: none;
              will-change: left, top;
              transition: left 180ms ease-out, top 180ms ease-out;
              filter: drop-shadow(0 1px 1px rgba(0,0,0,.35));
            }
            .ripple {
              position: fixed;
              width: 16px;
              height: 16px;
              margin: -8px 0 0 -8px;
              border-radius: 50%;
              border: 2px solid rgba(37,99,235,0.9);
              background: rgba(59,130,246,0.25);
              pointer-events: none;
              animation: rbmcp-rip 450ms ease-out forwards;
            }
            @keyframes rbmcp-rip {
              from { transform: scale(0.6); opacity: 1; }
              to { transform: scale(3.2); opacity: 0; }
            }
          </style>
          <div class="glow"></div>
          <svg class="arrow" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 1.5 L2 15.5 L6.2 11.8 L9.4 17.2 L12.2 15.9 L9 10.4 L14.8 10.4 Z" fill="#111827" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        `;
        (document.documentElement || document.body).appendChild(host);
      }

      const shadow = host.shadowRoot;
      const glow = shadow.querySelector('.glow');
      const arrow = shadow.querySelector('.arrow');
      const first = host.dataset.ready !== '1';
      if (first) {
        glow.style.transition = 'none';
        arrow.style.transition = 'none';
      }
      glow.style.left = _x + 'px';
      glow.style.top = _y + 'px';
      arrow.style.left = _x + 'px';
      arrow.style.top = _y + 'px';
      if (first) {
        host.dataset.ready = '1';
        void glow.offsetWidth;
        glow.style.transition = '';
        arrow.style.transition = '';
      }
      if (_click) {
        const ripple = document.createElement('div');
        ripple.className = 'ripple';
        ripple.style.left = _x + 'px';
        ripple.style.top = _y + 'px';
        shadow.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
      }
    }, [x, y, click]);
  } catch {}
}

async function hideVisualCursor(tabId) {
  try {
    await execInTab(tabId, () => document.getElementById('__rbmcp-cursor-host')?.remove());
  } catch {}
}

async function movePointer(tabId, x, y, { attached, click = false } = {}) {
  const prev = lastPointer.get(tabId);
  const from = prev || { x: x - 48, y: y - 36 };
  await showVisualCursor(tabId, from.x, from.y, false);
  await showVisualCursor(tabId, x, y, false);

  if (attached) {
    for (let i = 1; i <= POINTER_STEPS; i++) {
      const t = i / POINTER_STEPS;
      await sendMouse(
        tabId,
        'mouseMoved',
        from.x + (x - from.x) * t,
        from.y + (y - from.y) * t,
        { button: 'none' },
      );
      await sleep(POINTER_STEP_MS);
    }
  } else {
    await sleep(180);
  }

  lastPointer.set(tabId, { x, y });
  if (click) await showVisualCursor(tabId, x, y, true);
}

async function locateElementCenter(tabId, ref, selector) {
  return execInTab(tabId, (_ref, _sel) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
    if (!el) return { found: false };
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    if (el.focus) el.focus();
    return {
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, [ref, selector]);
}

async function syntheticClickAt(tabId, x, y, button, doubleClick) {
  return execInTab(tabId, (_x, _y, _btn, _dbl) => {
    const el = document.elementFromPoint(_x, _y);
    if (!el) return { success: false, error: 'Element not found' };
    const btnVal = _btn === 'left' ? 0 : _btn === 'right' ? 2 : 1;
    const init = { bubbles: true, cancelable: true, view: window, clientX: _x, clientY: _y, button: btnVal };
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (el.focus) el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));
    if (_dbl) {
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      el.dispatchEvent(new MouseEvent('dblclick', init));
    }
    return { success: true };
  }, [x, y, button, doubleClick]);
}

const debuggerSession = createDebuggerSession(chrome, {
  onDetach(tabId) {
    lastPointer.delete(tabId);
    hideVisualCursor(tabId);
  },
});
const interaction = createInteraction(chrome, debuggerSession);

async function performPointerClick(tab, x, y, { button = 'left', doubleClick = false } = {}) {
  await interaction.inputReady(tab);
  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    await movePointer(tab.id, x, y, { attached, click: true });

    if (attached) {
      const btn = mouseButtonName(button);
      await sendMouse(tab.id, 'mousePressed', x, y, {
        button: btn,
        clickCount: 1,
        buttons: mouseButtonsMask(button, true),
      });
      await sleep(40);
      await sendMouse(tab.id, 'mouseReleased', x, y, {
        button: btn,
        clickCount: 1,
        buttons: 0,
      });
      if (doubleClick) {
        await sendMouse(tab.id, 'mousePressed', x, y, {
          button: btn,
          clickCount: 2,
          buttons: mouseButtonsMask(button, true),
        });
        await sleep(40);
        await sendMouse(tab.id, 'mouseReleased', x, y, {
          button: btn,
          clickCount: 2,
          buttons: 0,
        });
      }
      return { success: true };
    }

    return syntheticClickAt(tab.id, x, y, button, doubleClick);
  });
}

async function performPointerHover(tab, x, y) {
  await interaction.inputReady(tab);
  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    await movePointer(tab.id, x, y, { attached, click: false });
    if (!attached) {
      await execInTab(tab.id, (_x, _y) => {
        const el = document.elementFromPoint(_x, _y);
        if (!el) return;
        const init = { bubbles: true, cancelable: true, view: window, clientX: _x, clientY: _y };
        el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
        el.dispatchEvent(new MouseEvent('mouseover', init));
        el.dispatchEvent(new MouseEvent('mousemove', init));
      }, [x, y]);
    }
    return { success: true };
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== debuggerSession.attachedTabId() || changeInfo.status !== 'complete') return;
  const pos = lastPointer.get(tabId);
  if (pos) showVisualCursor(tabId, pos.x, pos.y, false);
});

// --- Tool Handlers ---

async function handleNavigate(params) {
  const { url, waitUntil = 'load' } = params;
  const tab = await getActiveTab();

  return new Promise((resolve, reject) => {
    const listener = (tabId, changeInfo) => {
      if (tabId !== tab.id) return;
      if (changeInfo.status === 'complete' || (waitUntil === 'domcontentloaded' && changeInfo.status === 'complete')) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ url, status: 'navigated' });
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tab.id, { url }).catch(reject);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ url, status: 'timeout' });
    }, 55000);
  });
}

async function handleClick(params) {
  const { ref, selector, x: px, y: py, button = 'left', doubleClick = false } = params;
  const tab = await getActiveTab();
  // Screenshot coordinates always refer to the top-level viewport.
  if (!ref && !selector && px != null && py != null) requestFrameId = 0;

  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  const point = await execInTab(tab.id, (_ref, _sel, _px, _py, _btn, _dbl) => {
    // Refs and selectors miss anything inside a shadow root, so the lookup
    // descends through open shadow roots before giving up.
    function deepQuery(sel) {
      const direct = document.querySelector(sel);
      if (direct) return direct;
      const stack = [document];
      while (stack.length) {
        const root = stack.pop();
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const hit = el.shadowRoot.querySelector(sel);
            if (hit) return hit;
            stack.push(el.shadowRoot);
          }
        }
      }
      return null;
    }

    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = deepQuery(_sel);

    // Coordinates are the fallback when nothing can be addressed: whatever is
    // painted at that point gets the click, the way a person clicking would.
    if (!el && _px != null && _py != null) {
      el = document.elementFromPoint(_px, _py);
      let root = el && el.shadowRoot;
      while (root) {
        const inner = root.elementFromPoint(_px, _py);
        if (!inner || inner === el) break;
        el = inner;
        root = el.shadowRoot;
      }
    }
    if (!el) return { success: false, error: 'Element not found' };

    const usingPoint = _px != null && _py != null && !_ref && !_sel;
    if (!usingPoint) el.scrollIntoView({ behavior: 'instant', block: 'center' });

    const rect = el.getBoundingClientRect();
    const x = usingPoint ? _px : rect.left + rect.width / 2;
    const y = usingPoint ? _py : rect.top + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return {success:false,error:'Target is outside the visible viewport'};
    if (document.elementFromPoint(x,y) !== el && !el.contains(document.elementFromPoint(x,y))) {
      const hit = document.elementFromPoint(x,y);
      if (!hit?.shadowRoot) return {success:false,error:'Target is covered by another element'};
    }
    return { success: true, x, y };
  }, [ref, selector, px, py, button, doubleClick]);
  if (!point?.success) return point;
  if (requestFrameId !== 0) throw new Error('FRAME_COORDINATES: use top-level screenshot coordinates for trusted clicks; frame selectors are supported by snapshot, type, keys and scroll.');
  return performPointerClick(tab, point.x, point.y, { button, doubleClick });
}

async function handleType(params) {
  const { ref, selector, text, clear = false } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_ref, _sel, _text, _clear) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
    if (!el) return { success: false, error: 'Element not found' };

    el.focus();

    if (_clear) {
      if (el.isContentEditable) {
        el.textContent = '';
      } else {
        el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      document.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, typed: _text };
  }, [ref, selector, text, clear]);
}

/**
 * Type through the debugger, so the page receives trusted input.
 *
 * A synthetic KeyboardEvent or execCommand changes the rendered DOM but never
 * reaches an editor that keeps its own model. Draft.js, ProseMirror, CodeMirror
 * and Monaco all ignore untrusted events, so the text appears on screen and is
 * absent from what the page actually saves. Input.insertText is real input.
 */
async function handleTypeTrusted(params) {
  const { ref, selector, text, clear = false } = params;
  const tab = await getActiveTab();

  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  const focused = (ref || selector) ? await execInTab(tab.id, (_ref, _sel) => {
    // Deep lookup: the real caret is often inside an open shadow root (a web
    // component's own contenteditable or textarea), which plain
    // document.querySelector cannot see. Fall back to whatever already has
    // real focus, wherever it lives, since a prior real click put it there.
    function deepQuery(sel) {
      const direct = document.querySelector(sel);
      if (direct) return direct;
      const stack = [document];
      while (stack.length) {
        const root = stack.pop();
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const hit = el.shadowRoot.querySelector(sel);
            if (hit) return hit;
            stack.push(el.shadowRoot);
          }
        }
      }
      return null;
    }
    function deepActiveElement() {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return el;
    }
    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = deepQuery(_sel);
    if (!el && !_ref && !_sel) el = deepActiveElement();
    if (!el) return { success: false, error: 'Element not found' };
    if (el.tagName === 'IFRAME') return { success:false, error:'Target the editable element in its frame, not the iframe container' };
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    if (el.setSelectionRange && typeof el.value === 'string') {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return { success: true };
  }, [ref, selector]) : { success: true };

  if (focused && focused.success === false) return focused;

  const carets = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return document.hasFocus() && !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button','submit','reset','checkbox','radio','file','hidden'].includes(el.type))) && !el.disabled && !el.readOnly;
    },
  });
  if (!carets.some(frame => frame.result === true)) {
    throw new Error('NO_EDITABLE_FOCUS: click an editable field or select its frame and selector first. No text or select-all was sent.');
  }

  await interaction.ensureDebugger(tab.id);
  try {
    if (clear) {
      // select all, then let the deletion go through the page's own handling
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
      });
      for (const t of ['rawKeyDown', 'keyUp']) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
          type: t, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
        });
      }
    }
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', { text });
    return { success: true, typed: text, trusted: true };
  } finally {
    // Debugger retained until another tab is selected or the user cancels it.
  }
}

async function handleScroll(params) {
  const { direction = 'down', amount = 500, selector, toElement, position } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_dir, _amt, _sel, _toEl, _pos) => {
    if (_toEl) {
      const el = document.querySelector(`[data-mcp-ref="${_toEl}"]`) || document.querySelector(_toEl);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { success: true, scrolledTo: 'element' };
      }
      return { success: false, error: 'Element not found' };
    }

    const target = _sel ? document.querySelector(_sel) : window;
    if (!target) return { success: false, error: 'Scroll container not found' };

    if (_pos === 'top') {
      if (target === window) window.scrollTo({ top: 0, behavior: 'smooth' });
      else target.scrollTop = 0;
      return { success: true, scrolledTo: 'top' };
    }
    if (_pos === 'bottom') {
      if (target === window) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else target.scrollTop = target.scrollHeight;
      return { success: true, scrolledTo: 'bottom' };
    }

    const scrollOpts = { behavior: 'smooth' };
    if (_dir === 'down') scrollOpts.top = _amt;
    else if (_dir === 'up') scrollOpts.top = -_amt;
    else if (_dir === 'right') scrollOpts.left = _amt;
    else if (_dir === 'left') scrollOpts.left = -_amt;

    if (target === window) window.scrollBy(scrollOpts);
    else target.scrollBy(scrollOpts);

    return { success: true, direction: _dir, amount: _amt };
  }, [direction, amount, selector, toElement, position]);
}

async function handlePressKey(params) {
  const { key, modifiers = [], ref, selector } = params;
  const tab = await getActiveTab();
  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  if (ref || selector) {
    const found = await execInTab(tab.id, (ref, selector) => {
      const el = document.querySelector(ref ? `[data-mcp-ref="${ref}"]` : selector);
      if (!el || el.tagName === 'IFRAME') return false;
      el.focus(); return true;
    }, [ref, selector]);
    if (!found) throw new Error('Editable/key target not found; select its frame first.');
  }
  const event = keyEvent(key, modifiers);
  await chrome.debugger.sendCommand({tabId:tab.id}, 'Input.dispatchKeyEvent', {type:'rawKeyDown', ...event});
  if (event.key === 'Enter' && !event.modifiers) await chrome.debugger.sendCommand({tabId:tab.id}, 'Input.dispatchKeyEvent', {type:'char', text:'\r', ...event});
  await chrome.debugger.sendCommand({tabId:tab.id}, 'Input.dispatchKeyEvent', {type:'keyUp', ...event});
  return {success:true, trusted:true, dispatched:true, key:event.key};
}

async function handleWait(params) {
  const { selector, state = 'visible', timeout = 10000, delay } = params;

  if (delay) {
    await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
    return { success: true, waited: delay };
  }

  if (!selector) return { success: false, error: 'Need selector or delay' };

  const tab = await getActiveTab();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const found = await execInTab(tab.id, (_sel, _state) => {
      const el = document.querySelector(_sel);
      if (_state === 'hidden') return !el || el.offsetParent === null;
      if (_state === 'attached') return !!el;
      return el && el.offsetParent !== null;
    }, [selector, state]);

    if (found) return { success: true, selector, state, elapsed: Date.now() - start };
    await new Promise(r => setTimeout(r, 200));
  }

  return { success: false, error: `Timeout waiting for ${selector} to be ${state}` };
}

async function handleHover(params) {
  const { ref, selector } = params;
  const tab = await getActiveTab();
  const loc = await locateElementCenter(tab.id, ref, selector);
  if (!loc?.found) return { success: false, error: 'Element not found' };
  return performPointerHover(tab, loc.x, loc.y);
}

async function handleSelect(params) {
  const { ref, selector, value, label, index } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_ref, _sel, _val, _lbl, _idx) => {
    let el = _ref ? document.querySelector(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = document.querySelector(_sel);
    if (!el) return { success: false, error: 'Element not found' };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Not a select element' };

    if (_val !== null) el.value = _val;
    else if (_lbl !== null) {
      const opt = Array.from(el.options).find(o => o.textContent.trim() === _lbl);
      if (opt) el.value = opt.value;
      else return { success: false, error: `Option "${_lbl}" not found` };
    } else if (_idx !== null) {
      if (_idx >= 0 && _idx < el.options.length) el.selectedIndex = _idx;
      else return { success: false, error: `Index ${_idx} out of range` };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true, selected: el.value };
  }, [ref, selector, value, label, index]);
}

async function handleSnapshot(params) {
  const { selector, compact = true } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_sel, _compact) => {
    let refCount = 0;
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK']);

    function vis(el) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function role(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = {
        A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',IMG:'img',
        H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',
        NAV:'navigation',MAIN:'main',HEADER:'banner',FOOTER:'contentinfo',FORM:'form',
        TABLE:'table',UL:'list',OL:'list',LI:'listitem',
      };
      if (el.tagName === 'INPUT') {
        const t = el.type?.toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      return map[el.tagName] || 'generic';
    }

    function elName(el) {
      const raw = (
        el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('title') || el.getAttribute('placeholder') ||
        ''
      ).trim();
      if (raw) return raw.slice(0, 80);
      const text = el.innerText;
      if (!text) return '';
      const first = text.split('\n')[0].trim();
      return first.slice(0, 80);
    }

    // A page's real children include anything behind an open shadow root or a
    // same-origin frame. Walking element.children alone makes every component
    // built that way invisible to the snapshot, and so unclickable by ref.
    function childrenOf(el) {
      const out = [];
      if (el.shadowRoot) out.push(...el.shadowRoot.children);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) out.push(doc.body);
        } catch {
          // cross-origin frame: not readable, and not ours to reach into
        }
      }
      out.push(...el.children);
      return out;
    }

    function isInteractive(el) {
      const tags = ['A','BUTTON','INPUT','SELECT','TEXTAREA'];
      return tags.includes(el.tagName) || el.onclick || el.getAttribute('tabindex') !== null ||
        el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' ||
        el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'option' || el.getAttribute('role') === 'switch' ||
        el.getAttribute('contenteditable') === 'true';
    }

    const landmarkRoles = new Set(['navigation','main','banner','contentinfo','form','search','complementary','region']);

    function buildCompact(el) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const ia = isInteractive(el);
      const r = role(el);
      const isLandmark = landmarkRoles.has(r);

      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildCompact(c);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }

      if (!ia && !isLandmark && r !== 'heading') {
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `e${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);
      const n = elName(el);

      const node = { ref, role: r };
      if (n) node.name = n;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;
      if (kids.length) node.children = kids;

      return node;
    }

    function buildFull(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const r = role(el);
      const n = elName(el);
      const ia = isInteractive(el);

      if (r === 'generic' && !n && !ia && depth > 1) {
        const kids = [];
        for (const c of childrenOf(el)) {
          const cn = buildFull(c, depth + 1);
          if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
        }
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `e${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);

      const node = { ref, role: r };
      if (r === 'generic') node.tag = el.tagName.toLowerCase();
      if (n) node.name = n;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;

      const kids = [];
      for (const c of el.children) {
        const cn = buildFull(c, depth + 1);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }
      if (kids.length) node.children = kids;

      return node;
    }

    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Root element not found' };

    // A new snapshot replaces the previous reference map, including nodes omitted
    // by compact mode or a scoped snapshot. Otherwise querySelector can resolve
    // an old generic node before the newly assigned interactive element.
    function clearRefs(el) {
      if (!el || el.nodeType !== 1) return;
      el.removeAttribute('data-mcp-ref');
      for (const child of childrenOf(el)) clearRefs(child);
    }
    clearRefs(document.documentElement);
    const tree = _compact ? buildCompact(root) : buildFull(root, 0);
    return {
      success: true,
      url: location.href,
      title: document.title,
      compact: _compact,
      tree,
    };
  }, [selector, compact]);
}

async function handleScreenshot(params) {
  const { format = 'png', quality = 80 } = params;
  const tab = await getActiveTab();
  const readViewport = async () => (await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState})}))[0].result;
  const win = await chrome.windows.get(tab.windowId);
  if (!tab.active || win.state === 'minimized' || (await readViewport()).visibility !== 'visible') {
    return captureOffscreen(tab, format, quality, readViewport);
  }
  await interaction.visibleWindow(tab);
  await interaction.ensureDebugger(tab.id);
  await hideOverlay(tab.id);
  const viewport = await readViewport();
  if (viewport.visibility !== 'visible') throw new Error(`PAGE_HIDDEN: tab ${tab.id}; focus this tab before capture. No screenshot returned.`);
  const dataUrl = await bounded(chrome.tabs.captureVisibleTab(tab.windowId, {format,quality:format==='jpeg'?quality:undefined}), 4500, 'CAPTURE_TIMEOUT: Edge did not provide a fresh screenshot within 4.5 seconds.');
  await interaction.visibleWindow(tab);
  const current = await getActiveTab();
  const after = await readViewport();
  if (current.id !== tab.id || after.visibility !== 'visible' || after.width !== viewport.width || after.height !== viewport.height) throw new Error('CAPTURE_CHANGED: tab/window/viewport changed during capture; discard and request a new screenshot.');
  return {success:true,format,data:dataUrl.split(',')[1],tabId:tab.id,windowId:tab.windowId,capturedAt:new Date().toISOString(),viewport,coordinateSpace:'CSS pixels',raster:{width:Math.round(viewport.width*viewport.dpr),height:Math.round(viewport.height*viewport.dpr)}};
}

// A tab that is not on the screen has no pixels to copy from the window, so
// the page renders the image through the debugger instead.
// Page.captureScreenshot waits for a painted frame, which a tab off the
// screen does not make. A screencast asks the page for frames itself.
function screencastFrame(tabId, format, quality) {
  return new Promise((resolve, reject) => {
    const onEvent = (source, method, params) => {
      if (source.tabId !== tabId || method !== 'Page.screencastFrame') return;
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
      resolve({ data: params.data });
    };
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', { format, quality: format === 'jpeg' ? quality : undefined, everyNthFrame: 1 })
      .catch(err => { chrome.debugger.onEvent.removeListener(onEvent); reject(err); });
  });
}

async function captureOffscreen(tab, format, quality, readViewport) {
  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  await hideOverlay(tab.id);
  const viewport = await readViewport();
  let shot;
  try {
    shot = await bounded(screencastFrame(tab.id, format, quality), 5000, 'CAPTURE_TIMEOUT');
  } catch (err) {
    if (err.message === 'CAPTURE_TIMEOUT') await debuggerSession.abort();
    throw new Error(`CAPTURE_FAILED: tab ${tab.id} is not on the screen and the browser gave no image (${err.message}). Use browser_tabs focus for tab ${tab.id} to capture it on the screen.`);
  }
  return {success:true,format,data:shot.data,tabId:tab.id,windowId:tab.windowId,capturedAt:new Date().toISOString(),offscreen:true,viewport,coordinateSpace:'CSS pixels',raster:{width:Math.round(viewport.width*viewport.dpr),height:Math.round(viewport.height*viewport.dpr)}};
}

// Lets an agent load changed extension files without a person on the
// extensions page. The answer goes out before the reload ends the worker.
async function handleReloadExtension() {
  setTimeout(() => chrome.runtime.reload(), 300);
  return { success: true, reloading: true, version: chrome.runtime.getManifest().version };
}

async function handleConsole(params) {
  const { clear = false } = params;
  const msgs = [...consoleMessages];
  if (clear) consoleMessages = [];
  return { success: true, messages: msgs };
}

async function handleNetwork(params) {
  const { filter, clear = false } = params;
  let reqs = [...networkRequests];
  if (filter) {
    const re = new RegExp(filter);
    reqs = reqs.filter(r => re.test(r.url));
  }
  if (clear) networkRequests = [];
  return { success: true, requests: reqs };
}

async function handleTabs(params) {
  const { action, tabId, url, frameId, title, color } = params;
  switch (action) {
    case 'select': {
      if (!tabId) throw new Error('tabId required');
      const t = await chrome.tabs.get(tabId);
      await setWorkingTab(t.id);
      return { success: true, workingTabId: t.id, active: t.active, url: t.url, title: t.title };
    }
    case 'list': {
      // Group details come from tabGroups.list(), which reads the current window only.
      const grouped = new Map((await tabGroups.list()).tabs.map(t => [t.id, t]));
      const windows = await chrome.windows.getAll({ populate: true });
      return {
        success: true,
        extensionVersion: chrome.runtime.getManifest().version,
        workingTabId: await loadWorkingTab(),
        windows: windows.map(w => ({ id: w.id, state: w.state, focused: w.focused })),
        tabs: windows.flatMap(w => w.tabs.map(t => ({
          ...(grouped.get(t.id) || { id: t.id, url: t.url, title: t.title, active: t.active }),
          windowId: w.id,
          working: t.id === workingTabId,
        }))),
      };
    }
    case 'create': {
      // Opens behind the person's tab and becomes the working tab.
      const t = await chrome.tabs.create({ url: url || 'about:blank', active: false });
      await setWorkingTab(t.id);
      return { success: true, tabId: t.id, url: t.url, workingTabId: t.id };
    }
    case 'close': {
      if (!tabId) throw new Error('tabId required');
      await chrome.tabs.remove(tabId);
      return { success: true, closed: tabId };
    }
    case 'focus': {
      if (!tabId) throw new Error('tabId required');
      const focused = await interaction.focusTab(tabId);
      await setWorkingTab(tabId);
      return { ...focused, workingTabId: tabId };
    }
    case 'frames': {
      const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
      const frames = await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>({url:location.href,title:document.title})});
      return {success:true,tabId:tab.id,selectedFrameId:selectedFrames.get(tab.id)||0,frames:frames.map(f=>({frameId:f.frameId,documentId:f.documentId,...f.result}))};
    }
    case 'select_frame': {
      const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
      if (!Number.isInteger(frameId) || frameId < 0) throw new Error('A frameId from browser_tabs frames is required');
      await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[frameId]},func:()=>document.title});
      selectedFrames.set(tab.id,frameId); return {success:true,tabId:tab.id,frameId};
    }
    case 'name':
      return tabGroups.name({ title, color, tabId });
    case 'ungroup':
      return tabGroups.ungroup({ tabId });
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function handleFind(params) {
  const { query, limit = 10 } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_q, _lim) => {
    const qLow = _q.toLowerCase();
    const matches = [];

    function aName(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
        el.getAttribute('placeholder') || el.innerText?.slice(0, 200) || '').trim();
    }

    function aRole(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = { A:'link', BUTTON:'button', INPUT:'input', SELECT:'combobox', TEXTAREA:'textbox', IMG:'image' };
      return map[el.tagName] || el.tagName.toLowerCase();
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let rc = 0;
    let node;
    while ((node = walker.nextNode()) && matches.length < _lim * 3) {
      const s = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || rect.width === 0) continue;

      const n = aName(node).toLowerCase();
      const r = aRole(node).toLowerCase();
      const id = (node.id || '').toLowerCase();
      let score = 0;
      if (n.includes(qLow)) score += 10;
      if (r.includes(qLow)) score += 5;
      if (id.includes(qLow)) score += 3;
      if (score === 0) continue;

      const ref = `f${rc++}`;
      node.setAttribute('data-mcp-ref', ref);
      matches.push({ ref, role: r, name: n.slice(0, 100), tag: node.tagName.toLowerCase(), score,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return { success: true, query: _q, matches: matches.slice(0, _lim) };
  }, [query, limit]);
}

async function handleGetPageText(params) {
  const { selector, maxLength = 50000 } = params;
  const tab = await getActiveTab();
  const args = selector === undefined ? [null, maxLength] : [selector, maxLength];

  return execInTab(tab.id, (_sel, _max) => {
    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Element not found' };

    let text = root.innerText || root.textContent || '';
    text = text.replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n\n').replace(/ +/g, ' ').trim();
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return { success: true, url: location.href, title: document.title, text, length: text.length, truncated };
  }, args);
}

// Read only media actually exposed in the selected document's DOM. This also
// supports recovering generated data-URL previews when the site's export hangs.
async function handleMedia(params) {
  const tab = await getActiveTab();
  return execInTab(tab.id, (includeData) => ({
    success: true,
    media: Array.from(document.querySelectorAll('video,audio,img')).map(el => {
      const src = el.currentSrc || el.src || '';
      return { tag: el.tagName.toLowerCase(), source: src.startsWith('data:') && !includeData ? undefined : src,
        embedded: src.startsWith('data:'), length: src.length, alt: el.getAttribute('alt'),
        duration: Number.isFinite(el.duration) ? el.duration : undefined };
    })
  }), [params.includeData === true]);
}

async function handleEvaluate(params) {
  const { expression } = params;
  const tab = await getActiveTab();
  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    if (!attached) throw new Error(DEBUGGER_ATTACH_ERROR);

    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
    );
    if (exceptionDetails) {
      return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    return { success: true, result: result.value };
  });
}

async function handleClickByText(params) {
  const { text, index = 0, exact = false } = params;
  const tab = await getActiveTab();

  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  const point = await execInTab(tab.id, (_text, _index, _exact) => {
    const textLower = _text.toLowerCase();
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const nodeText = (node.innerText || node.textContent || '').trim();
      const firstLine = nodeText.split('\n')[0].trim();
      const match = _exact
        ? firstLine === _text
        : firstLine.toLowerCase().includes(textLower);

      if (match) {
        candidates.push({ el: node, text: firstLine, depth: getDepth(node) });
      }
    }

    function getDepth(el) { let d = 0; let p = el; while (p = p.parentElement) d++; return d; }

    candidates.sort((a, b) => b.depth - a.depth);

    if (candidates.length === 0) return { success: false, error: `No element found with text "${_text}"` };
    if (_index >= candidates.length) return { success: false, error: `Only ${candidates.length} matches, index ${_index} out of range` };

    const target = candidates[_index].el;
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { success:true,x,y,clicked:candidates[_index].text,matchCount:candidates.length };
  }, [text, index, exact]);
  if (!point?.success) return point;
  if (requestFrameId !== 0) throw new Error('Use top-level screenshot coordinates for frame clicks.');
  const clicked = await performPointerClick(tab, point.x, point.y, { button: 'left' });
  if (!clicked?.success) return clicked;
  return { success: true, clicked: point.clicked, matchCount: point.matchCount };
}

async function handleDialog(params) {
  const { action = 'accept', promptText } = params;
  const tab = await getActiveTab();

  return execInTab(tab.id, (_action, _promptText) => {
    window.__mcpDialogLog = window.__mcpDialogLog || [];
    window.__mcpDialogAction = _action;
    window.__mcpDialogPromptText = _promptText || '';

    if (!window.__mcpDialogOverrides) {
      window.__mcpDialogOverrides = true;

      window.alert = function (msg) {
        window.__mcpDialogLog.push({
          type: 'alert',
          message: String(msg),
          timestamp: Date.now(),
          handled: window.__mcpDialogAction,
        });
      };

      window.confirm = function (msg) {
        const accepted = window.__mcpDialogAction === 'accept';
        window.__mcpDialogLog.push({
          type: 'confirm',
          message: String(msg),
          timestamp: Date.now(),
          result: accepted,
        });
        return accepted;
      };

      window.prompt = function (msg, def) {
        const accepted = window.__mcpDialogAction === 'accept';
        const text = accepted ? (window.__mcpDialogPromptText || def || '') : null;
        window.__mcpDialogLog.push({
          type: 'prompt',
          message: String(msg),
          timestamp: Date.now(),
          result: text,
        });
        return accepted ? text : null;
      };
    }

    const log = [...window.__mcpDialogLog];
    window.__mcpDialogLog = [];
    return {
      success: true,
      dialogs: log,
      message: log.length ? 'Retrieved dialog history' : 'Overrides configured',
    };
  }, [action, promptText]);
}

async function handleRunAction(params) {
  if (requestFrameId !== 0) throw new Error('run_action is top-frame only. Use frame snapshot/type/keys, or select_frame 0.');
  const { code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await getActiveTab();
  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    if (!attached) throw new Error(DEBUGGER_ATTACH_ERROR);

    const paramsJson = JSON.stringify(actionParams);
    const expression = `(async function() { try { var tool = (${code}); if (tool && typeof tool.execute === "function") { return await tool.execute(${paramsJson}); } return { error: "No execute function found" }; } catch(e) { return { error: e.message, stack: e.stack }; } })()`;

    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );

    if (exceptionDetails) {
      return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    return { success: true, result: result.value };
  });
}

async function handleUploadFile(params) {
  const { ref, selector, filePath, files: fileList } = params;
  const tab = await getActiveTab();
  const filePaths = fileList || (filePath ? [filePath] : []);
  if (filePaths.length === 0) throw new Error('filePath or files required');

  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    if (!attached) throw new Error(DEBUGGER_ATTACH_ERROR);

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable', {});
    const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', {});

    let sel = 'input[type="file"]';
    if (ref) sel = `[data-mcp-ref="${ref}"]`;
    else if (selector) sel = selector;

    const { nodeId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: sel,
    });

    if (!nodeId) throw new Error(`File input not found with selector: ${sel}`);

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', {
      files: filePaths,
      nodeId,
    });

    return { success: true, files: filePaths, selector: sel };
  });
}

async function handleDrag(params) {
  const { startRef, startSelector, endRef, endSelector, startX, startY, endX, endY, steps = 10 } = params;
  const tab = await getActiveTab();

  await interaction.inputReady(tab);
  await interaction.ensureDebugger(tab.id);
  if (requestFrameId !== 0 && (startRef || startSelector || endRef || endSelector)) throw new Error("Use top-frame screenshot coordinates for frame dragging");
  let sx = startX, sy = startY, ex = endX, ey = endY;

  if (sx == null || sy == null || ex == null || ey == null) {
    const coords = await execInTab(tab.id, (_sRef, _sSel, _eRef, _eSel) => {
      function find(ref, sel) {
        let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
        if (!el && sel) el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return {
        start: find(_sRef, _sSel),
        end: find(_eRef, _eSel),
      };
    }, [startRef, startSelector, endRef, endSelector]);

    if (coords.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords.end) { ex = coords.end.x; ey = coords.end.y; }
  }

  if (sx == null || sy == null || ex == null || ey == null) {
    throw new Error('Could not determine drag coordinates. Provide refs/selectors or explicit x,y coordinates.');
  }

  return debuggerSession.withDebugger(tab.id, async ({ attached }) => {
    if (!attached) throw new Error(DEBUGGER_ATTACH_ERROR);

    await showVisualCursor(tab.id, sx, sy, false);
    await sendMouse(tab.id, 'mousePressed', sx, sy, { button: 'left', clickCount: 1, buttons: 1 });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = sx + (ex - sx) * t;
      const ny = sy + (ey - sy) * t;
      await sendMouse(tab.id, 'mouseMoved', nx, ny, { button: 'left', buttons: 1 });
      if (i === 1 || i === steps || i % 2 === 0) {
        await showVisualCursor(tab.id, nx, ny, false);
      }
    }

    await sendMouse(tab.id, 'mouseReleased', ex, ey, { button: 'left', clickCount: 1, buttons: 0 });
    await showVisualCursor(tab.id, ex, ey, true);
    lastPointer.set(tab.id, { x: ex, y: ey });

    return { success: true, from: { x: sx, y: sy }, to: { x: ex, y: ey } };
  });
}

async function handleFillForm(params) {
  const { fields, submit } = params;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields array is required');
  }
  const tab = await getActiveTab();

  return execInTab(tab.id, (_fields, _submit) => {
    const results = [];
    for (const field of _fields) {
      const { ref, selector, value, clear } = field;
      let el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : null;
      if (!el && selector) el = document.querySelector(selector);
      if (!el) {
        results.push({ selector: selector || ref, success: false, error: 'Not found' });
        continue;
      }

      el.focus();

      if (clear !== false) {
        if (el.isContentEditable) {
          el.textContent = '';
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (el.tagName === 'SELECT') {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== !!value) el.click();
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, value);
      } else {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: selector || ref, success: true, value });
    }

    if (_submit) {
      const form = document.querySelector('form');
      if (form) {
        const submitBtn = form.querySelector('[type="submit"]') || form.querySelector('button:not([type="button"])');
        if (submitBtn) submitBtn.click();
        else form.submit();
      }
    }

    return { success: true, fields: results };
  }, [fields, submit]);
}

// --- Events ---

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'console') {
    consoleMessages.push({ level: msg.level, text: msg.text, timestamp: Date.now(), url: sender.tab?.url });
    if (consoleMessages.length > 500) consoleMessages = consoleMessages.slice(-500);
  } else if (msg.type === 'getStatus') {
    respond(buildStatusPayload());
  } else if (msg.type === 'setPort') {
    const p = parseInt(msg.port, 10);
    if (p > 0 && p < 65536) {
      wsPort = p;
      chrome.storage.local.set({ wsPort: p });
      ws?.close();
      ws = null;
      isConnected = false;
      reconnectAttempts = 0;
      connect();
      respond({ success: true, port: p });
    } else {
      respond({ success: false, error: 'Invalid port' });
    }
  }
  return true;
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    networkRequests.push({
      method: details.method, url: details.url,
      status: details.statusCode, type: details.type, timestamp: details.timeStamp,
    });
    if (networkRequests.length > 200) networkRequests = networkRequests.slice(-200);
  },
  { urls: ['<all_urls>'] },
);

initConnection();
