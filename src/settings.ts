// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 工作台设置层
// data/studio-settings.json：四通道（文本/画面/动效视频/声音）节点注册表。
// 分层语义：设置文件 → 覆盖 .env → 覆盖内置预设；节点里留空的字段回落 .env。
// 注意：本模块不得在运行时 import config.ts（避免循环加载），仅做类型引用。
// ════════════════════════════════════════════════════════════════
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SETTINGS_FILE = path.join(ROOT, "data", "studio-settings.json");

export type ChannelKey = "text" | "image" | "video" | "voice";
export const CHANNEL_KEYS: ChannelKey[] = ["text", "image", "video", "voice"];

export interface ChannelNode {
  /** 通道标识：text/image 任意 slug；voice 固定 edge/sapi/openai；video 固定 none/agnes */
  id: string;
  label: string;
  baseUrl?: string;
  model?: string;
  /** 留空 = 回落 .env 对应变量；仅在设置文件中保存明文，勿提交仓库 */
  apiKey?: string;
  builtin?: boolean;
  note?: string;
}

export interface ChannelSettings {
  active: string;
  nodes: ChannelNode[];
}

export interface SettingsFile {
  version: 1;
  channels: Record<ChannelKey, ChannelSettings>;
}

// ── 内置节点默认表（与 config.ts 的 *_PRESETS 对应；勿在运行时从 config 导入） ──
export function defaultSettings(): SettingsFile {
  return {
    version: 1,
    channels: {
      text: {
        active: "offline",
        nodes: [
          { id: "offline", label: "本地内置解析", builtin: true, note: "离线模式 · 用内置诗库，出「纯朗诵版」" },
          { id: "glm", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", builtin: true },
          { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", builtin: true },
          { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", builtin: true },
        ],
      },
      image: {
        active: "svg",
        nodes: [
          { id: "svg", label: "本地 SVG 水墨引擎", builtin: true, note: "离线 · 无头浏览器渲染，固定水墨风" },
          { id: "seedream", label: "Seedream（本地令牌服务）", builtin: true, note: "经本机 SHIYING_SEEDREAM_TOKEN_SERVICE 取令牌" },
          { id: "cogview", label: "智谱 CogView", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash", builtin: true },
          { id: "siliconflow", label: "硅基流动 Kolors", baseUrl: "https://api.siliconflow.cn/v1", model: "Kwai-Kolors/Kolors", builtin: true },
          { id: "openai", label: "OpenAI gpt-image-1", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", builtin: true },
          { id: "agnes", label: "Agnes 图像", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-image-2.5-flash", builtin: true, note: "2K/1K 档位限流 5/10 次每分" },
        ],
      },
      video: {
        active: "none",
        nodes: [
          { id: "none", label: "静态图 + 程序运镜", builtin: true, note: "默认 · 不消耗视频额度" },
          { id: "agnes", label: "Agnes Video 2.5 Flash", baseUrl: "https://api.agnes-ai.cn/v1", model: "agnes-video-2.5-flash", builtin: true, note: "首帧用分镜图 URL · 免费 1 次每分 · Key 默认与图像通道共用" },
        ],
      },
      voice: {
        active: "edge",
        nodes: [
          { id: "edge", label: "Edge 神经语音", builtin: true, note: "联网免费 · 最真人，失败自动回落 SAPI" },
          { id: "sapi", label: "Windows SAPI", builtin: true, note: "完全离线 · 音高塑形" },
          { id: "openai", label: "OpenAI 兼容 TTS", baseUrl: "https://api.openai.com/v1", model: "tts-1", builtin: true },
        ],
      },
    },
  };
}

// ── 读写 ────────────────────────────────────────────────────────
export function loadSettings(): SettingsFile | null {
  try {
    if (!existsSync(SETTINGS_FILE)) return null;
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as SettingsFile;
    if (!raw || raw.version !== 1 || !raw.channels) return null;
    // 补齐缺失通道，避免旧版本设置文件缺字段
    const base = defaultSettings();
    for (const k of CHANNEL_KEYS) {
      if (!raw.channels[k] || !Array.isArray(raw.channels[k].nodes)) raw.channels[k] = base.channels[k];
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeSettings(s: SettingsFile): void {
  // 落盘前把残留的旧版明文密钥统一加密（惰性迁移，encryptSecret 对密文幂等），保证磁盘无明文
  for (const k of CHANNEL_KEYS) {
    for (const n of s.channels[k].nodes) {
      if (n.apiKey) n.apiKey = encryptSecret(n.apiKey);
    }
  }
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
}

// ── 密钥加密存储（AES-256-GCM；主密钥独立存放 data/studio.key，已 gitignore） ──
const SECRET_FILE = path.join(ROOT, "data", "studio.key");
const ENC_PREFIX = "enc:v1:";

let secretKey: Buffer | null = null;

/** 主密钥：首次使用自动生成 32 字节随机数；文件损坏则重建（旧密文解不开按未配处理，需重填） */
function loadOrCreateSecret(): Buffer {
  if (secretKey) return secretKey;
  try {
    if (existsSync(SECRET_FILE)) {
      const hex = readFileSync(SECRET_FILE, "utf8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        secretKey = Buffer.from(hex, "hex");
        return secretKey;
      }
    }
    secretKey = randomBytes(32);
    mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    writeFileSync(SECRET_FILE, secretKey.toString("hex") + "\n", "utf8");
    try {
      chmodSync(SECRET_FILE, 0o600);
    } catch {
      /* Windows 上 chmod 尽力而为，失败不影响功能 */
    }
    return secretKey;
  } catch {
    // 极端情况（目录只读等）：退化为进程内存密钥，密文仍不以明文落盘
    secretKey = randomBytes(32);
    return secretKey;
  }
}

/** 明文 → enc:v1:<iv>:<tag>:<cipher>（base64url）；空串原样返回；已加密值不重复加密 */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(ENC_PREFIX)) return plain;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", loadOrCreateSecret(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return (
      ENC_PREFIX + iv.toString("base64url") + ":" + cipher.getAuthTag().toString("base64url") + ":" + enc.toString("base64url")
    );
  } catch {
    return "";
  }
}

/** enc:v1:… → 明文；旧版明文原样返回（惰性迁移，下次保存自动加密）；解密失败返回空串 */
export function decryptSecret(stored: string | undefined | null): string {
  const s = (stored ?? "").trim();
  if (!s) return "";
  if (!s.startsWith(ENC_PREFIX)) return s;
  try {
    const [, , ivB, tagB, dataB] = s.split(":");
    const decipher = createDecipheriv("aes-256-gcm", loadOrCreateSecret(), Buffer.from(ivB!, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** 取节点明文密钥（设置文件密文自动解密；无密钥返回空串）——连通性测试接口用 */
export function revealNodeKey(node: { apiKey?: string } | undefined | null): string {
  return decryptSecret(node?.apiKey);
}

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const VOICE_IDS = new Set(["edge", "sapi", "openai"]);
const VIDEO_IDS = new Set(["none", "agnes"]);
/** 本地/离线引擎：不联网、不需要密钥，视图中不做 .env 密钥回落展示 */
const LOCAL_IDS = new Set(["offline", "svg", "seedream", "none", "edge", "sapi"]);

/** 校验 + 规范化外部传入的设置；密钥合并语义：空串/缺省保留旧值，"__clear__" 清除 */
export function normalizeIncoming(raw: unknown): SettingsFile {
  const prev = loadSettings();
  const base = defaultSettings();
  const input = (raw ?? {}) as Partial<SettingsFile>;
  const out = base;
  for (const ch of CHANNEL_KEYS) {
    const inc = input.channels?.[ch];
    const prevCh = prev?.channels[ch];
    const nodes: ChannelNode[] = [];
    const seen = new Set<string>();
    for (const n of Array.isArray(inc?.nodes) ? inc!.nodes! : []) {
      const id = String(n?.id ?? "").trim();
      if (!ID_RE.test(id) || seen.has(id)) continue;
      if (ch === "voice" && !VOICE_IDS.has(id)) continue;
      if (ch === "video" && !VIDEO_IDS.has(id)) continue;
      seen.add(id);
      const old = prevCh?.nodes.find((o) => o.id === id);
      const rawKey = n?.apiKey;
      // 落盘前统一加密：新明文加密存储；保留旧值时沿用已存密文（或待迁移的旧明文）
      const apiKey =
        rawKey === "__clear__"
          ? ""
          : typeof rawKey === "string" && rawKey !== ""
            ? encryptSecret(rawKey.trim())
            : (old?.apiKey ?? "");
      nodes.push({
        id,
        label: String(n?.label ?? "").trim().slice(0, 40) || id,
        baseUrl: String(n?.baseUrl ?? "").trim().slice(0, 300) || "",
        model: String(n?.model ?? "").trim().slice(0, 120) || "",
        apiKey,
        builtin: n?.builtin === true || old?.builtin === true,
        note: typeof n?.note === "string" ? n.note.slice(0, 120) : old?.note,
      });
    }
    // 至少保留内置节点，防止清空导致通道无节点可选
    if (!nodes.length) {
      out.channels[ch] = { active: base.channels[ch].active, nodes: base.channels[ch].nodes };
      continue;
    }
    let active = String(inc?.active ?? "").trim();
    if (!seen.has(active)) active = nodes[0]!.id;
    out.channels[ch] = { active, nodes };
  }
  return out;
}

/** 用设置文件覆盖 env 层配置（节点留空的字段回落 env 已解析值） */
export function applySettings(cfg: AppConfig): AppConfig {
  const s = loadSettings();
  if (!s) return cfg;
  const next: AppConfig = { ...cfg };
  const ch = (k: ChannelKey) => s.channels[k];
  const node = (k: ChannelKey) => ch(k).nodes.find((n) => n.id === ch(k).active);
  const t = node("text");
  if (t) {
    next.text = {
      provider: ch("text").active,
      apiKey: decryptSecret(t.apiKey) || cfg.text.apiKey,
      baseUrl: t.baseUrl || cfg.text.baseUrl,
      model: t.model || cfg.text.model,
    };
  }
  const img = node("image");
  if (img) {
    next.image = {
      provider: ch("image").active,
      apiKey: decryptSecret(img.apiKey) || cfg.image.apiKey,
      baseUrl: img.baseUrl || cfg.image.baseUrl,
      model: img.model || cfg.image.model,
    };
  }
  const v = node("voice");
  if (v) {
    next.voice = {
      provider: ch("voice").active,
      apiKey: decryptSecret(v.apiKey) || cfg.voice.apiKey,
      baseUrl: v.baseUrl || cfg.voice.baseUrl,
      model: v.model || cfg.voice.model,
    };
  }
  const mv = node("video");
  if (mv) {
    next.motion = {
      provider: ch("video").active,
      apiKey: decryptSecret(mv.apiKey) || cfg.motion.apiKey,
      baseUrl: mv.baseUrl || cfg.motion.baseUrl,
      model: mv.model || cfg.motion.model,
    };
  }
  return next;
}

// ── 脱敏视图（永不把明文 Key 发给前端） ─────────────────────────
export function maskKey(k?: string): string | null {
  if (!k) return null;
  const s = k.trim();
  if (!s) return null;
  if (s.length <= 8) return s.slice(0, 2) + "****";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

export interface NodeView extends Omit<ChannelNode, "apiKey"> {
  apiKey?: never;
  hasKey: boolean;
  keyMask: string | null;
  /** 密钥来源：node=保存在设置文件；env=回落 .env 通道密钥（节点留空即生效）；null=未配 */
  keyFrom: "node" | "env" | null;
}

export interface SettingsView {
  settings: { version: 1; channels: Record<ChannelKey, { active: string; nodes: NodeView[] }> };
}

/** 视图 = 已保存设置（无文件时用默认表）；active 以当前生效 provider 兜底，保证「打开即所见即所得」 */
export function settingsView(current: {
  text: { provider: string; apiKey: string; baseUrl: string; model: string };
  image: { provider: string; apiKey: string; baseUrl: string; model: string };
  voice: { provider: string; apiKey: string; baseUrl: string; model: string };
  motion: { provider: string; apiKey: string; baseUrl: string; model: string };
}): SettingsView {
  const saved = loadSettings();
  const base = defaultSettings();
  const src = saved ?? base;
  const cur: Record<ChannelKey, { provider: string; apiKey: string; baseUrl: string; model: string }> = {
    text: current.text,
    image: current.image,
    video: current.motion,
    voice: current.voice,
  };
  const channels = {} as SettingsView["settings"]["channels"];
  for (const k of CHANNEL_KEYS) {
    const eff = cur[k];
    const nodesIn = src.channels[k].nodes.some((n) => n.id === eff.provider)
      ? src.channels[k].nodes
      : [
          ...src.channels[k].nodes,
          // .env 里配了自定义 provider 而设置表没有时，补一个节点保证所见即所得
          { id: eff.provider, label: eff.provider, baseUrl: eff.baseUrl, model: eff.model, apiKey: "", builtin: true, note: "来自 .env 配置" },
        ];
    const nodes: NodeView[] = nodesIn.map((n) => {
      const { apiKey, ...rest } = n;
      const key = decryptSecret(apiKey);
      // 展示回落：云端节点自身未存密钥时，.env 通道密钥就是运行时实际生效的密钥；本地引擎不联网、免密钥
      const fromEnv = !key && !LOCAL_IDS.has(n.id) && Boolean(eff.apiKey);
      return {
        ...rest,
        hasKey: Boolean(key || fromEnv),
        keyMask: maskKey(key) ?? maskKey(eff.apiKey),
        keyFrom: key ? "node" : fromEnv ? "env" : null,
      };
    });
    channels[k] = { active: eff.provider, nodes };
  }
  return { settings: { version: 1, channels } };
}
