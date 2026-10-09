// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 配置层
// .env → 环境变量 → 各工序 provider 预设；全部有兜底，离线可跑
// ════════════════════════════════════════════════════════════════
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dotenvLoaded = false;

/** 极简 .env 解析：KEY=VALUE，支持 # 注释与引号包裹 */
export function loadDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(key: string, fallback = ""): string {
  loadDotenv();
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

// ── 文本工序预设 ────────────────────────────────────────────────
const TEXT_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};

// ── 画面工序预设 ────────────────────────────────────────────────
const IMAGE_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  cogview: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-image-1" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "Kwai-Kolors/Kolors" },
};

// ── 声音工序预设 ────────────────────────────────────────────────
const VOICE_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "tts-1" },
};

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppConfig {
  text: ProviderConfig;
  image: ProviderConfig;
  voice: ProviderConfig;
  bgm: string;
  size: { width: number; height: number; label: string };
  outRoot: string;
  concurrency: number;
  keepWatermark: boolean;
  seedreamTokenService: string;
}

export function parseSize(label: string): { width: number; height: number; label: string } {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(label.trim());
  if (m) {
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width > 0 && height > 0) return { width, height, label: `${width}x${height}` };
  }
  return { width: 1080, height: 1920, label: "1080x1920" };
}

export function getConfig(): AppConfig {
  const textProvider = env("SHIYING_TEXT_PROVIDER", "offline");
  const imageProvider = env("SHIYING_IMAGE_PROVIDER", "svg");
  const voiceProvider = env("SHIYING_VOICE_PROVIDER", "edge");

  const textPreset = TEXT_PRESETS[textProvider] ?? { baseUrl: "", model: "" };
  const imagePreset = IMAGE_PRESETS[imageProvider] ?? { baseUrl: "", model: "" };
  const voicePreset = VOICE_PRESETS[voiceProvider] ?? { baseUrl: "", model: "" };

  return {
    text: {
      provider: textProvider,
      apiKey: env("SHIYING_TEXT_API_KEY"),
      baseUrl: env("SHIYING_TEXT_BASE_URL", textPreset.baseUrl),
      model: env("SHIYING_TEXT_MODEL", textPreset.model),
    },
    image: {
      provider: imageProvider,
      apiKey: env("SHIYING_IMAGE_API_KEY"),
      baseUrl: env("SHIYING_IMAGE_BASE_URL", imagePreset.baseUrl),
      model: env("SHIYING_IMAGE_MODEL", imagePreset.model),
    },
    voice: {
      provider: voiceProvider,
      apiKey: env("SHIYING_VOICE_API_KEY"),
      baseUrl: env("SHIYING_VOICE_BASE_URL", voicePreset.baseUrl),
      model: env("SHIYING_VOICE_MODEL", voicePreset.model),
    },
    bgm: env("SHIYING_BGM_PROVIDER", "synth"),
    size: parseSize(env("SHIYING_SIZE", "1080x1920")),
    outRoot: env("SHIYING_OUT", path.join(ROOT, "output")),
    concurrency: Number(env("SHIYING_CONCURRENCY", "2")) || 2,
    keepWatermark: env("SHIYING_KEEP_WATERMARK", "1") !== "0",
    seedreamTokenService: env("SHIYING_SEEDREAM_TOKEN_SERVICE", "http://127.0.0.1:18432/get_token"),
  };
}

/** 中文音色档案：原型里的「云阙 / 清徵 / 松风」映射到真实 TTS 参数 */
export interface VoiceProfile {
  id: string;
  label: string;
  /** 塑形方式说明（工作台透明展示用；SAPI 通道） */
  character: string;
  /** SAPI 侧参数（离线兑底） */
  sapi: {
    /** 理想音色优先级；均缺席时用系统首个中文音色 + 音高塑形 */
    preferNames: string[];
    rate: number;
    volume: number;
    /** 音高塑形系数（1 = 原声；<1 = 更低）。仅当实际选中的音色不在理想清单内时生效 */
    pitch: number;
  };
  /** Edge 神经语音参数（默认通道：更真人、适合古诗朗诵；需联网） */
  edge: { voice: string; rate: string; pitch: string; volume: string };
  /** OpenAI 兼容 TTS 侧参数 */
  openaiVoice: string;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  yunque: {
    id: "yunque",
    label: "云阙 · 沉静男声",
    character: "低音塑形",
    sapi: { preferNames: ["Microsoft Kangkang", "Kangkang", "Microsoft Yunyang", "Yunyang"], rate: -2, volume: 100, pitch: 0.85 },
    edge: { voice: "zh-CN-YunjianNeural", rate: "-8%", pitch: "+0Hz", volume: "+0%" },
    openaiVoice: "onyx",
  },
  qingzheng: {
    id: "qingzheng",
    label: "清徵 · 清亮女声",
    character: "原声",
    sapi: { preferNames: ["Microsoft Huihui Desktop", "Huihui", "Microsoft Xiaoxiao"], rate: -1, volume: 100, pitch: 1.0 },
    edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "-4%", pitch: "+0Hz", volume: "+0%" },
    openaiVoice: "nova",
  },
  songfeng: {
    id: "songfeng",
    label: "松风 · 苍劲男声",
    character: "深低音 + 慢速",
    sapi: { preferNames: ["Microsoft Yunyang", "Yunyang", "Microsoft Kangkang", "Kangkang"], rate: -3, volume: 100, pitch: 0.78 },
    edge: { voice: "zh-CN-YunyangNeural", rate: "-12%", pitch: "+0Hz", volume: "+0%" },
    openaiVoice: "echo",
  },
};

export const BGM_LABELS: Record<string, string> = {
  guqin: "古琴 · 空山",
  rain: "雨声 · 檐下",
  none: "无配乐",
};
