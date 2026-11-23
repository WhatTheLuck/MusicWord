import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { serveParameterPresets } from './parameter-preset-store.mjs';

test('parameter snapshots persist independently, retain versions, and preserve a complete bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicword-preset-store-test-'));
  const server = createServer((req, res) => serveParameterPresets(req, res, new URL(req.url, 'http://localhost').pathname, directory));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/parameter-presets/`;
  const get = async (page) => (await fetch(base + page)).json();
  const save = async (page, settings, name = '测试') => {
    const response = await fetch(base + page, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, settings})});
    assert.equal(response.status, 201);
    return response.json();
  };
  try {
    assert.deepEqual(await get('bpe-run'), []);
    const [first, second, lego] = await Promise.all([
      save('bpe-run', {threshold: .9}), save('bpe-run', {threshold: .8}),
      save('lego', {draft: {root: 'G'}, clips: [{root: 'C', beats: 4}]}),
    ]);
    assert.notEqual(first.id, second.id);
    assert.equal((await get('bpe-run')).length, 2);
    assert.deepEqual(await get('annotation'), []);
    const pages = Object.fromEntries(['annotation', 'bpe-run', 'ssm', 'activebasis', 'lego'].map((page) =>
      [page, page === 'lego' ? lego.settings : {threshold: .5}]));
    const bundle = await save('all', {pages, audio: {bpm: 132}});
    const disk = JSON.parse(await readFile(join(directory, 'all', bundle.id + '.json'), 'utf8'));
    assert.deepEqual(disk.settings.pages, pages);
    assert.deepEqual((await get('all'))[0], disk);
    assert.equal(disk.settings.pages.lego.clips[0].beats, 4);
    const invalid = await fetch(base + 'ssm', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'});
    assert.equal(invalid.status, 400);
    const empty = await fetch(base + 'ssm', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'test', settings: null})});
    assert.equal(empty.status, 400);
    assert.equal((await fetch(base + 'unknown')).status, 404);
    assert.deepEqual(await get('ssm'), []);
    assert.equal((await get('bpe-run')).length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('musicword-preset-store-test-'));
    await rm(target, {recursive: true});
  }
});
