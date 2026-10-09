// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 音频底层
// WAV 读写 / 静音生成 / 拼接（纯 JS，格式统一后再拼接）
// BGM 合成：古琴拨弦（Karplus-Strong 五声音阶）与雨声（滤波噪声）
//   —— 全部为程序合成音，无版权风险
// ════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, findFfmpeg, run } from "./util.ts";

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

interface WavInfo extends WavFormat {
  data: Buffer;
}

/** 解析 WAV（PCM16 / PCM8 / PCM32 均读 data chunk，取常见 PCM16 为主） */
export function readWav(file: string): WavInfo {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") throw new Error(`不是标准 WAV：${file}`);
  let offset = 12;
  let fmt: WavFormat | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`WAV 解析失败（缺 fmt/data）：${file}`);
  return { ...fmt, data };
}

export function wavDurationMs(file: string): number {
  const w = readWav(file);
  return (w.data.length / (w.sampleRate * w.channels * (w.bitsPerSample / 8))) * 1000;
}

const STD: WavFormat = { sampleRate: 44100, channels: 1, bitsPerSample: 16 };

function sameFormat(a: WavFormat, b: WavFormat): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitsPerSample === b.bitsPerSample;
}

/** 用 ffmpeg 统一成 44.1k 单声道 PCM16（格式不同时的转换器） */
async function normalizeWav(src: string, dest: string): Promise<string> {
  const info = findFfmpeg();
  if (!info) throw new Error("需要 FFmpeg 处理音频格式（未找到 ffmpeg）");
  await run(info.ffmpeg, ["-y", "-i", src, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", dest], { timeoutMs: 120000 });
  return dest;
}

function wavHeader(format: WavFormat, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.channels * (format.bitsPerSample / 8), 28);
  header.writeUInt16LE(format.channels * (format.bitsPerSample / 8), 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** 生成与 ref 同格式的静音 WAV */
export async function mkSilenceWav(refWav: string, dest: string, ms: number): Promise<void> {
  let w = readWav(refWav);
  if (!sameFormat(w, STD)) {
    const tmp = dest.replace(/\.wav$/, ".ref.wav");
    await normalizeWav(refWav, tmp);
    w = readWav(tmp);
  }
  const bytesPerSample = w.channels * (w.bitsPerSample / 8);
  const totalBytes = Math.max(0, Math.round((ms / 1000) * w.sampleRate) * bytesPerSample);
  const data = Buffer.alloc(totalBytes);
  fs.writeFileSync(dest, Buffer.concat([wavHeader(w, totalBytes), data]));
}

/**
 * 拼接多个 WAV：格式自动统一（必要时经 ffmpeg 归一），段间可加静音
 * @returns 输出总时长（毫秒）
 */
export async function concatWavFiles(files: string[], dest: string, gapMs: number): Promise<number> {
  ensureDir(path.dirname(dest));
  const normalized: WavInfo[] = [];
  const tmpDir = ensureDir(path.join(path.dirname(dest), ".norm"));
  for (let i = 0; i < files.length; i++) {
    let w = readWav(files[i]!);
    if (!sameFormat(w, STD)) {
      const tmp = path.join(tmpDir, `n-${Date.now()}-${i}.wav`);
      await normalizeWav(files[i]!, tmp);
      w = readWav(tmp);
    }
    normalized.push(w);
  }
  const bytesPerMs = (STD.sampleRate * STD.channels * (STD.bitsPerSample / 8)) / 1000;
  const silence = Buffer.alloc(Math.round(gapMs * bytesPerMs));
  const chunks: Buffer[] = [];
  let totalMs = 0;
  normalized.forEach((w, i) => {
    if (i > 0 && gapMs > 0) chunks.push(silence);
    chunks.push(w.data);
    totalMs += (w.data.length / bytesPerMs);
    if (i > 0 && gapMs > 0) totalMs += gapMs;
  });
  const data = Buffer.concat(chunks);
  fs.writeFileSync(dest, Buffer.concat([wavHeader(STD, data.length), data]));
  return totalMs;
}

/** 写 16bit PCM WAV（浮点样本 [-1,1] → PCM） */
export function writeFloatWav(dest: string, sampleRate: number, channels: number, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const fmt: WavFormat = { sampleRate, channels, bitsPerSample: 16 };
  fs.writeFileSync(dest, Buffer.concat([wavHeader(fmt, data.length), data]));
}

// ── 随机数（可复现） ────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 古琴（Karplus-Strong 五声音阶） ─────────────────────────────
function ksPluck(freq: number, sampleRate: number, durSamples: number, seed: number, gain: number): Float32Array {
  const N = Math.max(2, Math.round(sampleRate / freq));
  const ring = new Float32Array(N);
  const rnd = mulberry32(seed);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp = 0.5 * lp + 0.5 * (rnd() * 2 - 1);
    ring[i] = lp;
  }
  const out = new Float32Array(durSamples);
  let pos = 0;
  for (let i = 0; i < durSamples; i++) {
    const cur = ring[pos]!;
    const nxt = ring[(pos + 1) % N]!;
    out[i] = cur * gain;
    ring[pos] = 0.5 * (cur + nxt) * 0.9965;
    pos = (pos + 1) % N;
  }
  return out;
}

interface Note {
  freq: number;
  start: number;
  gain: number;
}

/** 五声音阶（D 宫调）：D3 F3 G3 A3 C4 D4 F4 G4 A4 */
const PENTATONIC = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23, 392.0, 440.0];

function synthGuqin(durationMs: number, sampleRate: number, seed: number): Float32Array {
  const total = Math.round((durationMs / 1000) * sampleRate);
  const master = new Float32Array(total);
  const rnd = mulberry32(seed);
  const notes: Note[] = [];
  // 漫步旋律：每 1.9–3.4s 一音，偶尔叠一个五度/八度泛音
  let t = 0.6 + rnd() * 1.2;
  let idx = 3 + Math.floor(rnd() * 3);
  while (t < durationMs / 1000 + 1) {
    const freq = PENTATONIC[Math.max(0, Math.min(PENTATONIC.length - 1, idx))]!;
    notes.push({ freq, start: t, gain: 0.30 + rnd() * 0.12 });
    if (rnd() < 0.3) notes.push({ freq: freq * 2, start: t + 0.16, gain: 0.10 });
    if (rnd() < 0.22) notes.push({ freq: freq * 1.5, start: t + 0.3, gain: 0.08 });
    const step = rnd();
    idx += step < 0.36 ? 1 : step < 0.68 ? -1 : step < 0.86 ? 2 : -2;
    idx = Math.max(0, Math.min(PENTATONIC.length - 1, idx));
    t += 1.9 + rnd() * 1.5;
  }
  const noteDurS = 2.8;
  notes.forEach((n, i) => {
    const startSample = Math.round(n.start * sampleRate);
    const durSamples = Math.min(Math.round(noteDurS * sampleRate), total - startSample);
    if (durSamples <= 0) return;
    const wave = ksPluck(n.freq, sampleRate, durSamples, seed + i * 7919, n.gain);
    for (let j = 0; j < durSamples; j++) master[startSample + j] += wave[j]!;
  });
  // 回响（山谷感）
  const delay = Math.round(0.42 * sampleRate);
  for (let i = delay; i < total; i++) master[i] += master[i - delay] * 0.28;
  // 归一 + 包络
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(master[i]!));
  const norm = peak > 0 ? 0.42 / peak : 1;
  const fadeIn = Math.round(1.4 * sampleRate);
  const fadeOut = Math.round(Math.min(3.2, durationMs / 1000 / 4) * sampleRate);
  for (let i = 0; i < total; i++) {
    let k = norm;
    if (i < fadeIn) k *= i / fadeIn;
    if (i > total - fadeOut) k *= Math.max(0, (total - i) / fadeOut);
    master[i] *= k;
  }
  return master;
}

