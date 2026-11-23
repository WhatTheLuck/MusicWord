import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const windows = process.platform === 'win32';
const pythonVersionCheck = 'import sys; sys.exit(sys.version_info[:2] != (3, 11))';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + ' ' + args.join(' ') + ' 执行失败（' + (signal ?? code) + '）。'));
    });
  });
}

function isPython311(command, args = []) {
  return spawnSync(command, [...args, '-c', pythonVersionCheck], {
    stdio: 'ignore', windowsHide: true,
  }).status === 0;
}

function findPython() {
  const candidates = process.env.MUSICWORD_PYTHON
    ? [[process.env.MUSICWORD_PYTHON]]
    : windows ? [['py', '-3.11'], ['python']] : [['python3.11'], ['python3'], ['python']];
  const candidate = candidates.find(([command, ...args]) => isPython311(command, args));
  if (!candidate) throw new Error('需要 Python 3.11。请安装后重试，或将 MUSICWORD_PYTHON 设为其可执行文件路径。');
  return candidate;
}

async function installWhenChanged(directory, input, stamp, install, force = false) {
  const hash = createHash('sha256')
    .update([process.platform, process.arch, process.versions.node].join(':'))
    .update(await readFile(join(directory, input)))
    .digest('hex');
  const stampPath = join(directory, stamp);
  const installed = await readFile(stampPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!force && installed === hash) return;
  await install();
  await writeFile(stampPath, hash, 'utf8');
}

async function preparePython(name) {
  const directory = join(root, name);
  const python = join(directory, '.venv', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const needsEnvironment = !isPython311(python);
  if (needsEnvironment) {
    const [command, ...args] = findPython();
    await run(command, [...args, '-m', 'venv', '.venv'], directory);
  }
  await installWhenChanged(directory, 'requirements.txt', '.venv/.musicword-requirements', () =>
    run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], directory), needsEnvironment);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('需要 Node.js 22.12 或更新版本。');

  for (const name of ['SSM', 'ActiveBasis']) await preparePython(name);
  for (const name of ['BPE', 'ActiveBasis']) {
    const directory = join(root, name);
    const npm = (args) => run(process.execPath, [process.env.npm_execpath, ...args], directory);
    await installWhenChanged(directory, 'package-lock.json', 'node_modules/.musicword-lock', () =>
      npm(['ci', '--include=dev', '--no-audit', '--no-fund']));
    await npm(['run', 'build']);
  }
} catch (error) {
  console.error('MusicWord 准备失败：' + error.message);
  process.exitCode = 1;
}
