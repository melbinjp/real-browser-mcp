/**
 * The hub's secret. A web page can send a request to 127.0.0.1, so the hub
 * accepts calls only from processes that can read this file, which is kept in
 * the user's home folder. RB_HUB_TOKEN_FILE moves it.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const TOKEN_FILE = process.env.RB_HUB_TOKEN_FILE || join(homedir(), '.real-browser-mcp', 'hub-token');

/** Read the secret, or make it once. The hub and the first shim can race here. */
export function hubToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {}
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(TOKEN_FILE, token, { flag: 'wx', mode: 0o600 });
    return token;
  } catch (err) {
    if (err.code === 'EEXIST') return readFileSync(TOKEN_FILE, 'utf8').trim();
    throw err;
  }
}

export function tokenMatches(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
