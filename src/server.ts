// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 本地工作台服务（零依赖 HTTP）
// 把流水线接给 V2 网页面板：任务 API + 进度 SSE + 产物分发
// 仅监听 127.0.0.1，本机使用
// ════════════════════════════════════════════════════════════════
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BGM_LABELS, ROOT, VOICE_PROFILES, getConfig } from "./config.ts";
import { runPipeline, readManifest } from "./pipeline.ts";
import { loadBuiltins } from "./text.ts";
import { derivePersona } from "./persona.ts";
import type { Analysis, EventSink, JobEvent, RunOptions, StageId } from "./types.ts";
import { STAGE_LABELS } from "./types.ts";
import { exists } from "./util.ts";
import { resolveVoiceProfiles } from "./voice.ts";

interface JobRecord {
  id: string;
  status: "queued" | "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  events: JobEvent[];
  stage: StageId | null;
  stageProgress: number;
  overall: number;
  message: string;
  dir?: string;
  analysis?: Analysis;
  error?: string;
  options: Record<string, unknown>;
  /** full = 全链路；analyze = 只出解析与文案（审核）；render = 确认后出片 */
  mode: "full" | "analyze" | "render";
}

const STAGE_WEIGHT: Record<StageId, number> = {
  text: 0.06,
  scenes: 0.03,
  images: 0.42,
  voice: 0.2,
  compose: 0.29,
};

const jobs = new Map<string, JobRecord>();
const sseClients = new Map<string, Set<http.ServerResponse>>();
let queue: Array<() => void> = [];
let running = false;
let outRoot = "";

/** 解析任务目录：内存任务优先，其次磁盘历史任务（output/job-<id>） */
function jobDirById(id: string): string | null {
  const mem = jobs.get(id);
  if (mem?.dir) return mem.dir;
  if (!mem && outRoot) {
    const dir = path.join(outRoot, `job-${id}`);
    if (exists(path.join(dir, "manifest.json"))) return dir;
  }
  return null;
}

function computeOverall(job: JobRecord): number {
  const order: StageId[] = ["text", "scenes", "images", "voice", "compose"];
  let acc = 0;
  for (const st of order) {
    const w = STAGE_WEIGHT[st];
    if (job.stage === st) {
      acc += w * job.stageProgress;
      break;
    }
    if (job.stage && order.indexOf(job.stage) > order.indexOf(st)) acc += w;
  }
  if (job.status === "done") return job.mode === "analyze" ? 0.09 : 1;
  return Math.min(0.999, acc);
}

function pushEvent(jobId: string, ev: JobEvent): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.events.push({ ...ev, overall: undefined });
  if (ev.type === "stage" && ev.stage) {
    job.stage = ev.stage;
    job.stageProgress = ev.status === "done" || ev.status === "skip" ? 1 : ev.progress ?? 0;
    job.message = ev.message ?? job.message;
  } else if (ev.type === "log" && ev.message) {
    job.message = ev.message;
  } else if (ev.type === "done") {
    job.message = ev.message ?? "完成";
  }
  job.events[job.events.length - 1]!.overall = computeOverall(job);
  // 控制事件缓冲规模
  if (job.events.length > 800) job.events.splice(0, job.events.length - 800);
  const clients = sseClients.get(jobId);
  if (clients) {
    const payload = JSON.stringify({ ...job.events[job.events.length - 1]! });
    for (const res of clients) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  }
}

function enqueue<T>(fn: () => Promise<T>): void {
  queue.push(fn as () => void);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
    await (next as unknown as () => Promise<void>)();
  } finally {
    running = false;
    void drain();
  }
}

