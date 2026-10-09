// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 文本工序
// offline：内置数据 / 结构解析（离线）
// glm | deepseek | openai：OpenAI 兼容 chat/completions（JSON 输出）
// 失败时自动降级，并在 tips 里说明原因
// ════════════════════════════════════════════════════════════════
import path from "node:path";
import { ROOT, getConfig } from "./config.ts";
import { readJson } from "./util.ts";
import type { Analysis, BuiltinPoem, PoemNote, PoemPersona, PoemScript } from "./types.ts";

// ── 内置诗词 ────────────────────────────────────────────────────
let builtinsCache: Record<string, BuiltinPoem> | null = null;

export function loadBuiltins(): Record<string, BuiltinPoem> {
  if (!builtinsCache) {
    builtinsCache = readJson<Record<string, BuiltinPoem>>(path.join(ROOT, "data", "poems.json"));
  }
  return builtinsCache;
}

export function findBuiltinByText(text: string): BuiltinPoem | null {
  const t = text.replace(/\s/g, "");
  if (!t) return null;
  for (const p of Object.values(loadBuiltins())) {
    if (t.includes(p.title)) return p;
    for (const line of p.lines) if (t.includes(line)) return p;
  }
  return null;
}

export function fromBuiltin(b: BuiltinPoem, input?: string): Analysis {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    dynasty: b.dynasty,
    lines: [...b.lines],
    gloss: [...b.gloss],
    notes: b.notes.map((n) => ({ ...n })),
    script: {
      name: b.script.name,
      hook: b.script.hook,
      beats: [...b.script.beats],
      outro: b.script.outro,
    },
    origin: {
      input: input ?? `builtin:${b.id}`,
      text: "builtin",
      provider: "offline",
      tips: [],
    },
  };
}

// ── 结构解析（未知诗词的离线降级：纯朗诵版） ─────────────────────
const DYN_WORDS = ["先秦", "春秋", "战国", "汉", "魏", "晋", "南北朝", "隋", "唐", "五代", "宋", "元", "明", "清", "现代", "当代"];

export interface StructureHints {
  title?: string;
  author?: string;
  dynasty?: string;
}

