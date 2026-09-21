# Browser hub

The Chrome extension connects out to one WebSocket port, and the bridge keeps a
single client. So exactly one process can drive the browser. When each CLI spawns
its own `real-browser-mcp`, the second dies with `EADDRINUSE` and the third never
sees a browser.

`hub.mjs` owns that port once. Every agent runs `shim.mjs`, which speaks MCP on
stdio and forwards each call to the hub over HTTP. One extension, any number of
agents.

    node hub/hub.mjs        # usually not needed: the shim starts it on demand
    node hub/hub.test.mjs   # three agents against one hub

Each CLI is pointed at the shim:

    claude mcp add real-browser --scope user -- node <repo>/hub/shim.mjs
    codex  mcp add real-browser -- node <repo>/hub/shim.mjs
    agy    mcp add real-browser node <repo>/hub/shim.mjs

Ports: `WS_PORT` (default 7225) for the extension, `HUB_PORT` (default 7226) for
agents.
