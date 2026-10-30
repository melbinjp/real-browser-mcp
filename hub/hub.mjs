/**
 * Browser hub: one process that owns the extension, shared by every agent.
 *
 * The Chrome extension connects out to a single WebSocket port, and the bridge
 * keeps one client. So exactly one process can drive the browser. If each CLI
 * spawns its own real-browser-mcp, the second one dies with EADDRINUSE and the
 * third never sees a browser at all.
 *
 * The hub owns that port once. Each CLI runs shim.mjs instead, which speaks MCP
 * on stdio and forwards every call here over HTTP. One extension, any number of
 * agents, no contest for the port.
 */

import http from 'http';
import { ExtensionBridge } from '../mcp-server/dist/bridge.js';
import { TOKEN_FILE, hubToken, tokenMatches } from './token.mjs';

const WS_PORT = parseInt(process.env.WS_PORT || '7225', 10);
const HTTP_PORT = parseInt(process.env.HUB_PORT || '7226', 10);

const bridge = new ExtensionBridge({ port: WS_PORT });
const TOKEN = hubToken();

// Any web page can send a request to 127.0.0.1, and a command such as
// browser_evaluate runs code in the person's logged-in tabs. So a call needs
// the secret from the token file. A browser also adds Origin to a request from
// a page, and a Host other than this address means a hostname that was pointed
// here (DNS rebinding); both are refused before the secret is checked.
function fromThisMachine(req) {
  if (req.headers.origin) return false;
  return req.headers.host === `127.0.0.1:${HTTP_PORT}` || req.headers.host === `localhost:${HTTP_PORT}`;
}

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (!fromThisMachine(req)) {
    return send(res, 403, { success: false, error: 'Calls from web pages are refused' });
  }

  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, { ok: true, connected: bridge.isConnected(), wsPort: WS_PORT });
  }

  if (req.method === 'POST' && req.url === '/call') {
    if (!tokenMatches(req.headers['x-hub-token'], TOKEN)) {
      return send(res, 403, { success: false, error: `No valid X-Hub-Token. Shims read it from ${TOKEN_FILE}; restart an agent whose shim predates the lock.` });
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // A runaway body is a bug upstream of here, not something to buffer.
      if (body.length > 20e6) req.destroy();
    });
    req.on('end', async () => {
      let tool, params, agent;
      try {
        ({ tool, params, agent } = JSON.parse(body));
      } catch {
        return send(res, 400, { success: false, error: 'Body is not valid JSON' });
      }
      if (!tool) return send(res, 400, { success: false, error: 'No tool named' });
      try {
        const result = await bridge.callTool(tool, params || {}, agent);
        send(res, 200, { success: true, result });
      } catch (err) {
        send(res, 200, { success: false, error: err?.message || String(err) });
      }
    });
    return;
  }

  send(res, 404, { success: false, error: 'Not found' });
});

async function main() {
  await bridge.start();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, '127.0.0.1', resolve);
  });
  console.error(`[hub] extension on ws://localhost:${WS_PORT}, agents on http://127.0.0.1:${HTTP_PORT}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    bridge.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[hub] fatal:', err.message);
  process.exit(1);
});
