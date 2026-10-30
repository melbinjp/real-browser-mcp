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

## Install this fork on another device

This fork is not in the Chrome Web Store or on npm, so the store extension and
`npx real-browser-mcp` give you upstream's code without these changes. Install
it from the repository:

    git clone https://github.com/melbinjp/real-browser-mcp.git
    cd real-browser-mcp
    npm ci
    npm run build

1. Open `chrome://extensions` (`edge://extensions` in Edge, `brave://extensions`
   in Brave) and turn on Developer mode.
2. Click "Load unpacked" and select the `extension` folder of the clone.
3. If the store version of Real Browser MCP is also installed, turn it off. Both
   connect to port 7225, and only one can have it.
4. Point each CLI at the shim, as shown above, with `<repo>` replaced by the
   clone's path.

To update, run `git pull`, then `npm ci` and `npm run build`. Then reload the
extension: an agent can call `browser_reload_extension`, or click Reload on the
extension's card. Do not skip it: a restarted browser can keep running the old
extension code even when the card shows the new version.

## Working beside the person

Each agent has its own working tab, and its tools act there, not on the tab
the person is looking at.
`browser_tabs create` opens a tab in the background and makes it the working
tab. `browser_tabs select` makes an open tab the working tab without showing
it, so the agent can click, type and take screenshots there while the person
keeps working in another tab or another window, or has the browser minimized.
Nothing moves.

Several agents can work at once, on different tabs or on the same one. The
shim names its agent from the MCP client and that client's process ID, for
example `claude-code#4120`; set `RB_AGENT` to choose the name. `browser_tabs
list` shows the caller's name and, on each tab, the agents working there. Any
page tool takes a `tabId` to act on another tab for one call. Calls from all
agents still run one at a time, so two agents never act in the same moment.
