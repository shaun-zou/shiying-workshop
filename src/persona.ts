// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 人物一致性（persona）
// 「根据情景判断诗句中出现的人物是否为同一人（如作者本人）」：
//   · 若是 → 生成一段固定形象描述，逐字注入每个分镜的提示词，保证多镜人物一致；
//   · 判定来源三级：① 内置诗精修设定 → ② 关键词推断（自定义诗兜底）→ ③ 大模型（可选，见 text.ts）。
// 出镜策略两档：must=该句涉及人物行为（须出现人物）；may=写景句（如出现则须一致）。
// ════════════════════════════════════════════════════════════════
import { loadBuiltins } from "./text.ts";
import type { Analysis, BuiltinPoem, PoemPersona, Scene } from "./types.ts";

/** 人物信号词：诗句或释义中出现这些词，视为「该句涉及人物」 */
const PERSON_RE =
  /我|吾|余|予|独|孤|愁|眠|睡|醒|醉|望|看|听|闻|问|思|忆|念|想|知|觉|梦|归|登|倚|坐|立|抬|举|低|客|君|翁|叟|夫|妇|女|儿|童|兵|吏|农|渔|樵|牧|僧|游|行|人|以为|觉得|仿佛|感到/;

/** 匹配内置诗（按诗句重合度，允许个别编辑差异） */
export function matchBuiltinPoem(analysis: Analysis): BuiltinPoem | null {
  const set = new Set(analysis.lines);
  for (const p of Object.values(loadBuiltins())) {
    const hit = p.lines.filter((l) => set.has(l)).length;
    if (hit >= Math.max(2, Math.ceil(p.lines.length * 0.75))) return p;
  }
  return null;
}

/** 关键词推断（自定义诗兜底）：识别单一主体 → 生成通用但可复用的形象描述 */
export function heuristicPersona(analysis: Analysis): PoemPersona | null {
  const texts = analysis.lines.map((l, i) => `${l}。${analysis.gloss[i] ?? ""}`);
  const n = analysis.lines.length;
  if (!n) return null;

  // 单一「他者」主角（咏人 / 叙事诗）
  const subjectCats = [
    {
      re: /农夫|田家|蚕妇|耕|锄禾|插秧|庄稼|种田/,
      who: "诗中的农人（同一人）",
      look: "一位古代农夫：中年男子，短褐布衫、袖口挽起，肤色黧黑，肩搭汗巾，面容质朴，身形结实。",
    },
    {
      re: /渔翁|渔者|钓|樵|牧童|采莲/,
      who: "诗中的渔樵（同一人）",
      look: "一位古代渔者：披蓑戴笠，素色短打，面容沧桑平静，身形精瘦。",
    },
  ];
  let subject: { who: string; look: string } | null = null;
  for (const c of subjectCats) {
    if (texts.some((t) => c.re.test(t))) {
      subject = { who: c.who, look: c.look };
      break;
    }
  }

  // 抒情主人公（作者本人）信号
  const authorCount = texts.filter((t) => PERSON_RE.test(t)).length;
  const authorStrong = authorCount >= Math.max(2, Math.ceil(n * 0.5));

  if (subject && !authorStrong) return { consistent: true, who: subject.who, look: subject.look, basis: "heuristic" };
  if (authorStrong) {
    const dyn = /^(先秦|汉|魏|晋|南北朝|隋|唐|五代|宋|元|明|清)$/.test(analysis.dynasty || "")
      ? analysis.dynasty
      : "古代";
    return {
      consistent: true,
      who: "作者本人（抒情主人公）",
      look: `一位${dyn}文人（本诗作者）：束发髻，身着素色交领长衫，面容清雅、神情专注沉静，身姿清瘦挺拔。`,
      basis: "heuristic",
    };
  }
  return null;
}

/** 主入口：已有判定原样返回（含 null 与用户手改）；未判定时 → 内置匹配 → 关键词推断 */
export function derivePersona(analysis: Analysis): PoemPersona | null {
  if (analysis.persona !== undefined) return analysis.persona;
  const b = matchBuiltinPoem(analysis);
  if (b?.persona) return { ...b.persona, basis: "curated" };
  return heuristicPersona(analysis);
}

/** 逐镜出镜判定：must=本镜须出现人物；may=如出现则须一致（标题/尾声固定为 may） */
export function personaAppearance(scene: Scene): "must" | "may" {
  if (scene.kind === "title" || scene.kind.startsWith("outro")) return "may";
  return PERSON_RE.test(`${scene.subtitle}。${scene.caption ?? ""}`) ? "must" : "may";
}

/** 生成注入图像提示词的人物一致性段落（无设定时返回空串） */
export function personaPromptBlock(persona: PoemPersona | null | undefined, scene: Scene): string {
  if (!persona || !persona.consistent || !String(persona.look ?? "").trim()) return "";
  const base = `【人物设定 · 全片同一人】人物为${persona.who}；固定形象：${persona.look}（所有分镜中的面貌、发型、服装必须与此完全一致）。`;
  if (personaAppearance(scene) === "must") {
    return `${base}本镜画面须出现该人物，姿态与文案语义相符；以中远景或侧身、半侧身出现，避免正面特写；画面中不出现其他人物。`;
  }
  return `${base}若本镜画面出现人物，必须是该人物。`;
}
