import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));
const runsDirectory = join(projectDirectory, "results", "simple_sparse_code");
const dataFile = "training-data.json";
const missingRun = "找不到回放数据。请先运行 SimpleSparseCode.py --visualize，或设置 ACTIVE_BASIS_PLAYBACK 指向 Playback.html。";
const environmentPython = join(projectDirectory, ".venv",
  ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

function runWorkbench(body, response) {
  const hasPython = process.env.ACTIVE_BASIS_PYTHON || existsSync(environmentPython);
  const useLauncher = !hasPython && process.platform === "win32";
  const python = process.env.ACTIVE_BASIS_PYTHON ||
    (hasPython ? environmentPython : (useLauncher ? "py" : "python3"));
  const args = [...(useLauncher ? ["-3.11"] : []), join(projectDirectory, "workbench.py")];
  const child = spawn(python, args, { cwd: projectDirectory, windowsHide: true });
  const chunks = [];
  let size = 0;
  let failure = "";
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => { failure = (failure + chunk).slice(-4000); });
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size <= 96 * 1024 * 1024) chunks.push(chunk);
    else {
      failure = "训练记录过大。请减少迭代轮数、变体数量或量化分辨率。";
      child.kill();
    }
  });
  child.on("error", (error) => { failure = error.message; });
  response.once("close", () => { if (!response.writableEnded) child.kill(); });
  child.on("close", (code) => {
    if (response.destroyed) return;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (code === 0) response.end(Buffer.concat(chunks));
    else {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: failure.includes("No module named")
        ? "Python 依赖未安装。请先按 README 安装 requirements.txt。"
        : failure || "本地计算进程已退出。" }));
    }
  });
  child.stdin.end(body);
}

function setupWorkbench(server) {
  server.middlewares.use("/workbench-api", async (request, response) => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 15 * 1024 * 1024) {
          response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "MIDI 文件超过 10 MB。" }));
          return;
        }
        chunks.push(chunk);
      }
      runWorkbench(Buffer.concat(chunks), response);
    } catch {
      if (!response.writableEnded) response.end();
    }
  });
}

async function latestPlayback() {
  const entries = await readdir(runsDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const numberedRuns = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((a, b) => Number(b.name) - Number(a.name));
  for (const entry of numberedRuns) {
    try {
      return await readFile(join(runsDirectory, entry.name, "Playback.html"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function trainingData() {
  const override = process.env.ACTIVE_BASIS_PLAYBACK;
  const html = override ? await readFile(resolve(override), "utf8") : await latestPlayback();
  if (html === null) return null;
  const data = html.match(/<script id="training-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!data) throw new Error("Playback.html 中缺少训练记录，请重新导出回放。");
  return data;
}

export default defineConfig({
  root: join(projectDirectory, "web"),
  base: "./",
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: join(projectDirectory, "dist"), emptyOutDir: true },
  plugins: [{
    name: "activebasis-training-data",
    configurePreviewServer: setupWorkbench,
    configureServer(server) {
      setupWorkbench(server);
      server.middlewares.use(`/${dataFile}`, async (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
          const data = await trainingData();
          if (data === null) {
            response.statusCode = 404;
            response.end(missingRun);
            return;
          }
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(data);
        } catch (error) {
          server.config.logger.error(error.message);
          response.statusCode = 404;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(error.code === "ENOENT" ? missingRun : "无法读取 Playback.html，请检查回放文件。");
        }
      });
    },
    async generateBundle() {
      const source = await trainingData();
      if (source !== null) this.emitFile({ type: "asset", fileName: dataFile, source });
    },
  }],
});
