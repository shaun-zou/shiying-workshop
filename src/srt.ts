// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 字幕
//   buildSrt  标准字幕文件（与 V1 原型导出的 .srt 同体系）
//   buildAss  样式化字幕（大字楷体诗句 + 小字雅黑旁白，用于烧制）
// ════════════════════════════════════════════════════════════════
import type { Scene } from "./types.ts";

function srtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = Math.floor(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(mm).padStart(3, "0")}`;
}

export function sceneStarts(scenes: Scene[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const s of scenes) {
    starts.push(t);
    t += s.durMs;
  }
  return starts;
}

export function totalDurationMs(scenes: Scene[]): number {
  return scenes.reduce((sum, s) => sum + s.durMs, 0);
}

/** 标准 SRT（字幕文本 = 分镜字幕行；与原型行为一致） */
export function buildSrt(scenes: Scene[]): string {
  const starts = sceneStarts(scenes);
  let out = "";
  scenes.forEach((s, i) => {
    const start = starts[i]!;
    const end = start + s.durMs;
    out += `${i + 1}\r\n${srtTime(start)} --> ${srtTime(end)}\r\n${s.subtitle}\r\n\r\n`;
  });
  return out.trim() + "\r\n";
}

function assTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assEscape(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N").trim();
}

export interface AssOptions {
  width: number;
  height: number;
  /** 诗句大字字体名（默认 KaiTi；找不到时回退由渲染器处理） */
  poemFont?: string;
  captionFont?: string;
  /** 是否为标题镜烧诗句行（默认 true，与原型预览一致） */
  burnTitleLine?: boolean;
}

/**
 * 样式化 ASS：
 *  · Poem  —— 楷体大字，暖白，微描边，底部居中
 *  · Caption —— 雅黑小字，暖灰，位于诗句下方
 *  · 每条带 320ms 淡入淡出
 */
export function buildAss(scenes: Scene[], opts: AssOptions): string {
  const { width, height } = opts;
  const poemFont = opts.poemFont ?? "KaiTi";
  const captionFont = opts.captionFont ?? "Microsoft YaHei";
  const burnTitleLine = opts.burnTitleLine ?? true;

  const s = Math.round(width / 1080); // 相对 1080 宽的缩放（更小分辨率时缩小字号）
  const scale = Math.max(0.55, s * (height / 1920 >= 1 ? 1 : Math.min(1, width / 1080)));
  const poemSize = Math.round(84 * scale);
  const capSize = Math.round(39 * scale);
  const poemMargin = Math.round(330 * (height / 1920));
  const capMargin = Math.round(212 * (height / 1920));

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // 暖白 &H00D5E7EF  /  描边半透明深墨 &H7A120D09  /  暖灰 &H00829FAC
    `Style: Poem,${poemFont},${poemSize},&H00D5E7EF,&H00D5E7EF,&H7A120D09,&H00000000,0,0,0,0,100,100,2.5,0,1,2.2,1.4,2,70,70,${poemMargin},1`,
    `Style: Caption,${captionFont},${capSize},&H00829FAC,&H00829FAC,&H66120D09,&H00000000,0,0,0,0,100,100,0.6,0,1,1.4,0.8,2,90,90,${capMargin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const lines: string[] = [];
  const starts = sceneStarts(scenes);
  scenes.forEach((sc, i) => {
    const start = starts[i]!;
    const end = start + sc.durMs;
    const a = assTime(start + 120);
    const b = assTime(Math.max(start + 900, end - 140));
    const isTitle = sc.kind === "title";
    if (sc.subtitle && (!isTitle || burnTitleLine)) {
      lines.push(`Dialogue: 0,${a},${b},Poem,,0,0,0,,{\\fad(320,320)}${assEscape(sc.subtitle)}`);
    }
    if (sc.caption) {
      lines.push(`Dialogue: 0,${a},${b},Caption,,0,0,0,,{\\fad(320,320)}${assEscape(sc.caption)}`);
    }
  });

  return head + "\n" + lines.join("\n") + "\n";
}
