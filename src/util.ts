// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 工具层
// 进程调用 / 文件 / 哈希 / 浏览器与 FFmpeg 发现 / 时间格式化
// ════════════════════════════════════════════════════════════════
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 无 shell 子进程调用（参数数组直传，避免一切引号问题） */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string; allowFail?: boolean; onStdout?: (chunk: string) => void } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer: NodeJS.Timeout | null = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`命令超时(${opts.timeoutMs}ms): ${cmd}`));
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && !opts.allowFail) {
        reject(new Error(`命令失败(exit ${code}): ${cmd} ${args.join(" ")}\n${stderr.slice(-1500)}`));
      } else {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

// ── 文件 ────────────────────────────────────────────────────────
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

export function sha1Short(...parts: Array<string | number | undefined>): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(String(p ?? "")).update("\u0000");
  return h.digest("hex").slice(0, 16);
}

export function fileSizeHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 时间戳 jobId：20260922-003512-abc123 */
export function jobStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
    Math.random().toString(36).slice(2, 8)
  );
}

/** 文件名安全化（保留中英文数字与少数符号） */
export function safeName(name: string, fallback = "shiying"): string {
  const s = name.replace(/[\\/:*?"<>|\r\n\t]+/g, "").replace(/\s+/g, " ").trim();
  return s || fallback;
}

// ── 可执行文件发现 ──────────────────────────────────────────────
/** 在 PATH 中查找可执行文件 */
export function findInPath(names: string[]): string | null {
  const pathVar = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidates = process.platform === "win32" && !/\.[A-Za-z]+$/.test(name) ? exts.map((e) => name + e) : [name];
      for (const c of candidates) {
        const full = path.join(dir, c);
        if (exists(full)) return full;
      }
    }
  }
  return null;
}

export interface BrowserInfo {
  exe: string;
  brand: "edge" | "chrome";
}

/** 找无头浏览器（msedge first，其次 chrome；支持环境变量覆盖） */
export function findBrowser(override?: string): BrowserInfo | null {
  const manual = override || process.env.SHIYING_BROWSER;
  if (manual && exists(manual)) {
    return { exe: manual, brand: /chrome/i.test(manual) ? "chrome" : "edge" };
  }
  const edgeCandidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of edgeCandidates) if (exists(c)) return { exe: c, brand: "edge" };
  const chromeCandidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  for (const c of chromeCandidates) if (c && exists(c)) return { exe: c, brand: "chrome" };
  const inPath = findInPath(["msedge", "chrome", "chromium", "google-chrome"]);
  if (inPath) return { exe: inPath, brand: /chrome/i.test(inPath) ? "chrome" : "edge" };
  return null;
}

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string | null;
}

/** 找 FFmpeg（PATH 优先，其次常见安装位置） */
export function findFfmpeg(): FfmpegInfo | null {
  const manual = process.env.SHIYING_FFMPEG;
  if (manual && exists(manual)) {
    const probe = manual.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    return { ffmpeg: manual, ffprobe: exists(probe) ? probe : null };
  }
  const ffmpeg = findInPath(["ffmpeg"]);
  if (!ffmpeg) return null;
  const ffprobe = findInPath(["ffprobe"]);
  return { ffmpeg, ffprobe };
}

// ── 并发池 ──────────────────────────────────────────────────────
/** 简单并发池：按并发数执行任务，保持原顺序返回 */
export async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, queue.length));
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          await worker(next.item, next.index);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// ── 控制台样式（CLI） ───────────────────────────────────────────
export const C = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
};

export function log(tag: string, msg: string, color: string = C.dim): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${C.dim}${time}${C.reset} ${color}${tag}${C.reset} ${msg}`);
}

export function progressBar(k: number, width = 22): string {
  const filled = Math.round(Math.max(0, Math.min(1, k)) * width);
  return `${C.green}${"█".repeat(filled)}${C.dim}${"─".repeat(width - filled)}${C.reset}`;
}