function startJob(input: {
  poemId?: string;
  text?: string;
  title?: string;
  author?: string;
  dynasty?: string;
  analysis?: Analysis;
  options?: Record<string, unknown>;
  mode?: "full" | "analyze" | "render";
}): JobRecord {
  const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mode = input.mode ?? "full";
  const job: JobRecord = {
    id,
    status: "queued",
    createdAt: Date.now(),
    events: [],
    stage: null,
    stageProgress: 0,
    overall: 0,
    message: "排队中…",
    options: input.options ?? {},
    mode,
  };
  jobs.set(id, job);

  enqueue(async () => {
    job.status = "running";
    pushEvent(id, { type: "log", message: "任务开始" });
    const opts: RunOptions = {
      poemId: input.poemId,
      text: input.text,
      title: input.title,
      author: input.author,
      dynasty: input.dynasty,
      analysis: input.analysis,
      imageProvider: str(input.options?.image),
      textProvider: str(input.options?.textProvider),
      voiceProfile: str(input.options?.voice),
      bgm: str(input.options?.bgm),
      narration: input.options?.narration === "line" ? "line" : "both",
      keepWatermark: input.options?.cropWatermark === true ? false : undefined,
      freshImages: input.options?.freshImages === true,
      concurrency: num(input.options?.concurrency),
    };
    // 编辑重合成：复用上一条任务的图片（跳过画面工序）
    const reuseFrom = str(input.options?.reuseFrom);
    if (reuseFrom) {
      const prev = jobs.get(reuseFrom);
      if (prev?.dir) opts.reuseImagesFrom = prev.dir;
    }
    const sink: EventSink = (ev) => pushEvent(id, ev);
    try {
      const result = await runPipeline(opts, sink, { stopAfter: mode === "analyze" ? "scenes" : undefined });
      job.status = "done";
      job.dir = result.dir;
      job.analysis = result.analysis;
      job.finishedAt = Date.now();
      job.stageProgress = 1;
      job.overall = mode === "analyze" ? 0.09 : 1;
      const doneMsg = result.manifest
        ? `任务完成（${(result.manifest.totalMs / 1000).toFixed(0)} 秒成片）`
        : "解析与文案已就绪（等待确认）";
      pushEvent(id, { type: "done", message: doneMsg, data: { dir: result.dir } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = "error";
      job.error = msg;
      job.finishedAt = Date.now();
      pushEvent(id, { type: "error", message: `任务失败：${msg.slice(0, 300)}` });
    }
  });

  return job;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// ── HTTP ────────────────────────────────────────────────────────
function json(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, mime?: string): void {
  if (!exists(file)) {
    json(res, 404, { ok: false, error: "not found" });
    return;
  }
  const stat = fs.statSync(file);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".srt": "application/x-subrip; charset=utf-8",
    ".ass": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
  };
  const ext = path.extname(file).toLowerCase();
  const type = mime ?? types[ext] ?? "application/octet-stream";
  const isHead = req.method === "HEAD";
  const range = req.headers.range;

  // Range（拖动播放必需）：先判定、单次写头
  if (range && /^bytes=/.test(range)) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "no-cache",
    });
    if (isHead) {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end })
      .on("error", () => res.destroy())
      .pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  if (isHead) {
    res.end();
    return;
  }
  fs.createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

