// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 声音工序
// provider:
//   sapi   Windows 本机语音（离线；当前机器有 Microsoft Huihui 中文音色）
//   openai OpenAI 兼容语音合成接口（需 API Key，未实测）
//   none   不做配音（静默成片）
// 节奏：分段合成 + 静音拼接（模拟 SSML break 的停顿控制）
// 缓存：按 (provider, voice, rate, text) 哈希缓存分段 wav
// ════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { ROOT, VOICE_PROFILES, getConfig, type VoiceProfile } from "./config.ts";
import type { EventSink, Scene } from "./types.ts";
import { ensureDir, exists, findFfmpeg, run, sha1Short } from "./util.ts";
import { concatWavFiles, wavDurationMs } from "./audio.ts";

export interface VoiceStageInput {
  scenes: Scene[];
  jobDir: string;
  cacheDir: string;
  emit: EventSink;
  /** 音色档案 id：yunque / qingzheng / songfeng / none */
  profileId: string;
}

const SEG_GAP_MS = 450; // 场景内段间停顿（诗句↔旁白；给朗诵留呼吸）
const TAIL_PAD_MS = 750; // 场景尾部留白（画面停留）

// ── SAPI 实现 ───────────────────────────────────────────────────
const SAPI_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$VoicePrefer = "",
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
$picked = $null
if ($VoicePrefer) {
  foreach ($name in ($VoicePrefer -split '\\|')) {
    if (-not $name) { continue }
    $hit = $installed | Where-Object { $_.VoiceInfo.Name -like ('*' + $name + '*') } | Select-Object -First 1
    if ($hit) { $picked = $hit; break }
  }
}
if (-not $picked) {
  $picked = $installed | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
}
if (-not $picked) {
  $names = ($installed | ForEach-Object { $_.VoiceInfo.Name }) -join ', '
  throw ('没有可用的中文语音。已安装: ' + $names)
}
$synth.SelectVoice($picked.VoiceInfo.Name)
$synth.Rate = $Rate
$synth.Volume = $Volume
$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
$synth.SetOutputToWaveFile($OutFile)
$synth.Speak($text)
$synth.Dispose()
Write-Output $picked.VoiceInfo.Name
`;

let sapiScriptWritten = "";

function writeSapiScript(workDir: string): string {
  if (sapiScriptWritten && exists(sapiScriptWritten)) return sapiScriptWritten;
  const file = path.join(workDir, "sapi-tts.ps1");
  fs.writeFileSync(file, "\ufeff" + SAPI_PS1, "utf8");
  sapiScriptWritten = file;
  return file;
}

async function sapiSynthesize(workDir: string, text: string, destWav: string, prefer: string[], rate: number, volume: number): Promise<string> {
  const script = writeSapiScript(workDir);
  const textFile = destWav.replace(/\.wav$/, ".txt");
  fs.writeFileSync(textFile, text, "utf8");
  const r = await run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-TextFile", textFile, "-OutFile", destWav, "-VoicePrefer", prefer.join("|"), "-Rate", String(rate), "-Volume", String(volume)],
    { timeoutMs: 120000 },
  );
  if (!exists(destWav)) throw new Error(`SAPI 未生成音频：${destWav}`);
  const lines = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** 音高塑形（不变速）：asetrate 降调 → atempo 恢复原时长 */
async function shapePitch(src: string, dest: string, pitch: number): Promise<void> {
  const info = findFfmpeg();
  if (!info) {
    fs.copyFileSync(src, dest);
    return;
  }
  const tempo = (1 / pitch).toFixed(4);
  await run(
    info.ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-af", `aresample=22050,asetrate=22050*${pitch},aresample=44100,atempo=${tempo}`, "-c:a", "pcm_s16le", dest],
    { timeoutMs: 120000 },
  );
}

// ── OpenAI 兼容 TTS（按公开文档实现；未实测） ───────────────────
async function openaiTts(text: string, destFile: string, voice: string): Promise<void> {
  const cfg = getConfig().voice;
  if (!cfg.apiKey) throw new Error(`TTS 需要 API Key：请设置 SHIYING_VOICE_API_KEY`);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, voice, input: text, response_format: "wav" }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TTS 接口 ${res.status}：${body.slice(0, 200)}`);
  }
  fs.writeFileSync(destFile, Buffer.from(await res.arrayBuffer()));
}

// ── Edge 神经语音（默认通道；需 Python + edge-tts + 联网） ───────
const EDGE_SCRIPT = path.join(ROOT, "scripts", "edge_tts_once.py");

