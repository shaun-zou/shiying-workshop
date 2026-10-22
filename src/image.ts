// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 画面工序
// provider:
//   svg      内置水墨分镜引擎（无头浏览器截图，离线，0 成本）
//   seedream AutoGLM 本地通道（免 Key，走本机 token 服务）
//   siliconflow 硅基流动（Kwai-Kolors/Kolors；OpenAI 兼容；9:16 竖版；实测已通）
//   agnes    Agnes AI（agnes-image-2.5-flash；免费档；size 档位 + ratio；9:16 → 2K）
//            免费档实际 RPM：1K=10 / 2K=5（2026-06 官方限额）；客户端按档位自动串行节流，
//            可用 SHIYING_AGNES_RPM 覆盖（企业/Token Plan 用户）；429 时按 Retry-After 退避
//   cogview  智谱开放平台（按公开文档实现，需 API Key，未实测）
//   openai   OpenAI 兼容图像接口（需 API Key，未实测）
// 统一：图片缓存（同 prompt 命中缓存不重复出图）+ 顺序写回 scene.image
// ════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env, getConfig } from "./config.ts";
import { sceneImagePrompt } from "./prompts.ts";
import { SCENE_BUILDERS, scenePageHtml } from "./svg.ts";
import type { Analysis, EventSink, Scene } from "./types.ts";
import { ensureDir, exists, findBrowser, pool, run, sha1Short, sleep } from "./util.ts";

export interface ImageStageInput {
  scenes: Scene[];
  analysis: Analysis;
  jobDir: string;
  cacheDir: string;
  emit: EventSink;
  /** 复用某次任务的图片（编辑重合成：跳过重新出图） */
  reuseFrom?: string;
  /** 忽略缓存与复用，重新生成全部分镜图 */
  freshImages?: boolean;
  /** 艺术风格 id（ink / gongbi / ...），决定画面风格锚点 */
  style?: string;
}

function cacheKeyFor(provider: string, prompt: string, sizeLabel: string, style: string): string {
  return sha1Short("img-v2", provider, style, prompt, sizeLabel);
}

/** 图片缓存：命中则复制进任务目录，未命中返回 null */
function tryCache(cacheDir: string, key: string, ext: string, dest: string): string | null {
  const cacheFile = path.join(cacheDir, `${key}${ext}`);
  if (exists(cacheFile)) {
    fs.copyFileSync(cacheFile, dest);
    return dest;
  }
  return null;
}

