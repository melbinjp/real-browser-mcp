/**
 * Three agents, one browser. This is the case that used to fail: each CLI
 * spawned its own server, the second died on EADDRINUSE, and the third never
 * saw a browser. Run with: node hub/hub.test.mjs
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hubToken } from './token.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = ['claude', 'agy', 'codex'];

function startShim(name) {
  const p = spawn(process.execPath, [join(HERE, 'shim.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.on('error', e => console.log(`[${name}] spawn error: ${e.message}`));
  return p;
}

function rpc(proc, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', onData);
            return resolve(msg);
          }
        } catch {
          // partial frame, wait for the rest
        }
      }
    };
    proc.stdout.on('data', onData);
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`no reply to ${method}`));
    }, 25_000);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const shims = AGENTS.map(startShim);
let failed = false;

try {
  const results = await Promise.all(
    shims.map(async (p, i) => {
      await rpc(p, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: AGENTS[i], version: '1' },
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await rpc(p, 2, 'tools/list');
      return (list.result?.tools || []).length;
    }),
  );

  results.forEach((n, i) => {
    const ok = n > 0;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${AGENTS[i]}: ${n} tools`);
  });

  const unique = new Set(results);
  if (unique.size !== 1) {
    failed = true;
    console.log('FAIL: the three agents saw different tool lists');
  } else {
    console.log(`PASS: all three agents share one browser, ${results[0]} tools each`);
  }

  // A call through a shim reaches the hub. With no browser connected the
  // answer is an error from the extension side, which still proves the hub let
  // the shim in.
  const call = await rpc(shims[0], 3, 'tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  const text = call.result?.content?.[0]?.text || '';
  if (/X-Hub-Token|web pages are refused/.test(text)) {
    failed = true;
    console.log('FAIL: the hub refused a shim:', text);
  } else {
    console.log('PASS: a shim call reaches the hub');
  }

  // What a web page could send to this machine must be refused.
  const HUB = `http://127.0.0.1:${process.env.HUB_PORT || '7226'}`;
  const body = JSON.stringify({ tool: 'browser_tabs', params: { action: 'list' } });
  const attempts = {
    'no token': { 'Content-Type': 'text/plain' },
    'wrong token': { 'X-Hub-Token': 'x'.repeat(64) },
    'token but from a web page': { 'X-Hub-Token': hubToken(), Origin: 'https://example.com' },
  };
  for (const [name, headers] of Object.entries(attempts)) {
    const res = await fetch(`${HUB}/call`, { method: 'POST', headers, body });
    if (res.status === 403) console.log(`PASS: refused, ${name}`);
    else { failed = true; console.log(`FAIL: accepted, ${name} (${res.status})`); }
  }
} catch (err) {
  failed = true;
  console.log('FAIL:', err.message);
} finally {
  shims.forEach(p => p.kill());
}

process.exit(failed ? 1 : 0);
