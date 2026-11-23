import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceKey = /^[a-f0-9]{64}$/;
const maxMidiBytes = 2 * 1024 * 1024;

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function summary({ sourceId, song, createdAt, tracks }) {
  return { sourceId, song, createdAt, tracks: tracks.length };
}

async function readPayload(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validate(document, id) {
  if (document?.schema !== 'musicword-annotation' || document.schemaVersion !== 1 || document.sourceId !== id ||
      typeof document.song?.name !== 'string' || !document.song.name || typeof document.fileName !== 'string' ||
      !Number.isSafeInteger(document.timing?.sourcePpq) || document.timing.sourcePpq < 1 ||
      !Array.isArray(document.categories) || !document.categories.every((category) =>
        typeof category?.id === 'string' && /^#[0-9a-f]{6}$/i.test(category.color)) ||
      !Array.isArray(document.tracks) || !document.tracks.length || typeof document.midi !== 'string') return false;
  return document.tracks.every((track) => {
    if (!sourceKey.test(track?.signature) || typeof track.trackId !== 'string' ||
        !Array.isArray(track.notes) || !track.notes.length || !Array.isArray(track.layers)) return false;
    if (!track.notes.every((note) => note && typeof note.id === 'string' &&
        [note.ticks, note.durationTicks, note.midi].every(Number.isSafeInteger) &&
        note.ticks >= 0 && note.durationTicks >= 0 && note.midi >= 0 && note.midi < 128)) return false;
    const notes = new Set(track.notes.map((note) => note.id));
    return notes.size === track.notes.length && track.layers.every((layer) =>
      typeof layer?.id === 'string' && typeof layer.name === 'string' &&
      Array.isArray(layer.words) && layer.words.every((word) =>
        typeof word?.id === 'string' && typeof word.categoryId === 'string' &&
        Array.isArray(word.noteIds) && word.noteIds.length && word.noteIds.every((id) => notes.has(id))));
  });
}

export async function serveSharedAnnotations(req, res, pathname, directory) {
  const id = pathname.slice('/api/annotations/'.length);
  const list = pathname === '/api/annotations';
  if (!list && !sourceKey.test(id)) return respond(res, 404, { error: '未找到标注。' });
  try {
    if (req.method === 'GET' && list) {
      const entries = await readdir(directory).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const files = entries.filter((name) => name.endsWith('.json') && sourceKey.test(name.slice(0, -5)));
      const documents = await Promise.all(files.map(async (name) => summary(JSON.parse(await readFile(join(directory, name), 'utf8')))));
      return respond(res, 200, documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    const path = join(directory, id + '.json');
    if (req.method === 'GET') return respond(res, 200, JSON.parse(await readFile(path, 'utf8')));
    if (req.method !== 'PUT' || list) return respond(res, 405, { error: '该操作不受支持。' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return respond(res, 415, { error: '标注须以 JSON 保存。' });
    }
    const document = await readPayload(req);
    if (!validate(document, id)) return respond(res, 400, { error: '标注格式或音符引用无效。' });
    const midi = Buffer.from(document.midi, 'base64');
    if (midi.length > maxMidiBytes || midi.subarray(0, 4).toString() !== 'MThd' ||
        createHash('sha256').update(midi).digest('hex') !== id) {
      return respond(res, 400, { error: '标注中的 MIDI 无效或与数据源不符。' });
    }
    document.createdAt = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(document) + '\n', { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return respond(res, 200, summary(document));
  } catch (error) {
    if (error.code === 'ENOENT') return respond(res, 404, { error: '未找到标注。' });
    if (error instanceof SyntaxError) return respond(res, 400, { error: '标注 JSON 无法读取。' });
    console.error(error.message);
    return respond(res, 500, { error: '无法读写共享标注目录。' });
  }
}
