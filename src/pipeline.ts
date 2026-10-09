// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 流水线编排
// 文本 → 分镜 → 画面 → 声音 → 合成，逐步回传事件；
// 产物全部落在 output/job-<jobId>/ 下，清单写入 manifest.json
// ════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { bgmCached } from "./audio.ts";
import { ensureJobDir, composeVideo } from "./compose.ts";
import { getConfig } from "./config.ts";
import { generateImages } from "./image.ts";
import { derivePersona } from "./persona.ts";
import { buildScenes } from "./scenes.ts";
import { buildSrt, sceneStarts, totalDurationMs } from "./srt.ts";
import { analyzeText, loadBuiltins } from "./text.ts";
import type { Analysis, EventSink, JobEvent, Manifest, RunOptions, Scene } from "./types.ts";
import { ensureDir, exists, fmtMs, jobStamp, writeJson } from "./util.ts";
import { assembleNarration, generateVoice } from "./voice.ts";

export interface PipelineResult {
  jobId: string;
  dir: string;
  manifest: Manifest | null;
  analysis: Analysis;
  scenes: Scene[];
}

export interface PipelineControls {
  /** 只跑到分镜为止（审核用）；缺省跑完全链路 */
  stopAfter?: "scenes";
}

export async function runPipeline(opts: RunOptions, sink: EventSink, controls: PipelineControls = {}): Promise<PipelineResult> {
  const cfg = getConfig();
  const jobId = jobStamp();
  const outRoot = opts.outRoot ?? cfg.outRoot;
  const dir = ensureJobDir(outRoot, jobId);
  const cacheDir = ensureDir(path.join(outRoot, "cache"));
  const emit: EventSink = (ev: JobEvent) => sink(ev);
  const t0 = Date.now();

  // ── ① 文本工序 ────────────────────────────────────────────────
  emit({ type: "stage", stage: "text", status: "start", message: "文本工序：解析诗词与撰写文案" });
  let analysis: Analysis;
  if (opts.analysis) {
    analysis = opts.analysis;
    if (analysis.origin.text !== "edited") {
      analysis = { ...analysis, origin: { ...analysis.origin, text: "edited", provider: "manual" } };
    }
    emit({ type: "log", stage: "text", message: "使用用户编辑后的解析（重新合成）" });
  } else {
    analysis = await analyzeText({
      poemId: opts.poemId,
      text: opts.text,
      title: opts.title,
      author: opts.author,
      dynasty: opts.dynasty,
    });
  }
  // 人物一致性：根据情景判断诗中人物是否为同一人（如作者本人），固化全片固定形象
  analysis.persona = derivePersona(analysis);
  writeJson(path.join(dir, "analysis.json"), analysis);
  emit({
    type: "stage",
    stage: "text",
    status: "done",
    progress: 1,
    message: `文本工序完成：《${analysis.title}》· ${analysis.lines.length} 句（来源：${analysis.origin.text}/${analysis.origin.provider}）`,
  });
  for (const tip of analysis.origin.tips) emit({ type: "log", stage: "text", message: `提示：${tip}` });

  // ── ② 分镜工序 ────────────────────────────────────────────────
  emit({ type: "stage", stage: "scenes", status: "start", message: "分镜工序：排布镜头" });
  const builtin = loadBuiltins()[analysis.id] ?? null;
  const scenes = buildScenes(analysis, builtin, { narration: opts.narration ?? "both" });
  emit({ type: "stage", stage: "scenes", status: "done", progress: 1, message: `分镜工序完成：${scenes.length} 镜` });

  // 两段式流程：审核模式在此停住，等用户确认后再跑生图/配音/合成
  if (controls.stopAfter === "scenes") {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    emit({
      type: "done",
      message: `解析与文案已就绪：《${analysis.title}》 · 等待确认（${elapsed}s）`,
      data: { jobId, dir, stage: "analyze" },
    });
    return { jobId, dir, manifest: null, analysis, scenes };
  }

  // ── ③ 画面工序 ────────────────────────────────────────────────
  await generateImages({
    scenes,
    analysis,
    jobDir: dir,
    cacheDir,
    emit,
    reuseFrom: opts.freshImages ? undefined : opts.reuseImagesFrom,
    freshImages: opts.freshImages === true,
  });

  // ── ④ 声音工序 ────────────────────────────────────────────────
  const profileId = opts.voiceProfile ?? "qingzheng";
  const voiceOn = await generateVoice({ scenes, jobDir: dir, cacheDir, emit, profileId });
  const narrationWav = voiceOn ? await assembleNarration(scenes, dir) : null;
  if (narrationWav) emit({ type: "log", stage: "voice", message: `旁白轨就绪：${path.basename(narrationWav)}` });

  // ── 配乐（合成工序的铺垫） ─────────────────────────────────────
  let bgmWav: string | null = null;
  let bgmKind = opts.bgm && opts.bgm !== "" ? opts.bgm : cfg.bgm === "none" ? "none" : "guqin";
  if (bgmKind === "synth") bgmKind = "guqin"; // 兼容旧配置：synth 是合成方式，不是曲目
  if (bgmKind && bgmKind !== "none") {
    const total = totalDurationMs(scenes);
    bgmWav = await bgmCached(bgmKind, total + 1500, cacheDir);
    emit({ type: "log", stage: "compose", message: `配乐就绪：${bgmKind}` });
  }

  // ── ⑤ 合成工序 ────────────────────────────────────────────────
  const { video, cover, assFile } = await composeVideo({ scenes, jobDir: dir, narrationWav, bgmWav, emit });

  // 字幕文件（真实可用的 .srt，与 V1 原型导出同体系）
  const srtFile = path.join(dir, "subtitles.srt");
  fs.writeFileSync(srtFile, buildSrt(scenes), "utf8");

  // ── 清单 ──────────────────────────────────────────────────────
  const starts = sceneStarts(scenes);
  const total = totalDurationMs(scenes);
  const manifest: Manifest = {
    jobId,
    createdAt: new Date().toISOString(),
    providers: {
      text: `${analysis.origin.text}:${analysis.origin.provider}`,
      image: cfg.image.provider,
      voice: voiceOn ? cfg.voice.provider : "none",
      bgm: bgmWav ? bgmKind : "none",
    },
    size: cfg.size.label,
    fps: 30,
    poem: { title: analysis.title, author: analysis.author, dynasty: analysis.dynasty, lines: analysis.lines },
    totalMs: total,
    scenes: scenes.map((s, i) => ({
      index: s.index,
      kind: s.kind,
      label: s.label,
      subtitle: s.subtitle,
      caption: s.caption,
      startMs: starts[i]!,
      durMs: s.durMs,
      image: s.image ? path.basename(s.image) : null,
      audio: s.audio ? path.basename(s.audio) : null,
    })),
    files: {
      video: path.basename(video),
      srt: path.basename(srtFile),
      ass: path.basename(assFile),
      cover: path.basename(cover),
      narration: narrationWav ? path.basename(narrationWav) : null,
      bgm: bgmWav ? path.basename(bgmWav) : null,
      analysis: "analysis.json",
    },
    tips: analysis.origin.tips,
  };
  writeJson(path.join(dir, "manifest.json"), manifest);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  emit({
    type: "done",
    message: `全片完成：${fmtMs(total)} · 用时 ${elapsed}s · ${path.join(dir, video ? `${path.basename(video)}` : "")}`,
    data: { jobId, dir, manifest },
  });
  return { jobId, dir, manifest, analysis, scenes };
}

/** 供服务端复用：读取某任务目录的最新清单 */
export function readManifest(jobDir: string): Manifest | null {
  const file = path.join(jobDir, "manifest.json");
  if (!exists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}
