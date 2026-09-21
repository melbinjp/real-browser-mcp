import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { ExtensionBridge } from '../mcp-server/src/bridge.js';

/**
 * The bridge reclaims its port from a stale listener left by an earlier run.
 *
 * This is the path that fails on Windows: the old implementation shelled out to
 * `lsof`, which does not exist there, so a crashed or orphaned server held the
 * port forever and every later start died with EADDRINUSE.
 */

const PORT = 7402;

function listenersOn(port: number): string[] {
  const cmd = process.platform === 'win32' ? 'netstat -ano' : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
  let out = '';
  try {
    out = execSync(cmd, { encoding: 'utf8' });
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .filter(l => new RegExp(`[:.]${port}\\b`).test(l) && /LISTEN/i.test(l));
}

describe('port reclaim', () => {
  let squatter: ChildProcess | undefined;
  let bridge: ExtensionBridge | undefined;

  afterEach(async () => {
    bridge?.stop();
    bridge = undefined;
    if (squatter && squatter.exitCode === null) {
      try {
        squatter.kill();
      } catch {
        // already gone
      }
    }
    squatter = undefined;
    await new Promise(r => setTimeout(r, 100));
  });

  it('finds the process holding the port, including an IPv6 listener', async () => {
    // localhost resolves to ::1 first, so the listener is on IPv6. On Windows
    // `netstat -p TCP` lists IPv4 only and would report nothing here.
    squatter = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${PORT},'localhost',()=>console.log('ready'));setInterval(()=>{},1e3)`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('squatter did not start')), 10_000);
      squatter!.stdout!.on('data', d => {
        if (String(d).includes('ready')) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    expect(listenersOn(PORT).length).toBeGreaterThan(0);

    bridge = new ExtensionBridge({ port: PORT, maxRetries: 3, pingIntervalMs: 60_000 });
    await expect(bridge.start()).resolves.toBeUndefined();
  }, 30_000);
});
