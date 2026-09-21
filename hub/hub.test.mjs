/**
 * Three agents, one browser. This is the case that used to fail: each CLI
 * spawned its own server, the second died on EADDRINUSE, and the third never
 * saw a browser. Run with: node hub/hub.test.mjs
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
} catch (err) {
  failed = true;
  console.log('FAIL:', err.message);
} finally {
  shims.forEach(p => p.kill());
}

process.exit(failed ? 1 : 0);