export interface ServerOptions {
  port: number;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const cfg = getConfig();
  outRoot = cfg.outRoot;
  const webIndex = path.join(ROOT, "web", "index.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
    const p = url.pathname;

    try {
      // 首页
      if ((req.method === "GET" || req.method === "HEAD") && (p === "/" || p === "/index.html")) {
        serveFile(req, res, webIndex);
        return;
      }

      // 配置与资源
      if (req.method === "GET" && p === "/api/config") {
        const poems = Object.values(loadBuiltins()).map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author,
          dynasty: b.dynasty,
          lines: b.lines,
        }));
        let voiceProfiles: Array<{ id: string; label: string; character?: string; actual?: string | null; shaped?: boolean }>;
        try {
          voiceProfiles = await resolveVoiceProfiles();
        } catch {
          voiceProfiles = Object.values(VOICE_PROFILES).map((v) => ({ id: v.id, label: v.label, character: v.character }));
        }
        json(res, 200, {
          ok: true,
          poems,
          voiceProfiles,
          bgmOptions: Object.entries(BGM_LABELS).map(([id, label]) => ({ id, label })),
          sizes: ["1080x1920", "720x1280", "540x960"],
          defaults: {
            image: cfg.image.provider,
            voice: "qingzheng",
            bgm: cfg.bgm === "none" ? "none" : cfg.bgm,
            narration: "both",
            size: cfg.size.label,
          },
          providers: {
            text: cfg.text.provider,
            image: cfg.image.provider,
            voice: cfg.voice.provider,
          },
        });
        return;
      }

      // 创建任务
      if (req.method === "POST" && p === "/api/jobs") {
        const body = await readBody(req);
        const data = JSON.parse(body || "{}") as Record<string, unknown>;
        const job = startJob({
          poemId: str(data.poemId),
          text: str(data.text),
          title: str(data.title),
          author: str(data.author),
          dynasty: str(data.dynasty),
          analysis: data.analysis as Analysis | undefined,
          options: (data.options ?? {}) as Record<string, unknown>,
          mode: data.mode === "analyze" || data.mode === "render" ? data.mode : "full",
        });
        json(res, 200, { ok: true, jobId: job.id });
        return;
      }

      // 作品库：磁盘上的历史任务
      if (req.method === "GET" && p === "/api/works") {
        const dirs = exists(outRoot) ? fs.readdirSync(outRoot).filter((d) => d.startsWith("job-")) : [];
        const works = dirs
          .map((d) => {
            const m = readManifest(path.join(outRoot, d));
            if (!m) return null;
            return {
              id: d.replace(/^job-/, ""),
              title: m.poem.title,
              dynasty: m.poem.dynasty,
              author: m.poem.author,
              totalMs: m.totalMs,
              createdAt: m.createdAt,
              image: m.providers.image,
            };
          })
          .filter((w): w is NonNullable<typeof w> => Boolean(w))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 12);
        json(res, 200, { ok: true, works });
        return;
      }

      // 任务状态 / 事件流（内存任务优先，其次磁盘历史任务）
      const mJob = /^\/api\/jobs\/([\w-]+)$/.exec(p);
      if (req.method === "GET" && mJob) {
        const job = jobs.get(mJob[1]!);
        if (job) {
          json(res, 200, jobView(job));
          return;
        }
        const dir = jobDirById(mJob[1]!);
        if (dir) {
          json(res, 200, diskJobView(mJob[1]!, dir));
          return;
        }
        json(res, 404, { ok: false, error: "未知任务" });
        return;
      }
      const mEvents = /^\/api\/jobs\/([\w-]+)\/events$/.exec(p);
      if (req.method === "GET" && mEvents) {
        const job = jobs.get(mEvents[1]!);
        if (!job) {
          json(res, 404, { ok: false, error: "未知任务" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // 补发历史事件
        for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (job.status === "done" || job.status === "error") {
          res.write(`data: ${JSON.stringify({ type: "eof" })}\n\n`);
          res.end();
          return;
        }
        let set = sseClients.get(job.id);
        if (!set) {
          set = new Set();
          sseClients.set(job.id, set);
        }
        set.add(res);
        req.on("close", () => set!.delete(res));
        return;
      }

      // 媒体文件
      const mMedia = /^\/media\/([\w-]+)\/(.+)$/.exec(p);
      if ((req.method === "GET" || req.method === "HEAD") && mMedia) {
        const dir = jobDirById(mMedia[1]!);
        const rel = decodeURIComponent(mMedia[2]!);
        if (!dir || rel.includes("..") || /[\\/]/.test(rel)) {
          json(res, 404, { ok: false, error: "not found" });
          return;
        }
        const file = path.join(dir, rel);
        if (!file.startsWith(path.resolve(dir))) {
          json(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        serveFile(req, res, file);
        return;
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { ok: false, error: msg });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  console.log(`\n  诗影工坊 · 工作台已启动`);
  console.log(`  打开浏览器访问：${"\u001b[36m"}http://127.0.0.1:${opts.port}${"\u001b[0m"}`);
  console.log(`  ${"\u001b[2m"}管道：文本=${cfg.text.provider} · 画面=${cfg.image.provider} · 声音=${cfg.voice.provider} · 配乐=${cfg.bgm}${"\u001b[0m"}\n`);
}

function jobView(job: JobRecord) {
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    stage: job.stage,
    stageLabel: job.stage ? STAGE_LABELS[job.stage] : null,
    stageProgress: job.stageProgress,
    overall: computeOverall(job),
    message: job.message,
    error: job.error,
    events: job.events.slice(-120),
    result: job.status === "done" && job.dir ? { dir: job.dir, jobId: job.id } : null,
    analysis: job.analysis ?? null,
    manifest: job.status === "done" && job.dir ? readManifest(job.dir) : null,
    options: job.options,
  };
}

/** 磁盘历史任务的视图（用于作品库回看） */
function diskJobView(id: string, dir: string) {
  const manifest = readManifest(dir);
  let analysis: Analysis | null = null;
  try {
    analysis = JSON.parse(fs.readFileSync(path.join(dir, "analysis.json"), "utf8")) as Analysis;
  } catch {
    analysis = null;
  }
  // 旧任务没有人物一致性字段时，按诗句自动推导（只用于视图，不回写磁盘）
  if (analysis) analysis = { ...analysis, persona: derivePersona(analysis) };
  return {
    ok: true,
    jobId: id,
    status: "done" as const,
    mode: "full" as const,
    stage: "compose" as const,
    stageLabel: STAGE_LABELS.compose,
    stageProgress: 1,
    overall: 1,
    message: "历史作品",
    error: undefined,
    events: [{ type: "done" as const, message: "历史作品" }],
    result: { dir, jobId: id },
    analysis,
    manifest,
    options: {},
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