async function edgeSynthesize(jobDir: string, text: string, destWav: string, profile: VoiceProfile): Promise<void> {
  const py = process.env.SHIYING_PYTHON || "python";
  const textFile = destWav.replace(/\.wav$/, ".txt");
  const mp3 = destWav.replace(/\.wav$/, ".mp3");
  fs.writeFileSync(textFile, text, "utf8");
  await run(
    py,
    [
      EDGE_SCRIPT,
      `--text-file=${textFile}`,
      `--out=${mp3}`,
      `--voice=${profile.edge.voice}`,
      `--rate=${profile.edge.rate}`,
      `--pitch=${profile.edge.pitch}`,
      `--volume=${profile.edge.volume}`,
    ],
    { timeoutMs: 120000 },
  );
  if (!exists(mp3)) throw new Error(`edge-tts 未生成音频（检查 Python 与 edge-tts 安装、网络）：${mp3}`);
  const info = findFfmpeg();
  if (!info) throw new Error("edge 音频转码需要 FFmpeg（未找到 ffmpeg）");
  await run(info.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", destWav], { timeoutMs: 60000 });
  if (!exists(destWav)) throw new Error(`edge 音频转码失败：${destWav}`);
}

/** 缓存与合成参数指纹（按通道取对应参数） */
function synthesisParams(provider: string, profile: VoiceProfile): string {
  if (provider === "edge") return `${profile.edge.voice}|${profile.edge.rate}|${profile.edge.pitch}|${profile.edge.volume}`;
  if (provider === "openai") return profile.openaiVoice;
  return `${profile.sapi.rate}|${profile.sapi.pitch}`;
}

// ── 主入口 ──────────────────────────────────────────────────────
export async function generateVoice(input: VoiceStageInput): Promise<boolean> {
  const cfg = getConfig();
  let provider = cfg.voice.provider;
  const { scenes, jobDir, cacheDir, emit, profileId } = input;

  if (provider === "none" || profileId === "none") {
    emit({ type: "stage", stage: "voice", status: "skip", message: "声音工序：已跳过（无配音）" });
    for (const s of scenes) s.durMs = s.minDurMs;
    return false;
  }

  // edge 可用性探测（未安装/缺 Python 时整体回退系统语音，保证仍能出片）
  if (provider === "edge") {
    const probe = await run(process.env.SHIYING_PYTHON || "python", ["-c", "import edge_tts"], { allowFail: true, timeoutMs: 20000 });
    if (probe.code !== 0) {
      emit({ type: "log", stage: "voice", message: "edge-tts 不可用（未安装或缺 Python），本任务回退系统语音 sapi；安装：pip install edge-tts" });
      provider = "sapi";
    }
  }

  const profile = VOICE_PROFILES[profileId] ?? VOICE_PROFILES["qingzheng"]!;
  emit({ type: "stage", stage: "voice", status: "start", message: `声音工序：provider=${provider}，音色=${profile.label}` });

  ensureDir(path.join(cacheDir, "voice"));
  let segTotal = 0;
  let segDone = 0;
  for (const s of scenes) segTotal += s.narrationSegments.length;

  const voiceDir = ensureDir(path.join(jobDir, "voice"));

  for (const scene of scenes) {
    const idx = scene.index + 1;
    const segments: string[] = [];
    let segNo = 0;
    for (const text of scene.narrationSegments) {
      segNo++;
      const key = sha1Short("tts-v3", provider, profile.id, synthesisParams(provider, profile), text);
      const dest = path.join(voiceDir, `s${idx}-seg${segNo}.wav`);
      const cacheFile = path.join(cacheDir, "voice", `${key}.wav`);
      if (exists(cacheFile)) {
        fs.copyFileSync(cacheFile, dest);
      } else {
        // 合成（失败自动重试一次）
        let attempt = 0;
        for (;;) {
          try {
            if (provider === "sapi") {
              const raw = dest.replace(/\.wav$/, ".raw.wav");
              const picked = await sapiSynthesize(jobDir, text, raw, profile.sapi.preferNames, profile.sapi.rate, profile.sapi.volume);
              const shaped =
                profile.sapi.pitch !== 1 &&
                picked !== "" &&
                !profile.sapi.preferNames.some((n) => picked.toLowerCase().includes(n.toLowerCase()));
              if (shaped) {
                await shapePitch(raw, dest, profile.sapi.pitch);
              } else {
                fs.renameSync(raw, dest);
              }
            } else if (provider === "edge") {
              await edgeSynthesize(jobDir, text, dest, profile);
            } else if (provider === "openai") {
              await openaiTts(text, dest, profile.openaiVoice);
            } else {
              throw new Error(`未知语音 provider：${provider}`);
            }
            break;
          } catch (err) {
            attempt++;
            if (attempt >= 2) throw err;
            emit({
              type: "log",
              stage: "voice",
              message: `第 ${idx} 镜第 ${segNo} 段合成失败，重试（${(err instanceof Error ? err.message : String(err)).slice(0, 100)}）`,
            });
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
        try {
          fs.copyFileSync(dest, cacheFile);
        } catch {
          /* 忽略 */
        }
      }
      segments.push(dest);
      segDone++;
      emit({ type: "stage", stage: "voice", status: "progress", progress: segTotal ? segDone / segTotal : 1, message: `声音工序 ${segDone}/${segTotal} 段` });
    }

    // 场景音频 = 分段 + 段间停顿
    if (segments.length > 0) {
      const sceneWav = path.join(voiceDir, `scene-${idx}.wav`);
      let durMs = 0;
      if (segments.length === 1) {
        fs.copyFileSync(segments[0]!, sceneWav);
        durMs = wavDurationMs(segments[0]!);
      } else {
        durMs = await concatWavFiles(segments, sceneWav, SEG_GAP_MS);
      }
      scene.audio = sceneWav;
      scene.audioDurMs = durMs;
      scene.durMs = Math.max(scene.minDurMs, Math.round(durMs + TAIL_PAD_MS));
    } else {
      scene.durMs = scene.minDurMs;
    }
  }

  emit({ type: "stage", stage: "voice", status: "done", progress: 1, message: "声音工序完成" });
  return true;
}

/** 组装整条旁白轨：逐场景音频 + 场景尾部静音，落成 narration.wav */
export async function assembleNarration(scenes: Scene[], jobDir: string): Promise<string | null> {
  const withAudio = scenes.filter((s) => s.audio);
  if (withAudio.length === 0) return null;
  const out = path.join(jobDir, "narration.wav");
  // 逐场景生成「音频 + 尾部静音」的片段，再拼接
  const { mkSilenceWav } = await import("./audio.ts");
  const parts: string[] = [];
  const tmpDir = ensureDir(path.join(jobDir, "voice"));
  for (const s of scenes) {
    if (s.audio && s.audioDurMs !== undefined) {
      parts.push(s.audio);
      const tail = Math.max(0, s.durMs - s.audioDurMs);
      if (tail > 40) {
        const silenceFile = path.join(tmpDir, `tail-${s.index + 1}.wav`);
        await mkSilenceWav(s.audio, silenceFile, tail);
        parts.push(silenceFile);
      }
    } else {
      // 无音频场景也要占满时长（用整段静音）
      const ref = withAudio[0]!.audio!;
      const silenceFile = path.join(tmpDir, `sil-${s.index + 1}.wav`);
      await mkSilenceWav(ref, silenceFile, s.durMs);
      parts.push(silenceFile);
    }
  }
  await concatWavFiles(parts, out, 0);
  return out;
}

export function voiceProfileLabel(id: string): string {
  return VOICE_PROFILES[id]?.label ?? id;
}

// ── 音色映射解析（供工作台透明展示：本机实际用哪个音色、是否塑形） ──
let voiceListMemo: Promise<Array<{ name: string; culture: string }>> | null = null;

function listSapiVoices(): Promise<Array<{ name: string; culture: string }>> {
  if (process.platform !== "win32") return Promise.resolve([]);
  if (!voiceListMemo) {
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
      "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    voiceListMemo = run("powershell.exe", ["-NoProfile", "-Command", script], { allowFail: true, timeoutMs: 30000 })
      .then((r) =>
        r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, culture] = line.split("|");
            return { name: name ?? "", culture: culture ?? "" };
          }),
      )
      .catch(() => []);
  }
  return voiceListMemo;
}