export function structureParse(raw: string, hints: StructureHints): Analysis {
  let text = raw.replace(/\r/g, "").trim();

  // 1) 标题
  let title = hints.title?.trim() ?? "";
  const mTitle = /《([^》]{1,40})》/.exec(text);
  if (!title && mTitle) title = mTitle[1]!.trim();
  if (mTitle) text = text.replace(mTitle[0], "");

  // 2) 作者 / 朝代（只在前两行与最后两行里找，避免误伤诗句）
  let author = hints.author?.trim() ?? "";
  let dynasty = hints.dynasty?.trim() ?? "";
  if (!author || !dynasty) {
    const rows = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const probe = [...rows.slice(0, 2), ...rows.slice(-2)];
    const dynRe = new RegExp(`[【（(\\[]?\\s*(${DYN_WORDS.join("|")})\\s*[】）)\\]]?\\s*[·•.、:：\\s—–-]{0,3}([\\u4e00-\\u9fa5]{2,4})`);
    for (const row of probe) {
      if (row.length > 14) continue;
      const m = dynRe.exec(row);
      if (m) {
        if (!dynasty) dynasty = m[1]!.trim();
        if (!author && m[2]) author = m[2]!.trim();
        text = text.replace(row, " ");
        break;
      }
    }
    // 兜底：仅作者 ——「李白《静夜思》」「—— 李白」等
    if (!author) {
      const mAuthor = /[—–\-]{1,2}\s*([\u4e00-\u9fa5]{2,4})\s*$/.exec(rows[rows.length - 1] ?? "");
      if (mAuthor) {
        author = mAuthor[1]!.trim();
        text = text.replace(rows[rows.length - 1]!, " ");
      }
    }
  }

  // 3) 诗句切分
  const clauses = text
    .split(/[，。；;！!？?、\n\s]+/)
    .map((s) => s.replace(/[《》「」“”"'（）()【】]/g, "").trim())
    .filter((s) => s.length >= 2 && /[\u4e00-\u9fa5]/.test(s));

  const lines = clauses.filter((s) => s.length <= 16);
  const effective = lines.length > 0 ? lines : clauses;

  const tips: string[] = [];
  if (!author && !dynasty) tips.push("未识别到朝代与作者，会用「佚名」占位（可通过 --author/--dynasty 指定）");
  tips.push(
    "未接入大模型：本片为「纯朗诵版」（诗句逐句成像 + 朗诵）。配置 SHIYING_TEXT_PROVIDER=glm（或 deepseek/openai）+ API Key 后，可自动生成逐句释义、背景知识与故事化文案。",
  );

  return {
    id: "custom",
    title: title || effective[0]?.slice(0, 8) || "无题",
    author: author || hints.author || "佚名",
    dynasty: dynasty || hints.dynasty || "",
    lines: effective.length ? effective : ["未识别到诗句内容"],
    gloss: effective.map(() => ""),
    notes: [],
    script: null,
    origin: { input: raw.slice(0, 80), text: "structure", provider: "offline", tips },
  };
}

// ── 大模型（OpenAI 兼容） ───────────────────────────────────────
interface ChatConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

async function callChat(cfg: ChatConfig, system: string, user: string, timeoutMs = 120000): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error(`${cfg.provider} 需要 API Key：请设置 SHIYING_TEXT_API_KEY`);
  }
  if (!cfg.baseUrl) throw new Error(`${cfg.provider} 缺少接口地址（SHIYING_TEXT_BASE_URL）`);
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.85,
      max_tokens: 2600,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${cfg.provider} 接口返回 ${res.status}：${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${cfg.provider} 返回内容为空`);
  return content;
}

function parseJsonLoose(raw: string): unknown {
  let t = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

const SYSTEM_PROMPT = [
  "你是一位古诗词研究与短视频文案专家，为「诗影工坊」创作古诗词短视频的解析内容。",
  "你的输出必须是严格的 JSON（UTF-8，不要 markdown 代码块、不要任何解释文字），结构如下：",
  "{\"title\":\"诗题\",\"author\":\"作者\",\"dynasty\":\"朝代\",\"lines\":[\"逐句原文（不含标点）\"],\"gloss\":[\"每句现代汉语释义，与 lines 一一对应\"],\"notes\":[{\"key\":\"life\",\"label\":\"作者生平\",\"title\":\"卡片小标题\",\"text\":\"60-120字\"},{\"key\":\"context\",\"label\":\"创作背景\",\"title\":\"卡片小标题\",\"text\":\"60-120字\"},{\"key\":\"motif\",\"label\":\"意象与典故\",\"title\":\"卡片小标题\",\"text\":\"60-120字\",\"span\":true}],\"script\":{\"name\":\"3-8字的故事化标题\",\"hook\":\"开场旁白，30-60字，有钩子\",\"beats\":[\"与每句诗一一对应的旁白，40-80字，口语化、有画面感\"],\"outro\":\"收尾旁白，40-80字，有余韵\"},\"persona\":{\"consistent\":true,\"who\":\"诗句中的人物是谁（如「作者本人——青年李白」）；若全诗并非同一人物则填 false\",\"look\":\"该人物的固定形象描述（年龄段、发型发色、服装制式与颜色、气质，40-80字），所有分镜配图将逐字使用以保证人物一致\"}}",
  "要求：",
  "1. 若输入是散文或格式不整，也要合理切分为诗句行；维持原文用字，不改写诗句。",
  "2. gloss 的数量必须与 lines 完全相同；script.beats 的数量也必须与 lines 完全相同。",
  "3. 所有内容使用简体中文；语气克制、有质感，避免网络流行语。",
  "4. 如果无法确定作者/朝代，填「佚名」/「未知」。",
  "5. 根据诗的情景判断诗句中出现的人物是否为同一人（多为作者本人）：若是，consistent 填 true 并给出固定形象描述 look；若并非同一人（如送别诗出现两位人物），consistent 填 false 且 look 留空。",
].join("\n");

export function normalizeLlmAnalysis(data: unknown, fallbackInput: string, provider: string): Analysis {
  const d = data as Record<string, unknown>;
  const linesRaw = Array.isArray(d.lines) ? d.lines : [];
  const lines = linesRaw.map((s) => String(s).replace(/[，。；！？、\s]/g, "")).filter((s) => s.length > 0);
  if (lines.length === 0) throw new Error("模型未返回诗句（lines 为空）");

  const glossRaw = Array.isArray(d.gloss) ? d.gloss : [];
  const gloss = lines.map((_, i) => String(glossRaw[i] ?? ""));

  const notesRaw = Array.isArray(d.notes) ? d.notes : [];
  const notes: PoemNote[] = notesRaw.slice(0, 4).map((n, i) => {
    const o = n as Record<string, unknown>;
    return {
      key: String(o.key ?? ["life", "context", "motif", "extra"][i] ?? `note-${i}`),
      label: String(o.label ?? "注释"),
      title: String(o.title ?? ""),
      text: String(o.text ?? ""),
      span: Boolean(o.span) || i === notesRaw.length - 1,
    };
  });

  let script: PoemScript | null = null;
  const s = d.script as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    const beats = Array.isArray(s.beats) ? s.beats.map((b) => String(b)) : [];
    const hook = String(s.hook ?? "");
    const outro = String(s.outro ?? "");
    if (hook || beats.length || outro) {
      script = {
        name: String(s.name ?? "未命名"),
        hook,
        beats: lines.map((_, i) => beats[i] ?? ""),
        outro,
      };
    }
  }

  let persona: PoemPersona | null | undefined;
  const pd = d.persona as Record<string, unknown> | undefined;
  if (pd && typeof pd === "object") {
    const look = String(pd.look ?? "").trim();
    persona =
      pd.consistent === true && look
        ? { consistent: true, who: String(pd.who ?? "").trim() || "同一人物", look, basis: "llm" }
        : null;
  }

  return {
    id: "custom",
    title: String(d.title ?? "").trim() || "无题",
    author: String(d.author ?? "").trim() || "佚名",
    dynasty: String(d.dynasty ?? "").trim() || "",
    lines,
    gloss,
    notes,
    script,
    persona,
    origin: { input: fallbackInput.slice(0, 80), text: "llm", provider, tips: [] },
  };
}

// ── 主入口 ──────────────────────────────────────────────────────
export interface AnalyzeInput {
  poemId?: string;
  text?: string;
  title?: string;
  author?: string;
  dynasty?: string;
}

export async function analyzeText(input: AnalyzeInput): Promise<Analysis> {
  const cfg = getConfig().text;

  // ① 指定内置诗词
  if (input.poemId) {
    const b = loadBuiltins()[input.poemId];
    if (!b) {
      throw new Error(`内置诗词不存在: ${input.poemId}（可用: ${Object.keys(loadBuiltins()).join(" / ")}）`);
    }
    return fromBuiltin(b);
  }

  const raw = (input.text ?? "").trim();
  if (!raw) throw new Error("请输入诗词文本（--text 或 --poem）");

  // ② offline 路径
  if (cfg.provider === "offline") {
    const hit = findBuiltinByText(raw);
    if (hit) return fromBuiltin(hit, raw);
    return structureParse(raw, input);
  }

  // ③ 大模型路径（失败自动降级）
  const hit = findBuiltinByText(raw);
  try {
    const content = await callChat(cfg, SYSTEM_PROMPT, `请为下面这首诗词生成解析内容：\n\n${raw}`);
    const data = parseJsonLoose(content);
    const analysis = normalizeLlmAnalysis(data, raw, cfg.provider);
    // 用户给了明确的标题/作者信息时优先采用
    if (input.title) analysis.title = input.title;
    if (input.author) analysis.author = input.author;
    if (input.dynasty) analysis.dynasty = input.dynasty;
    return analysis;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (hit) {
      const a = fromBuiltin(hit, raw);
      a.origin.tips.push(`大模型调用失败，已改用内置数据：${msg}`);
      return a;
    }
    const a = structureParse(raw, input);
    a.origin.tips = [`大模型调用失败（${msg}），已降级为纯朗诵版`, ...a.origin.tips];
    return a;
  }
}
