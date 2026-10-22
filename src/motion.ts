// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 动效工序（可选）
// provider: none（默认，静态图+程序运镜）
//           agnes（agnes-video-2.5-flash 图生视频：关键分镜以首帧驱动生成真实运动镜头）
// 关键分镜：默认首镜+最后一句镜；尾声镜固定复用相邻画面，不参与图生视频；
// SHIYING_MOTION_SCENES="1,3,6" 或 "all" 覆盖（尾声镜即使被列出也会跳过）
// Agnes 视频接口（国内站 api.agnes-ai.cn，OpenAI Videos 兼容）：
//   提交 POST /v1/videos（mode=keyframe，first_frame=图片公开 URL，size 固定 "720P"）
//   轮询 GET  /agnesapi?video_id=..&model_name=..（每 2s；完成取顶层 url）
// 免费档视频 1 RPM（2026-06 官方限额）：任务提交串行、间隔 61s+；
// 单镜失败只降级回静态图，不拖垮整片
// ════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { env, getConfig } from "./config.ts";
import type { Analysis, EventSink, Scene } from "./types.ts";
import { ensureDir, exists, sha1Short, sleep } from "./util.ts";
import { getArtStyle } from "./styles.ts";

export interface MotionStageInput {
  scenes: Scene[];
  analysis: Analysis;
  jobDir: string;
  cacheDir: string;
  emit: EventSink;
  /** 艺术风格 id，决定动效母题描述 */
  style?: string;
}

function motionKey(): string {
  // 设置层（工作台「通道配置」）优先，其次按通道命名的 Key，最后通用图像 Key
  return getConfig().motion.apiKey || env("SHIYING_IMAGE_API_KEY_AGNES") || env("SHIYING_IMAGE_API_KEY");
}

/**
 * 选出要换成视频镜头的关键分镜（1-based）。
 * 默认首镜 + 最后一句镜；尾声镜固定复用相邻画面（reuseImage），任何模式下都不参与图生视频。
 */
