(function () {
  'use strict';
  if (window.__realBrowserMcpInjected) return;
  window.__realBrowserMcpInjected = true;

  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  // Reporting a failed send is itself a send, so a failure that gets captured
  // feeds itself. This guard breaks that loop: while a send is being reported,
  // nothing else is.
  let reporting = false;

  function capture(level, ...args) {
    orig[level].apply(console, args);
    if (reporting) return;
    const text = args.map(a => {
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
    // An extension reload orphans this script: chrome.runtime survives but its
    // id does not, and sending then throws. sendMessage also returns a promise
    // that rejects with no receiver, which a try/catch cannot see, so the
    // rejection is swallowed explicitly rather than surfacing as an unhandled
    // one that the listeners below would capture and re-send.
    reporting = true;
    try {
      if (chrome.runtime?.id) {
        const sent = chrome.runtime.sendMessage({ type: 'console', level, text });
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      }
    } catch {} finally {
      reporting = false;
    }
  }

  console.log = (...a) => capture('log', ...a);
  console.warn = (...a) => capture('warn', ...a);
  console.error = (...a) => capture('error', ...a);
  console.info = (...a) => capture('info', ...a);
  console.debug = (...a) => capture('debug', ...a);

  window.addEventListener('error', (e) => {
    capture('error', `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    capture('error', `Unhandled rejection: ${e.reason}`);
  });
})();