// ── 雨声（滤波噪声 + 低频氛围） ─────────────────────────────────
function synthRain(durationMs: number, sampleRate: number, seed: number): Float32Array {
  const total = Math.round((durationMs / 1000) * sampleRate);
  const out = new Float32Array(total);
  const rnd = mulberry32(seed);
  let lp1 = 0;
  let lp2 = 0;
  let rumble = 0;
  let modCur = 1;
  let modTarget = 1;
  const modStep = Math.max(1, Math.round(sampleRate * 0.25));
  for (let i = 0; i < total; i++) {
    const w = rnd() * 2 - 1;
    lp1 += 0.16 * (w - lp1);
    lp2 += 0.085 * (lp1 - lp2);
    rumble += 0.004 * (w - rumble);
    if (i % modStep === 0) modTarget = 0.78 + rnd() * 0.36;
    modCur += (modTarget - modCur) * 0.0015;
    out[i] = (lp2 * 0.85 + rumble * 0.55) * modCur;
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const norm = peak > 0 ? 0.3 / peak : 1;
  const fadeIn = Math.round(1.6 * sampleRate);
  const fadeOut = Math.round(Math.min(3.0, durationMs / 1000 / 4) * sampleRate);
  for (let i = 0; i < total; i++) {
    let k = norm;
    if (i < fadeIn) k *= i / fadeIn;
    if (i > total - fadeOut) k *= Math.max(0, (total - i) / fadeOut);
    out[i] *= k;
  }
  return out;
}

/**
 * 合成配乐 WAV（立体声 44.1k）
 * kind: guqin | rain
 */
export function synthBgm(kind: string, durationMs: number, dest: string, seed = 20260922): number {
  const sampleRate = 44100;
  const mono = kind === "rain" ? synthRain(durationMs, sampleRate, seed) : synthGuqin(durationMs, sampleRate, seed);
  // 立体声：右声道 14ms 延迟（Haas 微扩散）
  const shift = Math.round(0.014 * sampleRate);
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    const l = mono[i]!;
    const r = i >= shift ? mono[i - shift]! * 0.97 : 0;
    stereo[i * 2] = l;
    stereo[i * 2 + 1] = r;
  }
  ensureDir(path.dirname(dest));
  writeFloatWav(dest, sampleRate, 2, stereo);
  return durationMs;
}

/** BGM 缓存：按类型 + 向上取整的时长（5s 步进）复用 */
export async function bgmCached(kind: string, durationMs: number, cacheDir: string): Promise<string> {
  const bucket = Math.ceil(durationMs / 5000) * 5000;
  const dest = path.join(cacheDir, "audio", `bgm-${kind}-${bucket}.wav`);
  if (exists(dest)) return dest;
  ensureDir(path.dirname(dest));
  synthBgm(kind, bucket, dest);
  return dest;
}
