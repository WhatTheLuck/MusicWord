import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { serveSharedAnnotations } from './shared-annotation-store.mjs';
import { serveParameterPresets } from './parameter-preset-store.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const previewAssets = join(root, 'ActiveBasis', 'web', 'public', 'music-preview');
const host = '127.0.0.1';
const port = Number(process.env.MUSICWORD_PORT ?? 8770);
const children = [];
const pages = new Map([
  ['/', ['web/index.html', 'text/html']],
  ['/tabs.css', ['web/tabs.css', 'text/css']],
  ['/tabs.js', ['web/tabs.js', 'text/javascript']],
  ['/parameter-presets.js', ['web/parameter-presets.js', 'text/javascript']],
  ['/shared-annotations.mjs', ['web/shared-annotations.mjs', 'text/javascript']],
  ['/shared-annotations.css', ['web/shared-annotations.css', 'text/css']],
  ['/lego/', ['LEGO/index.html', 'text/html']],
  ['/lego/bank.js', ['LEGO/bank.js', 'text/javascript']],
  ['/lego/music.js', ['LEGO/music.js', 'text/javascript']],
  ['/lego/studio.js', ['LEGO/studio.js', 'text/javascript']],
  ['/lego/studio.css', ['LEGO/studio.css', 'text/css']],
]);

function startService(name, directory, command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: join(root, directory), env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    let ready = false;
    const timeout = setTimeout(() => reject(new Error(name + ' 启动超时。')), 30000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      console.log('[' + name + '] ' + line);
      const address = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!ready && address) {
        ready = true;
        clearTimeout(timeout);
        resolve(Number(address[1]));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(name + ' 无法启动：' + error.message));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (ready) {
        console.error(name + ' 已退出（' + code + '）。');
      } else {
        reject(new Error(name + ' 启动失败（' + code + '）。'));
      }
    });
  });
}

function proxy(req, res, targetPort, targetPath, prefix) {
  const headers = { ...req.headers, host: host + ':' + targetPort, connection: 'close' };
  const upstream = request({ host, port: targetPort, path: targetPath, method: req.method, headers }, (incoming) => {
    if (incoming.headers.location?.startsWith('/') && !incoming.headers.location.startsWith('//')) {
      incoming.headers.location = prefix + incoming.headers.location;
    }
    res.writeHead(incoming.statusCode, incoming.headers);
    incoming.on('error', () => res.destroy());
    incoming.pipe(res);
  });
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('工作台服务暂时不可用。请查看启动窗口。');
  });
  res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

const ssmPython = join(root, 'SSM', '.venv', ...(process.platform === 'win32'
  ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const stopChildren = () => children.forEach((child) => child.kill());
process.on('exit', stopChildren);
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

try {
  for (const build of ['BPE/dist/index.html', 'ActiveBasis/dist/index.html']) {
    if (!existsSync(join(root, build))) throw new Error('缺少 ' + build + '，请在 MusicWord 根目录运行 npm start。');
  }
  const [bpe, ssm, activeBasis] = await Promise.all([
    startService('BPE', 'BPE', process.execPath, ['server.mjs', '--production'], {
      ...process.env, BPE_HOST: host, BPE_PORT: '0',
    }),
    startService('SSM', 'SSM', ssmPython, ['workbench.py', '--port', '0']),
    startService('ActiveBasis', 'ActiveBasis', process.execPath,
      ['node_modules/vite/bin/vite.js', 'preview', '--host', host, '--port', '0', '--strictPort'], {
        ...process.env, ACTIVE_BASIS_POP909: process.env.ACTIVE_BASIS_POP909 || join(root, 'BPE', 'POP909'),
      }),
  ]);
  const routes = new Map([['/bpe', bpe], ['/ssm', ssm], ['/activebasis', activeBasis]]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + host);
    if (url.pathname.startsWith('/api/parameter-presets/')) {
      await serveParameterPresets(req, res, url.pathname, process.env.MUSICWORD_PRESETS_DIR || join(root, 'parameter-presets'));
      return;
    }
    if (url.pathname === '/api/annotations' || url.pathname.startsWith('/api/annotations/')) {
      await serveSharedAnnotations(req, res, url.pathname, process.env.MUSICWORD_ANNOTATIONS_DIR || join(root, 'annotations'));
      return;
    }
    if (url.pathname === '/lego') {
      res.writeHead(308, { Location: '/lego/' + url.search });
      res.end();
      return;
    }
    const preview = url.pathname.match(/^\/(?:ActiveBasis\/web\/public\/)?music-preview\/((?:samples\/)?[a-z0-9_-]+\.js)$/i);
    if (preview && ['GET', 'HEAD'].includes(req.method)) {
      try {
        const body = await readFile(join(previewAssets, preview[1]));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(body);
      } catch (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500);
        res.end();
      }
      return;
    }
    const prefix = '/' + url.pathname.split('/')[1];
    const targetPort = routes.get(prefix);
    if (targetPort) {
      if (url.pathname === prefix) {
        res.writeHead(308, { Location: prefix + '/' + url.search });
        res.end();
      } else {
        proxy(req, res, targetPort, url.pathname.slice(prefix.length) + url.search, prefix);
      }
      return;
    }

    const page = pages.get(url.pathname);
    if (!page || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const [filename, type] = page;
      const body = await readFile(join(root, filename));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (error) {
      console.error(error.message);
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const address = 'http://' + host + ':' + server.address().port + '/';
  console.log('MusicWord 工作台 ' + address);
  if (process.argv.includes('--open')) {
    const [command, ...args] = process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler']
      : [process.platform === 'darwin' ? 'open' : 'xdg-open'];
    const browser = spawn(command, [...args, address], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    browser.on('error', () => console.log('请在浏览器打开 ' + address));
    browser.unref();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