function storeCache(cacheDir: string, key: string, ext: string, src: string): void {
  ensureDir(cacheDir);
  try {
    fs.copyFileSync(src, path.join(cacheDir, `${key}${ext}`));
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

// ── provider: svg（无头浏览器截图） ─────────────────────────────
// 无头浏览器对档案目录有独占锁：全局串行化 + 每镜独立档案，避免并发冲突
let svgLock: Promise<void> = Promise.resolve();
async function withSvgLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = svgLock;
  let release!: () => void;
  svgLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function renderSvgScene(scene: Scene, poem: { title: string; author: string; dynasty: string }, width: number, height: number, workDir: string, idx: number): Promise<string> {
  const browser = findBrowser();
  if (!browser) {
    throw new Error("未找到 Edge/Chrome 浏览器（svg 画面需要无头浏览器截图）。可设置 SHIYING_BROWSER=浏览器路径，或改用 --image seedream");
  }
  const builder = SCENE_BUILDERS[scene.kind] ?? SCENE_BUILDERS["jy-window"]!;
  const svg = builder(poem);
  const htmlPath = path.join(workDir, `scene-${idx}.html`);
  const pngPath = path.join(workDir, `scene-${idx}.png`);
  fs.writeFileSync(htmlPath, scenePageHtml(svg, width, height), "utf8");
  const profileDir = ensureDir(path.join(workDir, "..", ".browser-profile", `p${idx}`));
  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    `--user-data-dir=${profileDir}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=2500",
    `--screenshot=${pngPath}`,
    fileUrl,
  ];
  await withSvgLock(async () => {
    // 注意：Edge 的启动器进程可能“转后台先退出”，截图由后台进程异步落盘。
    // 因此不能相信进程退出码，要轮询等 PNG 文件稳定生成。
    const child = spawn(browser.exe, args, { windowsHide: true, stdio: "ignore" });
    let exitCode: number | null = null;
    child.on("exit", (c) => (exitCode = c ?? 0));
    child.on("error", () => {
      /* 交由轮询逻辑统一报错 */
    });
    const deadline = Date.now() + 90000;
    let lastSize = -1;
    let stableTimes = 0;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(420);
      if (exists(pngPath)) {
        const size = fs.statSync(pngPath).size;
        if (size > 1024 && size === lastSize) {
          stableTimes++;
          if (stableTimes >= 2) {
            ok = true;
            break;
          }
        } else {
          stableTimes = 0;
        }
        lastSize = size;
      }
    }
    // 截图完成（或超时）后，清理仍存活的启动进程
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, 300).unref?.();
    if (!ok) {
      throw new Error(`截图超时（exit=${exitCode ?? "?"}）：${pngPath} 未生成或未写完`);
    }
  });
  return pngPath;
}

// ── provider: seedream（AutoGLM 本地通道） ──────────────────────
const SEEDREAM_URL = "https://autoglm-api.zhipuai.cn/agentdr/v1/assistant/skills/generate-image-seedream";
const AUTH_APPID = "100003";
const AUTH_SECRET = "38d2391985e2369a5fb8227d8e6cd5e5";

async function seedreamGenerate(query: string, destFile: string): Promise<void> {
  // 1) 本地 token 服务
  const tokenService = getConfig().seedreamTokenService;
  const tokenRes = await fetch(tokenService, { signal: AbortSignal.timeout(8000) });
  if (!tokenRes.ok) throw new Error(`Seedream token 服务不可用（${tokenService}）：${tokenRes.status}`);
  let token = (await tokenRes.text()).trim();
  if (!token.startsWith("Bearer ")) token = "Bearer " + token;

  // 2) 签名头
  const ts = Math.floor(Date.now() / 1000).toString();
  const sign = createHash("md5").update(`${AUTH_APPID}&${ts}&${AUTH_SECRET}`).digest("hex");

  // 3) 调用
  const res = await fetch(SEEDREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "X-Auth-Appid": AUTH_APPID,
      "X-Auth-TimeStamp": ts,
      "X-Auth-Sign": sign,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(240000),
  });
  const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { image_url?: string } };
  const imageUrl = data?.data?.image_url;
  if (!imageUrl) throw new Error(`Seedream 返回异常：${JSON.stringify(data).slice(0, 300)}`);

  // 4) 下载
  const img = await fetch(imageUrl, { signal: AbortSignal.timeout(120000) });
  if (!img.ok) throw new Error(`Seedream 图片下载失败：${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  fs.writeFileSync(destFile, buf);
}

/** 裁掉右下角水印区（bottom 6% + right 4%） */
async function cropWatermark(src: string, dest: string): Promise<void> {
  const { findFfmpeg } = await import("./util.ts");
  const info = findFfmpeg();
  if (!info) {
    fs.copyFileSync(src, dest);
    return;
  }
  await run(info.ffmpeg, ["-y", "-i", src, "-vf", "crop=floor(iw*0.96):floor(ih*0.94):0:0", "-q:v", "2", dest], { timeoutMs: 60000 });
}

// ── provider: siliconflow / cogview / openai（OpenAI 兼容图像接口） ─────────

/** 图像接口 HTTP 错误：携带状态码与 Retry-After（毫秒），供重试层决策 */
class ImageHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ImageHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 解析 Retry-After：数字秒 或 HTTP-date；无法解析返回 undefined */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// ── Agnes 客户端节流 ────────────────────────────────────────────
// 免费/默认档实际 RPM（Agnes 国内站 tokenplan 文档，2026-06 生效）：
// 1K=10、2K=5、3K/4K=1。并发池多 worker 也会在此被串行化并按最小间隔放行。
const AGNES_FREE_RPM: Record<string, number> = { "1K": 10, "2K": 5, "3K": 1, "4K": 1 };
let agnesChain: Promise<unknown> = Promise.resolve();
let agnesLastStart = 0;

async function withAgnesPacer<T>(tier: string, fn: () => Promise<T>, onWait?: (ms: number) => void): Promise<T> {
  // 串行队列：后一个请求必须等前一个请求离开临界区
  const prev = agnesChain;
  let release!: () => void;
  agnesChain = prev.then(() => new Promise<void>((r) => (release = r)));
  await prev;
  try {
    const override = Number(env("SHIYING_AGNES_RPM", ""));
    const rpm = override > 0 ? override : (AGNES_FREE_RPM[tier] ?? 5);
    const interval = Math.ceil(60000 / rpm) + 300; // +300ms 安全余量
    const waitMs = Math.max(0, agnesLastStart + interval - Date.now());
    if (waitMs > 0) {
      onWait?.(waitMs);
      await sleep(waitMs);
    }
    agnesLastStart = Date.now();
    return await fn();
  } finally {
    release();
  }
}

/** 出图；返回图源远端 URL（仅当接口返回 url 时；供 agnes 图生视频作首帧） */
async function callOpenAiStyleImage(prompt: string, dest: string, onWait?: (ms: number) => void): Promise<string | undefined> {
  const cfg = getConfig().image;
  if (!cfg.apiKey) throw new Error(`${cfg.provider} 需要 API Key：请设置 SHIYING_IMAGE_API_KEY`);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/images/generations";
  const body: Record<string, unknown> = { model: cfg.model, prompt };
  let agnesTier = "";
  if (cfg.provider === "cogview" || cfg.provider === "zhipu") body.size = "768x1344";
  else if (cfg.provider === "siliconflow") body.image_size = "720x1280"; // 硅基流动：9:16 竖版（Kolors，实测已通）
  else if (cfg.provider === "agnes") {
    // Agnes（agnes-image-2.5-flash）：档位式 size（1K/2K/3K/4K）+ ratio 宽高比；竖版 9:16，按目标宽度选档位
    const s = getConfig().size;
    agnesTier = s.width >= 1080 ? "2K" : "1K";
    body.size = agnesTier;
    body.ratio = s.width < s.height ? "9:16" : s.width > s.height ? "16:9" : "1:1";
  } else body.size = "1024x1536";
  const doRequest = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    });
  // Agnes 免费档 RPM 很低：请求发出前经节流器串行放行（只节流生成请求，不节流图片下载）
  const res = agnesTier
    ? await withAgnesPacer(agnesTier, doRequest, (ms) =>
        onWait?.(ms),
      )
    : await doRequest();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImageHttpError(
      `${cfg.provider} 图像接口 ${res.status}：${text.slice(0, 300)}`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  const data = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
    images?: Array<{ url?: string }>; // 硅基流动返回：{"images":[{"url":...}]}
  };
  const item = data.data?.[0] ?? (data.images?.[0]?.url ? { url: data.images[0].url } : undefined);
  if (!item) throw new Error(`${cfg.provider} 未返回图片数据`);
  if (item.b64_json) {
    fs.writeFileSync(dest, Buffer.from(item.b64_json, "base64"));
    return undefined;
  }
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!img.ok) throw new Error(`图片下载失败：${img.status}`);
    fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
    return item.url;
  }
  throw new Error(`${cfg.provider} 返回中没有 url/b64_json`);
}

