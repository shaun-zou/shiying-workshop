// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 画面提示词（Seedream / CogView / OpenAI 图像通用）
// 设计原则（2026-09 修订）：**文案（旁白）是画面的唯一语义来源** ——
//   · 「画面主体」取自该镜文案，最高优先；与文案矛盾的元素不得出现；
//   · 「构图与氛围参考」只给构图 / 光线 / 气氛，不写死具体物件（避免与编辑后的文案冲突）；
//   · 「全片风格锚」只保证风格与色调统一；
//   · 「人物一致性」在本模块统一注入：诗中人物为同一人时，逐字写入固定形象（见 persona.ts）；
//   · 纯朗诵版（无文案）时，画面主体回退为诗句本身。
// ════════════════════════════════════════════════════════════════
import type { PoemPersona, Scene } from "./types.ts";
import { personaPromptBlock } from "./persona.ts";

/** 全片统一的风格锚点（只约束风格与色调，不引入具体物件） */
export const STYLE_ANCHOR =
  "新中式水墨意境插画，古诗词配图。竖向 9:16 构图，大面积留白，宣纸质感；" +
  "色调统一：深墨夜色、暖月白、少量朱砂红点缀，低饱和，静谧克制的电影感。" +
  "画面中不要出现任何文字、书法、印章、logo 或水印。";

/**
 * 分镜类型的「构图与氛围参考」（与 svg.ts 的场景类型一一对应）。
 * 注意：此处只描述构图、光线与气氛，**不写死具体物件** ——
 * 具体内容（人物、物件、动作）一律以该镜文案为准，避免文案修改后出现矛盾元素。
 */
const KIND_COMPOSITIONS: Record<string, string> = {
  title: "一轮圆月悬于层叠远山之上，天地开阔的封面式构图，雾气轻漫，庄重安定",
  "jy-window": "夜色近景，月光从一侧漫入，光影分界清晰，清冷安静，大面积留白，不看全貌",
  "jy-frost": "月光洒满地面，泛着如薄霜的白，地面微微发亮，清冷夜色，远山淡影，近景俯视",
  "jy-lookup": "一人背影剪影仰望夜空，明月高悬，衣袂被夜风吹动，薄雾流动，仰视构图",
  "jy-village": "月下的村舍剪影错落有致，几点暖黄灯火，远山连绵，雾气浮动",
  "cx-dawn": "清晨暖光从一侧漫入，光束里浮着微尘，温暖朦胧，柔软低对比，大面积留白",
  "cx-birds": "春日枝头与飞鸟，晨光里花瓣轻颤，空气透明发亮，轻盈明亮",
  "cx-rain": "夜色里成串雨丝垂落，地面积水映出微光，远处屋舍剪影，朦胧安静",
  "cx-petals": "晨雨初歇，满地落花，一树残花在风里轻颤，湿润的地面，惜春的静美",
  "dq-sunset": "落日挨着群山缓缓沉落，天边铺开最后一层金红，山脊线与余晖层层叠叠",
  "dq-river": "大河奔流，水面映着金色的落日波光，河岸开阔辽远，气势壮阔而安静",
  "dq-climb": "暮色中高处的楼阁剪影，一人拾级而上的身影，云雾在山腰流转，仰视气势",
  "dq-summit": "高处远眺，千里山河尽收眼底，落日与大河在天际交汇，气象开阔",
  "outro-moon": "一轮圆月悬于群山与云海之上，天地辽阔，雾气缓缓浮动，余韵悠长",
  "outro-dawn": "春日的朝阳从山峦间升起，花瓣在风中轻扬，暖色调，温柔辽远",
  "outro-wide": "天地一望，落日、大河、群山连成辽远的一条线，气势开阔，余韵悠长",
};

const IMAGERY: Array<{ re: RegExp; text: string }> = [
  { re: /月|明/, text: "明月与夜空" },
  { re: /山|峰|岭/, text: "层叠远山" },
  { re: /水|河|江|海|流|浪|潮/, text: "江河水面" },
  { re: /花|红/, text: "花枝与落花" },
  { re: /雨/, text: "细雨与水光" },
  { re: /风/, text: "风中草木" },
  { re: /鸟|啼|鸣|燕|雁|莺/, text: "飞鸟掠过" },
  { re: /云|雾/, text: "云雾流转" },
  { re: /楼|阁|台/, text: "高处古楼" },
  { re: /树|林|柳|松|竹/, text: "疏林与枝叶" },
  { re: /雪|寒/, text: "清寒雪意" },
  { re: /舟|船|帆/, text: "一叶小舟" },
  { re: /灯|烛/, text: "一点灯火" },
  { re: /窗|帘/, text: "窗影与光" },
  { re: /夜|眠|梦/, text: "安静夜色" },
];

/** 未知场景类型的构图兜底（词取自该镜自身的诗句与文案，不会与文案冲突） */
function genericFromText(text: string): string {
  const hits = IMAGERY.filter((m) => m.re.test(text)).map((m) => m.text).slice(0, 3);
  return hits.length ? `${hits.join("、")}，简笔意境，留白构图` : "远山与云雾的简笔意境，留白构图";
}

export interface PoemBrief {
  title: string;
  author: string;
  dynasty: string;
}

/** 为单个分镜生成图像提示词（poem.persona 存在时注入跨镜人物一致性约束） */
export function sceneImagePrompt(poem: PoemBrief & { persona?: PoemPersona | null }, scene: Scene): string {
  const composition = KIND_COMPOSITIONS[scene.kind] ?? genericFromText(scene.subtitle + (scene.caption ?? ""));
  const caption = (scene.caption ?? "").trim().slice(0, 120);
  const subject = caption
    ? `画面主体（最高优先，忠实呈现文案描述的场景与物件；与文案矛盾的元素不得出现）：${caption}${/[。！？!?]$/.test(caption) ? "" : "。"}`
    : `画面主体：${scene.subtitle}（诗句意象，简洁呈现）。`;
  const personaBlock = personaPromptBlock(poem.persona ?? null, scene);
  const titleNote = scene.kind === "title" ? "这是全片封面镜，为画面上方留出天空，构图端庄。" : "";
  return (
    `${STYLE_ANCHOR}\n` +
    `${subject}\n` +
    (personaBlock ? `${personaBlock}\n` : "") +
    `构图与氛围参考（仅用于构图、光线与气氛；若与文案冲突，以文案为准并省略冲突元素）：${composition}。${titleNote}\n` +
    `出处：古诗《${poem.title}》（${poem.dynasty}·${poem.author}），同一首诗的画面，风格与色调需与全片严格一致。`
  );
}