function selectKeyScenes(scenes: Scene[]): Scene[] {
  // reuseImage 的分镜（尾声镜）画面都是复用的，再为其生成视频既重复又浪费额度
  const eligible = scenes.filter((s) => !s.reuseImage);
  const spec = env("SHIYING_MOTION_SCENES", "").trim();
  if (spec.toLowerCase() === "all") return [...eligible];
  if (spec) {
    const wanted = new Set(
      spec
        .split(/[,，\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= scenes.length),
    );
    return eligible.filter((s) => wanted.has(s.index + 1));
  }
  const lastEligibleIndex = eligible.length > 0 ? eligible[eligible.length - 1]!.index : -1;
  return eligible.filter((s) => s.index === 0 || s.index === lastEligibleIndex);
}

function motionPrompt(analysis: Analysis, scene: Scene, style?: string): string {
  const artStyle = getArtStyle(style);
  return (
    `古诗《${analysis.title}》意境镜头：${scene.label}。` +
    `保持画面原有构图、风格与人物不变，仅让画面元素轻微自然运动（${artStyle.motionHint}），` +
    `画面稳定不闪烁，无文字、无水印。`
  );
}

interface AgnesVideoCreateResp {
  video_id?: string;
  id?: string;
  task_id?: string;
}

interface AgnesVideoQueryResp {
  status?: string;
  progress?: number;
  url?: string;
  error?: unknown;
}

/** 免费档视频 1 RPM：提交间隔 ≥61s（串行执行，无需并发控制） */
let lastSubmitAt = 0;

/** 提交任务：503 队列满 / 429 限流为瞬时态，退避后重试（最多 4 次） */
async function submitVideoTask(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  onWait?: (ms: number) => void,
): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const gap = Math.max(0, lastSubmitAt + 61_000 - Date.now());
    if (gap > 0) await sleep(gap);
    lastSubmitAt = Date.now();
    const res = await fetch(`${baseUrl}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      const j = JSON.parse(text) as AgnesVideoCreateResp;
      const videoId = j.video_id ?? j.id ?? j.task_id;
      if (!videoId) throw new Error(`agnes 视频任务响应缺少 video_id：${text.slice(0, 200)}`);
      return videoId;
    }
    if ((res.status === 503 || res.status === 429) && attempt < 4) {
      const waitMs = parseRetryAfter(res.headers.get("retry-after")) ?? 30_000 * attempt;
      onWait?.(waitMs);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`agnes 视频任务提交失败 ${res.status}：${text.slice(0, 200)}`);
  }
  throw new Error("agnes 视频任务提交失败：重试次数耗尽");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  return Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs * 1000) : undefined;
}

async function pollVideoTask(origin: string, apiKey: string, model: string, videoId: string): Promise<string> {
  const deadline = Date.now() + 12 * 60 * 1000;
  const url = `${origin}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
  for (;;) {
    await sleep(2000);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      if (Date.now() > deadline) throw new Error(`agnes 视频任务轮询失败：HTTP ${res.status}`);
      continue;
    }
    const j = (await res.json()) as AgnesVideoQueryResp;
    if (j.status === "completed") {
      if (!j.url) throw new Error("agnes 视频任务完成但缺少 url");
      return j.url;
    }
    if (j.status === "failed") throw new Error(`agnes 视频任务失败：${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    if (Date.now() > deadline) throw new Error("agnes 视频任务超时（12 分钟未完成）");
  }
}

export async function generateMotion(input: MotionStageInput): Promise<void> {
  const cfg = getConfig();
  const { scenes, analysis, jobDir, cacheDir, emit } = input;
  const style = input.style ?? cfg.style;
  const targets = selectKeyScenes(scenes).filter((s) => s.image);
  emit({ type: "stage", stage: "motion", status: "start", message: `动效工序：provider=agnes，风格=${style}，关键分镜 ${targets.length} 镜` });

  const apiKey = motionKey();
  const baseUrl = (cfg.motion.baseUrl || env("SHIYING_MOTION_BASE_URL", "https://api.agnes-ai.cn/v1")).replace(/\/+$/, "");
  const model = cfg.motion.model || env("SHIYING_MOTION_MODEL", "agnes-video-2.5-flash");
  const origin = new URL(baseUrl).origin;
  const s = cfg.size;
  const aspect = s.width < s.height ? "9:16" : s.width > s.height ? "16:9" : "1:1";

  let done = 0;
  for (const scene of targets) {
    const idx = scene.index + 1;
    const dest = path.join(jobDir, `scene-${idx}.mp4`);
    try {
      if (!apiKey) throw new Error("缺 API Key：请在工作台「通道配置」设置动效通道密钥（或 .env 里配 SHIYING_IMAGE_API_KEY_AGNES）");
      if (!scene.imageUrl) throw new Error("无图源 URL（图片为缓存命中且缺侧车记录），本镜保持静态图");
      const seconds = String(Math.min(12, Math.max(4, Math.ceil(scene.durMs / 1000))));
      const prompt = motionPrompt(analysis, scene, style);
      const key = sha1Short("motion-v2", model, style, prompt, seconds, aspect, scene.imageUrl);
      const cacheFile = path.join(cacheDir, `${key}.mp4`);
      if (exists(cacheFile)) {
        fs.copyFileSync(cacheFile, dest);
        scene.video = dest;
        emit({ type: "log", stage: "motion", message: `第 ${idx} 镜视频命中缓存` });
      } else {
        emit({ type: "log", stage: "motion", message: `第 ${idx} 镜：提交图生视频任务（${seconds}s · ${aspect}）` });
        const videoId = await submitVideoTask(
          baseUrl,
          apiKey,
          {
            model,
            prompt,
            mode: "keyframe",
            first_frame: scene.imageUrl,
            seconds,
            size: "720P",
            aspect_ratio: aspect,
            n: 1,
          },
          (ms) => emit({ type: "log", stage: "motion", message: `第 ${idx} 镜：视频队列繁忙，${Math.round(ms / 1000)}s 后重试提交` }),
        );
        emit({ type: "log", stage: "motion", message: `第 ${idx} 镜：任务 ${videoId} 已提交，轮询生成中` });
        const videoUrl = await pollVideoTask(origin, apiKey, model, videoId);
        const vid = await fetch(videoUrl, { signal: AbortSignal.timeout(180000) });
        if (!vid.ok) throw new Error(`视频下载失败：${vid.status}`);
        fs.writeFileSync(dest, Buffer.from(await vid.arrayBuffer()));
        try {
          ensureDir(cacheDir);
          fs.copyFileSync(dest, cacheFile);
        } catch {
          /* 缓存失败不影响主流程 */
        }
        scene.video = dest;
        emit({ type: "log", stage: "motion", message: `第 ${idx} 镜视频就绪` });
      }
    } catch (err) {
      // 单镜失败降级回静态图，不拖垮整片
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "log", stage: "motion", message: `第 ${idx} 镜图生视频失败，回退静态图+运镜（${msg.slice(0, 120)}）` });
    }
    done++;
    emit({ type: "stage", stage: "motion", status: "progress", progress: done / targets.length, message: `动效工序 ${done}/${targets.length} 镜` });
  }

  const made = targets.filter((t) => t.video).length;
  emit({ type: "stage", stage: "motion", status: "done", progress: 1, message: `动效工序完成：${made}/${targets.length} 镜已换为视频镜头` });
}
