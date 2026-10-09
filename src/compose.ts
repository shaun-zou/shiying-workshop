// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 合成工序（FFmpeg）
// 单遍完成：逐镜运镜（zoompan 推拉）→ 拼接 → 烧制样式化字幕 →
//           旁白 + 配乐混音 → H.264 MP4（faststart）
// ════════════════════════════════════════════════════════════════
import path from "node:path";
import { getConfig } from "./config.ts";
import { buildAss } from "./srt.ts";
import type { EventSink, Scene } from "./types.ts";
import { fmtMs, findFfmpeg, run, exists, ensureDir } from "./util.ts";
import fs from "node:fs";

export interface ComposeStageInput {
  scenes: Scene[];
  jobDir: string;
  narrationWav: string | null;
  bgmWav: string | null;
  emit: EventSink;
}

export interface ComposeResult {
  video: string;
  cover: string;
  assFile: string;
}

/** 每镜运镜表达式（推近 / 拉远 / 推近+横移 三种，轮流使用） */
function zoompanExpr(mode: number, frames: number): { z: string; x: string; y: string } {
  const f = Math.max(1, frames - 1);
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  if (mode === 1) {
    return { z: `1.06-0.06*on/${f}`, x: centerX, y: centerY };
  }
  if (mode === 2) {
    return { z: `1+0.06*on/${f}`, x: `iw/2-(iw/zoom/2)+36*on/${f}`, y: centerY };
  }
  return { z: `1+0.06*on/${f}`, x: centerX, y: centerY };
}

export async function composeVideo(input: ComposeStageInput): Promise<ComposeResult> {
  const cfg = getConfig();
  const { scenes, jobDir, narrationWav, bgmWav, emit } = input;
  const { width, height } = cfg.size;
  const fps = 30;
  const totalMs = scenes.reduce((sum, s) => sum + s.durMs, 0);

  const ff = findFfmpeg();
  if (!ff) throw new Error("未找到 FFmpeg。安装：winget install Gyan.FFmpeg（或设置 SHIYING_FFMPEG=路径）");

  emit({ type: "stage", stage: "compose", status: "start", message: `合成工序：${scenes.length} 镜 · 总时长 ${fmtMs(totalMs)}` });

  // ① 字幕（ASS 烧制 + SRT 另存）
  const assFile = path.join(jobDir, "subtitles.ass");
  fs.writeFileSync(assFile, buildAss(scenes, { width, height }), "utf8");

  // ② 输入与滤镜链
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
  scenes.forEach((s) => {
    if (!s.image) throw new Error(`第 ${s.index + 1} 镜缺少图片`);
    args.push("-loop", "1", "-framerate", String(fps), "-t", (s.durMs / 1000).toFixed(3), "-i", s.image);
  });
  let narrationIdx = -1;
  let bgmIdx = -1;
  if (narrationWav && exists(narrationWav)) {
    narrationIdx = scenes.length;
    args.push("-i", narrationWav);
  }
  if (bgmWav && exists(bgmWav)) {
    bgmIdx = narrationIdx >= 0 ? scenes.length + 1 : scenes.length;
    args.push("-stream_loop", "-1", "-i", bgmWav);
  }

  const zoomHeadroom = 1.08;
  const SW = Math.round((width * zoomHeadroom) / 2) * 2;
  const SH = Math.round((height * zoomHeadroom) / 2) * 2;

  const filters: string[] = [];
  scenes.forEach((s, i) => {
    const frames = Math.max(1, Math.round((s.durMs / 1000) * fps));
    const { z, x, y } = zoompanExpr(i % 3, frames);
    filters.push(
      `[${i}:v]scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},` +
        `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps},` +
        `trim=duration=${(s.durMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  const concatIn = scenes.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concatIn}concat=n=${scenes.length}:v=1:a=0[vcat]`);
  filters.push(`[vcat]subtitles=filename=subtitles.ass[vout]`);

  // 音频链
  const endSec = totalMs / 1000;
  if (narrationIdx >= 0 && bgmIdx >= 0) {
    filters.push(`[${narrationIdx}:a]anull[narr]`);
    filters.push(
      `[${bgmIdx}:a]volume=0.20,afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, endSec - 3.2).toFixed(2)}:d=3.2[bg]`,
    );
    filters.push(`[narr][bg]amix=inputs=2:duration=first:normalize=0[aout]`);
  } else if (narrationIdx >= 0) {
    filters.push(`[${narrationIdx}:a]anull[aout]`);
  } else if (bgmIdx >= 0) {
    filters.push(
      `[${bgmIdx}:a]volume=0.4,afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, endSec - 3.2).toFixed(2)}:d=3.2[aout]`,
    );
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    filters.push(`[${scenes.length}:a]anull[aout]`);
  }

  const videoFile = path.join(jobDir, "video.mp4");
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "19",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-movflags",
    "+faststart",
    "-t",
    endSec.toFixed(3),
    videoFile,
  );

  // ③ 执行（解析 -progress 输出回传进度；注意 ffmpeg 的 out_time_ms/out_time_us 单位都是微秒）
  let lastEmitted = -1;
  await run(ff.ffmpeg, args, {
    cwd: jobDir,
    timeoutMs: 30 * 60 * 1000,
    onStdout: (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const m = /^out_time_(?:ms|us)=(\d+)/.exec(line.trim());
        if (!m) continue;
        const ms = Number(m[1]) / 1000; // 微秒 → 毫秒
        const k = Math.min(1, ms / totalMs);
        if ((k < 1 && k - lastEmitted >= 0.02) || (k >= 1 && lastEmitted < 1)) {
          lastEmitted = k;
          emit({ type: "stage", stage: "compose", status: "progress", progress: k, message: `合成工序 ${Math.round(k * 100)}%` });
        }
      }
    },
  });

  if (!exists(videoFile)) throw new Error("合成失败：video.mp4 未生成");

  // ④ 封面帧
  const cover = path.join(jobDir, "cover.jpg");
  await run(
    ff.ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.8", "-i", videoFile, "-frames:v", "1", "-q:v", "3", cover],
    { cwd: jobDir, timeoutMs: 60000 },
  );

  emit({ type: "stage", stage: "compose", status: "done", progress: 1, message: `合成完成：${path.basename(videoFile)}` });
  return { video: videoFile, cover, assFile };
}

export function ensureJobDir(root: string, jobId: string): string {
  return ensureDir(path.join(root, `job-${jobId}`));
}
