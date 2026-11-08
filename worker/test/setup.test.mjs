import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kvIdFromOutput, kvIdFromToml, mergeEnv, parseEnv, setEndpoint, setKvId, workersUrl } from '../setup.mjs';

test('mergeEnv: меняет только нужные ключи, остальное и переносы строк не трогает', () => {
  const before = '# Музыка\r\nLASTFM_API_KEY="abc"\r\nSITE_NOW_URL=old\r\n\r\nGROQ_API=x\r\n';
  const after = mergeEnv(before, { SITE_NOW_URL: 'https://w/now', SITE_PUSH_TOKEN: 'tok' });
  assert.equal(after, '# Музыка\r\nLASTFM_API_KEY="abc"\r\nSITE_NOW_URL=https://w/now\r\n\r\nGROQ_API=x\r\nSITE_PUSH_TOKEN=tok\r\n');
  assert.deepEqual(parseEnv(after), { LASTFM_API_KEY: 'abc', SITE_NOW_URL: 'https://w/now', GROQ_API: 'x', SITE_PUSH_TOKEN: 'tok' });
});

test('mergeEnv: пустой файл и export', () => {
  assert.equal(mergeEnv('', { A: '1' }), 'A=1\n');
  assert.equal(mergeEnv('export A=0\n', { A: '1' }), 'A=1\n');
});

test('KV: id вписывается вместо закомментированного блока и читается обратно', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.equal(kvIdFromToml(toml), null);
  const id = 'a'.repeat(32);
  const next = setKvId(toml, id);
  assert.equal(kvIdFromToml(next), id);
  assert.equal(kvIdFromToml(setKvId(next, 'b'.repeat(32))), 'b'.repeat(32));
  assert.ok(next.includes('[[durable_objects.bindings]]'));
});

test('вывод wrangler: id KV в формате toml и json, адрес воркера', () => {
  assert.equal(kvIdFromOutput('[[kv_namespaces]]\nbinding = "CACHE"\nid = "0123456789abcdef0123456789abcdef"'), '0123456789abcdef0123456789abcdef');
  assert.equal(kvIdFromOutput('{ "binding": "CACHE", "id": "0123456789abcdef0123456789abcdef" }'), '0123456789abcdef0123456789abcdef');
  assert.equal(workersUrl('Deployed folzy-music triggers\n  https://folzy-music.denis-v.workers.dev\nCurrent Version'), 'https://folzy-music.denis-v.workers.dev');
});

test('config.js: адрес endpoint подставляется', () => {
  const cfg = readFileSync(new URL('../../assets/js/config.js', import.meta.url), 'utf8');
  const next = setEndpoint(cfg, 'https://folzy-music.x.workers.dev');
  assert.match(next, /musicEndpoint: 'https:\/\/folzy-music\.x\.workers\.dev'/);
  assert.equal(next.split('\n').length, cfg.split('\n').length);
});
