import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('omits embedded media bytes by default and returns only selected DOM media', async () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleMedia('), source.indexOf('async function handleEvaluate('));
  const media = runInNewContext(handler + '; handleMedia', {
    getActiveTab: async () => ({ id: 1 }),
    execInTab: async (_id: number, fn: Function, args: unknown[]) => fn(...args),
    document: { querySelectorAll: () => [
      { tagName: 'VIDEO', currentSrc: 'data:video/mp4;base64,YWJj', duration: 6, getAttribute: () => null },
      { tagName: 'IMG', src: 'https://example.test/image.png', getAttribute: () => 'Reference' },
    ] },
  });
  const preview = await media({});
  expect(preview.media[0]).toMatchObject({ embedded: true, source: undefined, duration: 6 });
  expect(preview.media[1].source).toBe('https://example.test/image.png');
  expect((await media({ includeData: true })).media[0].source).toBe('data:video/mp4;base64,YWJj');
});

it('replaces full snapshot refs before compact and scoped snapshots', async () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleSnapshot('), source.indexOf('async function handleScreenshot('));
  const nodes: any[] = [];
  const element = (tagName: string, innerText: string, children: any[] = []) => {
    const attrs = new Map<string, string>();
    const node = { tagName, innerText, children, nodeType: 1,
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      removeAttribute: (key: string) => attrs.delete(key),
      getBoundingClientRect: () => ({ width: 100, height: 20 }) };
    nodes.push(node); return node;
  };
  const oldGeneric = element('SPAN', 'Label');
  const button = element('BUTTON', 'Generate');
  const body = element('BODY', 'Label\nGenerate', [oldGeneric, button]);
  const html = element('HTML', '', [body]);
  const snapshot = runInNewContext(handler + '; handleSnapshot', {
    getActiveTab: async () => ({ id: 1 }),
    execInTab: async (_id: number, fn: Function, args: unknown[]) => fn(...args),
    document: { body, documentElement: html, title: 'Test', querySelector: () => button },
    location: { href: 'https://example.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  await snapshot({ compact: false });
  expect(oldGeneric.getAttribute('data-mcp-ref')).not.toBeNull();
  await snapshot({ compact: true });
  expect(oldGeneric.getAttribute('data-mcp-ref')).toBeNull();
  let refs = nodes.map(n => n.getAttribute('data-mcp-ref')).filter(Boolean);
  expect(new Set(refs).size).toBe(refs.length);
  await snapshot({ compact: true, selector: 'button' });
  refs = nodes.map(n => n.getAttribute('data-mcp-ref')).filter(Boolean);
  expect(refs).toEqual(['e0']);
});
