// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 画面工序
// provider:
//   svg      内置水墨分镜引擎（无头浏览器截图，离线，0 成本）
//   seedream AutoGLM 本地通道（免 Key，走本机 token 服务）
//   siliconflow 硅基流动（Kwai-Kolors/Kolors；OpenAI 兼容；9:16 竖版；实测已通）
//   cogview  智谱开放平台（按公开文档实现，需 API Key，未实测）
//   openai   OpenAI 兼容图像接口（需 API Key，未实测）
// 统一：图片缓存（同 prompt 命中缓存不重复出图）+ 顺序写回 scene.image
// ════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.ts";
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
}

function cacheKeyFor(provider: string, prompt: string, sizeLabel: string): string {
  return sha1Short("img-v1", provider, prompt, sizeLabel);
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
async function callOpenAiStyleImage(prompt: string, dest: string): Promise<void> {
  const cfg = getConfig().image;
  if (!cfg.apiKey) throw new Error(`${cfg.provider} 需要 API Key：请设置 SHIYING_IMAGE_API_KEY`);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/images/generations";
  const body: Record<string, unknown> = { model: cfg.model, prompt };
  if (cfg.provider === "cogview" || cfg.provider === "zhipu") body.size = "768x1344";
  else if (cfg.provider === "siliconflow") body.image_size = "720x1280"; // 硅基流动：9:16 竖版（Kolors，实测已通）
  else body.size = "1024x1536";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${cfg.provider} 图像接口 ${res.status}：${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
    images?: Array<{ url?: string }>; // 硅基流动返回：{"images":[{"url":...}]}
  };
  const item = data.data?.[0] ?? (data.images?.[0]?.url ? { url: data.images[0].url } : undefined);
  if (!item) throw new Error(`${cfg.provider} 未返回图片数据`);
  if (item.b64_json) {
    fs.writeFileSync(dest, Buffer.from(item.b64_json, "base64"));
    return;
  }
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!img.ok) throw new Error(`图片下载失败：${img.status}`);
    fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
    return;
  }
  throw new Error(`${cfg.provider} 返回中没有 url/b64_json`);
}

// ── 主入口 ──────────────────────────────────────────────────────
export async function generateImages(input: ImageStageInput): Promise<void> {
  const cfg = getConfig();
  const provider = cfg.image.provider;
  const { scenes, analysis, jobDir, cacheDir, emit } = input;
  const size = cfg.size;
  const total = scenes.length;
  let done = 0;

  emit({ type: "stage", stage: "images", status: "start", message: `画面工序：provider=${provider}，共 ${total} 镜` });

  await pool(scenes, Math.max(1, cfg.concurrency), async (scene) => {
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

    const prompt = sceneImagePrompt(analysis, scene);
    const key = cacheKeyFor(provider, prompt, size.label);
    const ext = provider === "svg" || provider === "siliconflow" ? ".png" : ".jpg";
    const dest = path.join(jobDir, `scene-${idx}${ext}`);

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
            await callOpenAiStyleImage(prompt, dest);
          }
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt === maxAttempts) {
            throw new Error(`第 ${idx} 镜生成失败（连续 ${maxAttempts} 次尝试未成功）：${msg}`);
          }
          emit({ type: "log", stage: "images", message: `第 ${idx} 镜生成失败，${attempt}/${maxAttempts} 次尝试后重试（${msg.slice(0, 120)}）` });
          await new Promise((r) => setTimeout(r, retryWaits[attempt - 1] ?? 15000));
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

  emit({ type: "stage", stage: "images", status: "done", progress: 1, message: `画面工序完成：${total} 镜` });
}

export function imageProviderName(): string {
  return getConfig().image.provider;
}