// ── 主入口 ──────────────────────────────────────────────────────
export async function generateImages(input: ImageStageInput): Promise<void> {
  const cfg = getConfig();
  const provider = cfg.image.provider;
  const { scenes, analysis, jobDir, cacheDir, emit } = input;
  const size = cfg.size;
  const style = input.style ?? cfg.style;
  const total = scenes.length;
  // reuseImage 的分镜（尾声镜）不发起出图：所有正常镜生成完后统一复制相邻上一张图
  const genScenes = scenes.filter((s) => !s.reuseImage);
  const reusedCount = total - genScenes.length;
  let done = 0;

  emit({
    type: "stage",
    stage: "images",
    status: "start",
    message:
      `画面工序：provider=${provider}，风格=${style}，共 ${total} 镜` +
      (reusedCount > 0 ? `（尾声复用相邻画面，实际出图 ${genScenes.length} 镜）` : ""),
  });

  await pool(genScenes, Math.max(1, cfg.concurrency), async (scene) => {
    const idx = scene.index + 1;

    // 复用上一条任务的图片（编辑重合成场景；全量重出模式下跳过复用）
    if (input.reuseFrom && !input.freshImages) {
      for (const ext of [".png", ".jpg"]) {
        const src = path.join(input.reuseFrom, `scene-${idx}${ext}`);
        if (exists(src)) {
          const dest = path.join(jobDir, `scene-${idx}${ext}`);
          fs.copyFileSync(src, dest);
          scene.image = dest;
          done++;
          emit({ type: "stage", stage: "images", status: "progress", progress: done / total, message: `画面工序 ${done}/${total} 镜（复用）` });
          return;
        }
      }
    }

    const prompt = sceneImagePrompt(analysis, scene, style);
    const key = cacheKeyFor(provider, prompt, size.label, style);
    const ext = provider === "svg" || provider === "siliconflow" || provider === "agnes" ? ".png" : ".jpg";
    const dest = path.join(jobDir, `scene-${idx}${ext}`);
    // 图源 URL 侧车：agnes 出图时记录，供动效工序图生视频作首帧
    const urlSidecar = path.join(cacheDir, `${key}.url.txt`);
    if (exists(urlSidecar)) {
      try {
        scene.imageUrl = fs.readFileSync(urlSidecar, "utf8").trim() || undefined;
      } catch {
        /* 侧车读取失败不影响主流程 */
      }
    }

    let file: string | null = input.freshImages ? null : tryCache(cacheDir, key, ext, dest);
    if (file) {
      emit({ type: "log", stage: "images", message: `第 ${idx} 镜命中缓存` });
    } else {
      if (input.freshImages) {
        emit({ type: "log", stage: "images", message: `第 ${idx} 镜：忽略缓存重新生成` });
      }
      // 通道可能偶发临时故障（2026-10-05 实际案例）：自动重试、带退避，让短暂抖动自愈
      const maxAttempts = 4;
      const retryWaits = [3000, 8000, 15000];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (provider === "svg") {
            file = await renderSvgScene(scene, analysis, size.width, size.height, jobDir, idx);
          } else if (provider === "seedream") {
            file = dest;
            await seedreamGenerate(prompt, dest);
            if (!cfg.keepWatermark) {
              const raw = dest.replace(/\.jpg$/, ".raw.jpg");
              fs.renameSync(dest, raw);
              await cropWatermark(raw, dest);
            }
          } else {
            file = dest;
            const remote = await callOpenAiStyleImage(prompt, dest, (ms) => {
              emit({ type: "log", stage: "images", message: `第 ${idx} 镜：agnes 限流保护，等待 ${(ms / 1000).toFixed(1)}s 后发请求` });
            });
            if (remote) {
              scene.imageUrl = remote;
              try {
                ensureDir(cacheDir);
                fs.writeFileSync(urlSidecar, remote, "utf8");
              } catch {
                /* 侧车写入失败不影响主流程 */
              }
            }
          }
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt === maxAttempts) {
            throw new Error(`第 ${idx} 镜生成失败（连续 ${maxAttempts} 次尝试未成功）：${msg}`);
          }
          // 429 限流：优先 Retry-After，否则等满一个分钟窗口；普通错误沿用短退避
          const rateLimited = (err instanceof ImageHttpError && err.status === 429) || /\b429\b/.test(msg);
          const waitMs = rateLimited
            ? Math.min(120000, err instanceof ImageHttpError && err.retryAfterMs ? err.retryAfterMs : 62000)
            : (retryWaits[attempt - 1] ?? 15000);
          emit({
            type: "log",
            stage: "images",
            message: `第 ${idx} 镜生成失败，${attempt}/${maxAttempts} 次尝试后${rateLimited ? `触发限流，等待 ${Math.round(waitMs / 1000)}s` : "重试"}（${msg.slice(0, 120)}）`,
          });
          await sleep(waitMs);
          file = null;
        }
      }
    }
    if (!file) throw new Error(`第 ${idx} 镜图片生成失败`);
    scene.image = file;
    if (!file.includes(".raw.")) storeCache(cacheDir, key, ext, file);
    done++;
    emit({
      type: "stage",
      stage: "images",
      status: "progress",
      progress: done / total,
      message: `画面工序 ${done}/${total} 镜`,
    });
  });

  // ── 复用镜后处理（尾声镜）：直接复制相邻上一张分镜的图，不发起任何出图请求 ──
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    if (!scene.reuseImage) continue;
    const idx = scene.index + 1;
    const prev = scenes[i - 1];
    if (!prev?.image) throw new Error(`第 ${idx} 镜（${scene.label}）需复用上一张分镜的画面，但上一张分镜图片缺失`);
    const dest = path.join(jobDir, `scene-${idx}${path.extname(prev.image)}`);
    fs.copyFileSync(prev.image, dest);
    scene.image = dest;
    // 继承远端图源 URL，保持数据一致（尾声不进动效工序，不会真正用于图生视频）
    scene.imageUrl = prev.imageUrl;
    done++;
    emit({ type: "log", stage: "images", message: `第 ${idx} 镜（${scene.label}）复用第 ${i} 镜画面，不重新出图` });
    emit({
      type: "stage",
      stage: "images",
      status: "progress",
      progress: done / total,
      message: `画面工序 ${done}/${total} 镜`,
    });
  }

  emit({
    type: "stage",
    stage: "images",
    status: "done",
    progress: 1,
    message:
      `画面工序完成：${genScenes.length} 张新图` +
      (reusedCount > 0 ? `，${reusedCount} 镜复用相邻画面（尾声）` : ""),
  });
}

export function imageProviderName(): string {
  return getConfig().image.provider;
}