export interface ResolvedVoiceProfile {
  id: string;
  label: string;
  character: string;
  actual: string | null;
  shaped: boolean;
  /** 展示用注记：神经语音 / 原声 / 音高塑形 */
  note: string;
}

/** Edge 音色的展示名 */
const EDGE_VOICE_DISPLAY: Record<string, string> = {
  "zh-CN-YunjianNeural": "云健 Yunjian",
  "zh-CN-XiaoxiaoNeural": "晓晓 Xiaoxiao",
  "zh-CN-YunyangNeural": "云扬 Yunyang",
  "zh-CN-XiaoyiNeural": "晓伊 Xiaoyi",
  "zh-CN-YunxiNeural": "云希 Yunxi",
};

/** 解析每个音色档案在本机的实际落点（与运行时选取逻辑一致） */
export async function resolveVoiceProfiles(): Promise<ResolvedVoiceProfile[]> {
  const cfg = getConfig();
  if (cfg.voice.provider === "edge") {
    return Object.values(VOICE_PROFILES).map((p) => ({
      id: p.id,
      label: p.label,
      character: "神经语音",
      actual: EDGE_VOICE_DISPLAY[p.edge.voice] ?? p.edge.voice,
      shaped: false,
      note: "神经语音",
    }));
  }
  const voices = await listSapiVoices();
  return Object.values(VOICE_PROFILES).map((p) => {
    let picked: string | null = null;
    for (const token of p.sapi.preferNames) {
      const hit = voices.find((v) => v.name.toLowerCase().includes(token.toLowerCase()));
      if (hit) {
        picked = hit.name;
        break;
      }
    }
    if (!picked) picked = voices.find((v) => v.culture.toLowerCase().startsWith("zh"))?.name ?? null;
    const shaped =
      Boolean(picked) && p.sapi.pitch !== 1 && !p.sapi.preferNames.some((n) => picked!.toLowerCase().includes(n.toLowerCase()));
    return { id: p.id, label: p.label, character: p.character, actual: picked, shaped, note: shaped ? "音高塑形" : "原声" };
  });
}
