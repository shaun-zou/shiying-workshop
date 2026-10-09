// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 分镜工序（导演层）
// 解析 → 分镜数组：标题镜 + 逐句镜 + 尾声镜；
// 任意诗词按关键词做「通用导演」分配场景类型
// ════════════════════════════════════════════════════════════════
import type { Analysis, BuiltinPoem, Scene } from "./types.ts";

const DEFAULT_DURS = { title: 4200, line: 5000, outro: 6000 };

// ── 关键词 → 场景类型（按优先级从上到下） ────────────────────────
const KIND_RULES: Array<{ re: RegExp; kind: string }> = [
  { re: /故乡|家乡|故园|思乡|归/, kind: "jy-village" },
  { re: /霜/, kind: "jy-frost" },
  { re: /月|明月|明月光/, kind: "jy-window" },
  { re: /窗|床|帘/, kind: "jy-window" },
  { re: /望|举头|抬头|极目|千里目/, kind: "jy-lookup" },
  { re: /楼|登|阁|台/, kind: "dq-climb" },
  { re: /花|落红|落花|残红/, kind: "cx-petals" },
  { re: /鸟|啼|鸣|莺|燕|雁/, kind: "cx-birds" },
  { re: /雨|风|声|雷/, kind: "cx-rain" },
  { re: /晓|春眠|晨|朝/, kind: "cx-dawn" },
  { re: /河|海|江|流|浪|潮/, kind: "dq-river" },
  { re: /日|斜阳|夕阳|落|暮|晚/, kind: "dq-sunset" },
  { re: /山|云|峰|岭/, kind: "jy-frost" },
  { re: /酒|歌|醉|舞/, kind: "cx-dawn" },
  { re: /雪|冬|寒|冰/, kind: "jy-frost" },
  { re: /夜|眠|梦/, kind: "jy-window" },
];

// 没有命中关键词时的兜底池（按行序轮转）
const FALLBACK_POOL = ["jy-window", "dq-sunset", "cx-birds", "dq-river", "cx-petals", "jy-lookup"];

// 情绪 → 尾声镜选择
function outroKindFor(analysis: Analysis): string {
  const all = analysis.lines.join("");
  if (/春|花|晓|暖|蝶|燕/.test(all)) return "outro-dawn";
  if (/山|河|海|日|云|天|千|里|楼/.test(all)) return "outro-wide";
  return "outro-moon";
}

/** 为任意诗词的每一句分配场景类型（同类场景尽量不重复，未命中关键词时走兑底池） */
export function assignLineKinds(lines: string[]): string[] {
  const used = new Set<string>();
  return lines.map((line, i) => {
    for (const rule of KIND_RULES) {
      if (rule.re.test(line)) {
        // 该类型已用过时，换一个未用过的兑底类型，避免画面重复
        if (used.has(rule.kind)) {
          const alt = FALLBACK_POOL.find((k) => !used.has(k) && k !== rule.kind);
          if (alt) {
            used.add(alt);
            return alt;
          }
        }
        used.add(rule.kind);
        return rule.kind;
      }
    }
    const pick = FALLBACK_POOL[i % FALLBACK_POOL.length]!;
    used.add(pick);
    return pick;
  });
}

export interface BuildScenesOptions {
  /** both = 诗句+旁白都念；line = 只念诗句 */
  narration?: "both" | "line";
}

/**
 * 由解析产物构建分镜数组。
 * 内置诗词走 sceneDefs（与原型逐镜一致）；任意诗词走通用导演。
 */
export function buildScenes(
  analysis: Analysis,
  builtin: BuiltinPoem | null,
  opts: BuildScenesOptions = {},
): Scene[] {
  const narrationMode = opts.narration ?? "both";
  const lines = analysis.lines;
  const script = analysis.script;
  const scenes: Scene[] = [];

  const defs = builtin ? builtin.sceneDefs : null;
  const lineKinds = defs
    ? lines.map((_, i) => defs[i + 1]?.kind ?? "jy-window")
    : assignLineKinds(lines);
  const outroKind = defs ? defs[lines.length + 1]?.kind ?? "outro-moon" : outroKindFor(analysis);

  const mk = (index: number, kind: string, label: string, subtitle: string, caption: string, segs: string[], minDur: number): Scene => ({
    index,
    kind,
    label,
    subtitle,
    caption,
    narrationSegments: segs.filter((s) => s && s.trim().length > 0),
    minDurMs: minDur,
    durMs: minDur,
  });

  // ① 标题镜
  const titleSubtitle = `《${analysis.title}》 · ${analysis.dynasty} · ${analysis.author}`;
  scenes.push(
    mk(
      0,
      "title",
      defs?.[0]?.label ?? "序",
      titleSubtitle,
      script?.hook ?? "",
      script?.hook ? [script.hook] : [],
      defs?.[0]?.dur ?? DEFAULT_DURS.title,
    ),
  );

  // ② 逐句镜（旁白 / 字幕 / 画面主体使用「逐句释义」；开场与收尾保持故事文案）
  lines.forEach((line, i) => {
    const gloss = (analysis.gloss[i] ?? "").trim();
    const beat = script && i < script.beats.length ? script.beats[i] : "";
    const caption = gloss || beat; // 释义缺失时回退故事文案
    const segs = narrationMode === "both" ? [line, caption] : [line];
    scenes.push(
      mk(
        i + 1,
        lineKinds[i],
        defs?.[i + 1]?.label ?? line.slice(0, 8),
        line,
        caption,
        segs,
        defs?.[i + 1]?.dur ?? DEFAULT_DURS.line,
      ),
    );
  });

  // ③ 尾声镜（字幕回到最后一句，旁白用收尾文案）
  const lastLine = lines[lines.length - 1] ?? analysis.title;
  scenes.push(
    mk(
      lines.length + 1,
      outroKind,
      defs?.[lines.length + 1]?.label ?? "尾声",
      lastLine,
      script?.outro ?? "",
      script?.outro ? [script.outro] : narrationMode === "both" ? [] : [lastLine],
      defs?.[lines.length + 1]?.dur ?? DEFAULT_DURS.outro,
    ),
  );

  return scenes;
}
