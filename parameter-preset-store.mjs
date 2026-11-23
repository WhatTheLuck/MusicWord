import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const pages = new Set(['annotation', 'bpe-run', 'ssm', 'activebasis', 'lego', 'all']);
const presetFile = /^[a-f0-9-]{36}\.json$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function serveParameterPresets(req, res, pathname, directory) {
  const page = pathname.slice('/api/parameter-presets/'.length);
  if (!pages.has(page)) return respond(res, 404, { error: '未找到该页面的参数方案。' });
  const folder = join(directory, page);
  try {
    if (req.method === 'GET') {
      const files = await readdir(folder).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const presets = await Promise.all(files.filter((file) => presetFile.test(file)).map(async (file) =>
        JSON.parse(await readFile(join(folder, file), 'utf8'))));
      return respond(res, 200, presets.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    }
    if (req.method !== 'POST') return respond(res, 405, { error: '该操作不受支持。' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return respond(res, 415, { error: '参数方案须以 JSON 保存。' });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.resume();
        return respond(res, 413, { error: '参数方案过大，无法保存。' });
      }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(payload) || !object(payload.settings) || !Object.keys(payload.settings).length ||
        typeof payload.name !== 'string' || payload.name.length > 80) {
      return respond(res, 400, { error: '参数方案格式无效，请重新保存。' });
    }
    if (page === 'all' && (!object(payload.settings.pages) || !object(payload.settings.audio) ||
        [...pages].filter((key) => key !== 'all').some((key) => !object(payload.settings.pages[key])))) {
      return respond(res, 400, { error: '全部参数方案缺少页面或试听设置。' });
    }
    const savedAt = new Date().toISOString();
    const preset = {
      schemaVersion: 1, page, id: randomUUID(),
      name: payload.name.trim() || '参数方案', savedAt, settings: payload.settings,
    };
    await mkdir(folder, { recursive: true });
    const path = join(folder, preset.id + '.json');
    const temporary = path + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(preset, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return respond(res, 201, preset);
  } catch (error) {
    if (error instanceof SyntaxError) return respond(res, 400, { error: '参数 JSON 无法读取，请检查参数方案文件。' });
    console.error(error.message);
    return respond(res, 500, { error: '无法读写参数方案目录，请检查目录权限。' });
  }
}
