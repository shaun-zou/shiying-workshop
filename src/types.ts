// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 领域类型定义
// 四道工序（文本 → 画面 → 声音 → 合成）之间的数据契约都写在这里
// ════════════════════════════════════════════════════════════════

/** 韵白 = 内置诗词的完整数据（data/poems.json） */
export interface BuiltinPoem {
  id: string;
  title: string;
  author: string;
  dynasty: string;
  lines: string[];
  gloss: string[];
  notes: PoemNote[];
  script: PoemScript;
  sceneDefs: SceneDef[];
  /** 人物一致性（内置精修设定；判定来源记为 curated） */
  persona?: Omit<PoemPersona, "basis">;
}

export interface SceneDef {
  kind: string;
  label: string;
  dur: number; // 设计时长（毫秒，配音更长时以配音为准）
}

export interface PoemNote {
  key: string;
  label: string;
  title: string;
  text: string;
  span?: boolean;
}

export interface PoemScript {
  name: string;
  hook: string;
  beats: string[];
  outro: string;
}

/** 人物一致性设定：判断诗中人物是否为同一人（如作者本人），并给出全片复用的固定形象 */
export interface PoemPersona {
  /** 是否为同一人（true 才启用跨镜一致性） */
  consistent: boolean;
  /** 人物是谁（如「作者本人——青年李白」） */
  who: string;
  /** 固定形象描述：所有分镜逐字使用，保证人物外观一致 */
  look: string;
  /** 判定来源：curated=内置精修 / heuristic=关键词推断 / llm=大模型 / manual=用户手改 */
  basis: "curated" | "heuristic" | "llm" | "manual";
}

/** 文本工序产物：一首诗的完整解析 */
export interface Analysis {
  id: string;
  title: string;
  author: string;
  dynasty: string;
  lines: string[];
  gloss: string[];
  notes: PoemNote[];
  script: PoemScript | null; // null = 纯朗诵版（未接大模型时对未知诗词的降级）
  origin: AnalysisOrigin;
  /** 人物一致性：undefined=未判定（按诗句自动推导）；null=已判定无统一人物；对象=启用 */
  persona?: PoemPersona | null;
}

export interface AnalysisOrigin {
  input: string;
  text: "builtin" | "structure" | "llm" | "edited";
  provider: string;
  tips: string[]; // 提示用户注意的降级信息
}

/** 分镜（画面工序的输入、合成工序的底稿） */
export interface Scene {
  index: number;
  kind: string; // 场景类型；svg 引擎按 kind 出画、seedream 按 kind 取提示词
  label: string;
  subtitle: string; // 大字幕（诗句 / 标题）
  caption: string; // 小字幕（旁白 / 释义）
  narrationSegments: string[]; // 配音分段（停顿节奏由分段实现）
  minDurMs: number; // 设计时长（下限）
  durMs: number; // 实际时长（配音后确定）
  image?: string; // 本地图片路径
  audio?: string; // 本地配音路径（wav）
  audioDurMs?: number;
}

/** 运行参数（CLI / 服务端 / 流水线共用） */
export interface RunOptions {
  poemId?: string;
  text?: string;
  title?: string;
  author?: string;
  dynasty?: string;
  textProvider?: string;
  imageProvider?: string;
  voiceProfile?: string; // yunque | qingzheng | songfeng | none
  voiceProvider?: string; // sapi | openai | none
  narration?: "both" | "line"; // both = 诗句 + 旁白；line = 只念诗句
  bgm?: string; // guqin | rain | none
  size?: string; // 1080x1920 | 720x1280
  fps?: number;
  outRoot?: string;
  keepWatermark?: boolean;
  concurrency?: number;
  /** 传入已（被用户）编辑过的解析，重新合成时使用 */
  analysis?: Analysis;
  /** 复用某次任务的图片（编辑重合成时避免重复出图） */
  reuseImagesFrom?: string;
  /** 忽略图片缓存与复用，重新生成全部分镜图（显式全量重出） */
  freshImages?: boolean;
  /** 复用某次任务的配音（按段文本哈希命中缓存） */
  reuseAudioFrom?: string;
}

/** 任务清单（manifest.json） */
export interface Manifest {
  jobId: string;
  createdAt: string;
  providers: { text: string; image: string; voice: string; bgm: string };
  size: string;
  fps: number;
  poem: { title: string; author: string; dynasty: string; lines: string[] };
  totalMs: number;
  scenes: Array<{
    index: number;
    kind: string;
    label: string;
    subtitle: string;
    caption: string;
    startMs: number;
    durMs: number;
    image: string | null;
    audio: string | null;
  }>;
  files: {
    video: string;
    srt: string;
    ass: string;
    cover: string;
    narration: string | null;
    bgm: string | null;
    analysis: string;
  };
  tips: string[];
}

/** 流水线事件（CLI 打印 / 服务端 SSE 广播） */
export interface JobEvent {
  type: "stage" | "log" | "done" | "error";
  stage?: StageId;
  status?: "start" | "progress" | "done" | "skip";
  progress?: number; // 阶段内进度 0..1
  overall?: number; // 总进度 0..1
  message?: string;
  data?: unknown;
}

export type StageId = "text" | "scenes" | "images" | "voice" | "compose";

export const STAGE_ORDER: StageId[] = ["text", "scenes", "images", "voice", "compose"];

export const STAGE_LABELS: Record<StageId, string> = {
  text: "文本工序",
  scenes: "分镜工序",
  images: "画面工序",
  voice: "声音工序",
  compose: "合成工序",
};

export type EventSink = (ev: JobEvent) => void;
