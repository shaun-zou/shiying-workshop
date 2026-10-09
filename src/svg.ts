// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 画面引擎（离线段）
// 从《V1 诗影工坊》原型移植的水墨分镜 SVG 引擎：
//   · 16 个场景构建器（three poems 的签名场景 + 通用场景）
//   · 静态渲染（截图用，不含关键帧动画；动效由合成段的运镜承担）
// ════════════════════════════════════════════════════════════════

export interface PoemLite {
  title: string;
  author: string;
  dynasty: string;
}

export function svgWrap(inner: string): string {
  return `<svg viewBox="0 0 360 640" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">${inner}</svg>`;
}

function ridge(pts: Array<[number, number]>): string {
  return "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L") + " L360,640 L0,640 Z";
}

// ── 场景构建器（与原型逐笔对应） ─────────────────────────────────

export function sceneTitle(p: PoemLite): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="260" opacity="0.6"/>` +
      `<circle class="sc-moon-glow" cx="180" cy="168" r="88" opacity="0.5"/>` +
      `<circle class="sc-moon" cx="180" cy="168" r="33" opacity="0.92"/>` +
      `<rect class="sc-seal" x="162" y="262" width="36" height="36" rx="9"/>` +
      `<text class="sc-seal-text" x="180" y="287.5" font-size="19" text-anchor="middle">诗</text>` +
      `<text class="sc-title-text" x="180" y="368" font-size="47" text-anchor="middle" letter-spacing="12">${p.title}</text>` +
      `<text class="sc-title-sub" x="180" y="404" font-size="15" text-anchor="middle" letter-spacing="4">${p.dynasty} · ${p.author}</text>` +
      `<line class="sc-frame-thin" x1="142" y1="440" x2="218" y2="440"/>`,
  );
}

export function jyWindow(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="300" opacity="0.7"/>` +
      `<circle class="sc-moon-glow" cx="238" cy="150" r="92" opacity="0.45"/>` +
      `<circle class="sc-moon" cx="238" cy="150" r="30"/>` +
      `<g class="sc-frame"><rect x="86" y="64" width="188" height="250" rx="4"/><line x1="180" y1="64" x2="180" y2="314"/><line x1="86" y1="189" x2="274" y2="189"/></g>` +
      `<polygon class="sc-beam" points="86,314 180,314 318,640 42,640"/>` +
      `<rect class="sc-ground" y="482" width="360" height="158"/>` +
      `<rect class="sc-silhouette" x="26" y="424" width="118" height="58" rx="7" opacity="0.55"/>` +
      `<circle class="sc-frost" cx="118" cy="560" r="1.5"/><circle class="sc-frost" cx="204" cy="592" r="1.5"/><circle class="sc-frost" cx="262" cy="546" r="1.4"/>`,
  );
}

export function jyFrost(): string {
  const pts: Array<[number, number]> = [
    [52, 448], [86, 478], [122, 455], [158, 492], [196, 462], [232, 486], [268, 452], [304, 482],
    [74, 516], [128, 530], [186, 520], [244, 528], [300, 512], [44, 432], [168, 436], [286, 440], [210, 560], [120, 566],
  ];
  let dots = "";
  for (const [x, y] of pts) dots += `<circle class="sc-frost" cx="${x}" cy="${y}" r="1.5"/>`;
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="280" opacity="0.6"/>` +
      `<circle class="sc-moon-glow" cx="180" cy="140" r="94" opacity="0.42"/>` +
      `<circle class="sc-moon" cx="180" cy="140" r="31"/>` +
      `<rect class="sc-ground" y="420" width="360" height="220"/>` +
      `<path class="sc-beam" d="M150,171 L210,171 L302,420 L58,420 Z" opacity="0.5"/>` +
      dots +
      `<line class="sc-frame-thin" x1="0" y1="420" x2="360" y2="420"/>`,
  );
}

export function jyLookup(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="300" opacity="0.65"/>` +
      `<circle class="sc-moon-glow" cx="252" cy="176" r="106" opacity="0.5"/>` +
      `<circle class="sc-moon" cx="252" cy="176" r="38"/>` +
      `<path class="sc-ridge-2" d="${ridge([[0, 420], [90, 384], [170, 414], [250, 378], [360, 410]])}" opacity="0.8"/>` +
      `<path class="sc-ridge-1" d="${ridge([[0, 470], [120, 436], [230, 462], [360, 440]])}"/>` +
      `<g class="sc-silhouette"><circle cx="132" cy="430" r="19"/><path d="M96,524 C104,480 118,462 132,460 C146,462 160,480 168,524 Z"/></g>` +
      `<ellipse class="sc-mist" cx="96" cy="548" rx="122" ry="13"/>` +
      `<ellipse class="sc-mist" cx="286" cy="584" rx="130" ry="15"/>`,
  );
}

export function jyVillage(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="320" opacity="0.7"/>` +
      `<circle class="sc-moon-glow" cx="180" cy="150" r="98" opacity="0.42"/>` +
      `<circle class="sc-moon" cx="180" cy="150" r="33"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 400], [120, 362], [240, 394], [360, 370]])}" opacity="0.5"/>` +
      `<path class="sc-ridge-1" d="${ridge([[0, 470], [140, 432], [260, 458], [360, 436]])}"/>` +
      `<rect class="sc-ground" y="520" width="360" height="120"/>` +
      `<g class="sc-silhouette"><path d="M96,520 L96,486 L120,468 L144,486 L144,520 Z"/><path d="M188,520 L188,478 L216,458 L244,478 L244,520 Z"/></g>` +
      `<rect class="sc-window-light" x="110" y="494" width="8" height="9"/>` +
      `<rect class="sc-window-light" x="212" y="492" width="7" height="8" opacity="0.7"/>` +
      `<g class="sc-silhouette" opacity="0.9"><circle cx="300" cy="500" r="12"/><path d="M280,558 C284,528 292,516 300,514 C308,516 316,528 320,558 Z"/></g>` +
      `<ellipse class="sc-mist" cx="110" cy="558" rx="112" ry="12"/>` +
      `<ellipse class="sc-mist" cx="290" cy="584" rx="122" ry="14"/>`,
  );
}

export function outroMoon(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="320" opacity="0.7"/>` +
      `<circle class="sc-moon-glow" cx="180" cy="208" r="122" opacity="0.5"/>` +
      `<circle class="sc-moon" cx="180" cy="208" r="44"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 392], [110, 356], [230, 386], [360, 360]])}" opacity="0.45"/>` +
      `<path class="sc-ridge-2" d="${ridge([[0, 444], [130, 410], [250, 434], [360, 412]])}" opacity="0.7"/>` +
      `<path class="sc-ridge-1" d="${ridge([[0, 506], [150, 472], [280, 498], [360, 482]])}"/>` +
      `<ellipse class="sc-mist" cx="120" cy="540" rx="150" ry="16"/>` +
      `<ellipse class="sc-mist" cx="280" cy="576" rx="160" ry="18"/>` +
      `<g class="sc-silhouette" opacity="0.85"><circle cx="180" cy="520" r="10"/><path d="M163,576 C167,548 174,538 180,536 C186,538 193,548 197,576 Z"/></g>`,
  );
}

export function cxDawn(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="120" cy="122" r="150" opacity="0.5"/>` +
      `<circle class="sc-sun" cx="120" cy="122" r="30" opacity="0.95"/>` +
      `<g class="sc-frame"><rect x="70" y="70" width="220" height="260" rx="4"/><line x1="180" y1="70" x2="180" y2="330"/><line x1="70" y1="200" x2="290" y2="200"/></g>` +
      `<rect class="sc-beam" y="330" width="360" height="310" opacity="0.16"/>` +
      `<rect class="sc-silhouette" x="228" y="384" width="132" height="88" rx="10" opacity="0.5"/>` +
      `<rect class="sc-ground" y="520" width="360" height="120"/>` +
      `<circle class="sc-petal" cx="150" cy="560" r="2.2"/><circle class="sc-petal" cx="200" cy="592" r="2"/><circle class="sc-petal" cx="260" cy="556" r="2.4"/>`,
  );
}

export function cxBirds(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="270" cy="140" r="122" opacity="0.4"/>` +
      `<circle class="sc-sun" cx="270" cy="140" r="24" opacity="0.9"/>` +
      `<path class="sc-frame" d="M0,470 C80,430 150,420 220,436" fill="none"/>` +
      `<path class="sc-frame-thin" d="M120,432 C150,410 176,398 208,394" fill="none"/>` +
      `<g class="sc-bird">` +
      `<path d="M196,378 c6,-7 13,-7 19,0 M215,378 c6,-7 13,-7 19,0" fill="none"/>` +
      `<path d="M84,290 c6,-7 13,-7 19,0 M103,290 c6,-7 13,-7 19,0" fill="none"/>` +
      `<path d="M152,236 c5,-6 11,-6 16,0 M168,236 c5,-6 11,-6 16,0" fill="none"/>` +
      `</g>` +
      `<rect class="sc-ground" y="560" width="360" height="80"/>`,
  );
}

export function cxRain(): string {
  let rain = "";
  for (let i = 0; i < 16; i++) {
    const x = 30 + ((i * 21) % 330);
    const y = 90 + ((i * 47) % 380);
    rain += `<line class="sc-rain" x1="${x}" y1="${y}" x2="${x - 14}" y2="${y + 40}"/>`;
  }
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<rect class="sc-sky-deep" width="360" height="200" opacity="0.5"/>` +
      `<ellipse class="sc-ridge-3" cx="120" cy="118" rx="162" ry="46" opacity="0.85"/>` +
      `<ellipse class="sc-ridge-3" cx="300" cy="168" rx="152" ry="42" opacity="0.7"/>` +
      rain +
      `<g class="sc-frame-thin"><rect x="76" y="300" width="208" height="200" rx="4"/><line x1="180" y1="300" x2="180" y2="500"/></g>` +
      `<rect class="sc-ground" y="560" width="360" height="80"/>`,
  );
}

export function cxPetals(): string {
  const ground: Array<[number, number]> = [
    [60, 536], [110, 568], [170, 548], [230, 572], [290, 540], [320, 566], [140, 598], [210, 604], [80, 600], [262, 600],
  ];
  let petals = "";
  for (const [x, y] of ground) petals += `<ellipse class="sc-petal" cx="${x}" cy="${y}" rx="3.4" ry="2.2"/>`;
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="300" cy="120" r="112" opacity="0.35"/>` +
      `<path class="sc-ridge-2" d="${ridge([[0, 400], [130, 368], [250, 392], [360, 372]])}" opacity="0.55"/>` +
      `<path class="sc-silhouette" d="M98,510 L102,320 L114,320 L118,510 Z" opacity="0.55"/>` +
      `<path class="sc-frame-thin" d="M108,344 C132,322 152,314 178,310" fill="none"/>` +
      `<rect class="sc-ground" y="510" width="360" height="130"/>` +
      petals +
      `<ellipse class="sc-petal" cx="130" cy="420" rx="3" ry="2"/>` +
      `<ellipse class="sc-petal" cx="210" cy="380" rx="3" ry="2"/>` +
      `<ellipse class="sc-petal" cx="270" cy="444" rx="3" ry="2"/>`,
  );
}

export function outroDawn(): string {
  const ground: Array<[number, number]> = [[70, 474], [130, 504], [210, 490], [280, 510], [330, 482]];
  let petals = "";
  for (const [x, y] of ground) petals += `<ellipse class="sc-petal" cx="${x}" cy="${y}" rx="3.2" ry="2"/>`;
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="180" cy="258" r="152" opacity="0.55"/>` +
      `<circle class="sc-sun" cx="180" cy="258" r="46"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 410], [130, 378], [250, 402], [360, 382]])}" opacity="0.4"/>` +
      `<path class="sc-ridge-1" d="${ridge([[0, 510], [150, 478], [280, 504], [360, 488]])}"/>` +
      petals +
      `<ellipse class="sc-petal" cx="140" cy="380" rx="3" ry="2"/>` +
      `<ellipse class="sc-petal" cx="230" cy="350" rx="3" ry="2"/>` +
      `<ellipse class="sc-mist" cx="120" cy="562" rx="160" ry="16"/>`,
  );
}

export function dqSunset(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="230" cy="298" r="132" opacity="0.55"/>` +
      `<circle class="sc-sun" cx="230" cy="298" r="52" opacity="0.95"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 362], [120, 326], [250, 354], [360, 330]])}" opacity="0.45"/>` +
      `<path class="sc-ridge-1" d="${ridge([[0, 432], [150, 392], [280, 424], [360, 400]])}"/>` +
      `<path class="sc-ridge-2" d="${ridge([[278, 432], [330, 404], [360, 414]])}" opacity="0.9"/>` +
      `<ellipse class="sc-mist" cx="120" cy="472" rx="152" ry="14"/>` +
      `<rect class="sc-ground" y="560" width="360" height="80" opacity="0.6"/>`,
  );
}

export function dqRiver(): string {
  let waves = "";
  for (let i = 0; i < 5; i++) {
    const y = 432 + i * 34;
    const x = 30 + ((i * 23) % 90);
    const w = 90 + (i % 2) * 60;
    waves += `<rect class="sc-river-hi" x="${x}" y="${y}" width="${w}" height="2.4" rx="1.2"/>`;
  }
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="110" cy="196" r="122" opacity="0.4"/>` +
      `<circle class="sc-sun" cx="110" cy="196" r="36" opacity="0.9"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 330], [140, 300], [260, 322], [360, 302]])}" opacity="0.4"/>` +
      `<path class="sc-river" d="M0,420 C120,404 240,436 360,416 L360,640 L0,640 Z"/>` +
      waves +
      `<path class="sc-ridge-1" d="${ridge([[0, 586], [120, 556], [250, 582], [360, 566]])}" opacity="0.9"/>`,
  );
}

export function dqClimb(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="280" cy="140" r="112" opacity="0.4"/>` +
      `<circle class="sc-sun" cx="280" cy="140" r="26" opacity="0.85"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 420], [130, 386], [250, 410], [360, 388]])}" opacity="0.42"/>` +
      `<g class="sc-tower">` +
      `<path d="M120,520 L240,520 L226,484 L134,484 Z"/>` +
      `<path d="M132,484 L228,484 L214,448 L146,448 Z"/>` +
      `<path d="M144,448 L216,448 L204,412 L156,412 Z"/>` +
      `<path d="M158,412 L202,412 L196,384 L164,384 Z"/>` +
      `</g>` +
      `<line class="sc-frame-thin" x1="180" y1="384" x2="180" y2="352"/>` +
      `<path class="sc-frame-thin" d="M180,368 C188,360 194,356 202,354" fill="none"/>` +
      `<rect class="sc-ground" y="520" width="360" height="120"/>` +
      `<g class="sc-silhouette"><circle cx="86" cy="482" r="9"/><path d="M72,520 C76,502 81,494 86,492 C91,494 96,502 100,520 Z"/></g>`,
  );
}

export function dqSummit(): string {
  let waves = "";
  for (let i = 0; i < 3; i++) {
    const y = 520 + i * 30;
    const x = 200 + i * 40;
    waves += `<rect class="sc-river-hi" x="${x}" y="${y}" width="110" height="2.4" rx="1.2"/>`;
  }
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="150" cy="248" r="142" opacity="0.5"/>` +
      `<circle class="sc-sun" cx="150" cy="248" r="44" opacity="0.9"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 360], [120, 328], [250, 352], [360, 330]])}" opacity="0.4"/>` +
      `<path class="sc-ridge-2" d="${ridge([[0, 430], [140, 398], [270, 424], [360, 404]])}" opacity="0.6"/>` +
      `<path class="sc-river" d="M0,470 C130,454 250,486 360,468 L360,640 L0,640 Z" opacity="0.9"/>` +
      waves +
      `<g class="sc-tower"><rect x="150" y="540" width="60" height="40" rx="3"/><path d="M144,540 L216,540 L208,522 L152,522 Z"/></g>` +
      `<g class="sc-silhouette"><circle cx="180" cy="500" r="8"/><path d="M168,538 C172,522 176,514 180,512 C184,514 188,522 192,538 Z"/></g>`,
  );
}

export function outroWide(): string {
  return svgWrap(
    `<rect class="sc-sky" width="360" height="640"/>` +
      `<circle class="sc-gold-glow" cx="180" cy="298" r="162" opacity="0.5"/>` +
      `<circle class="sc-sun" cx="180" cy="298" r="52"/>` +
      `<path class="sc-ridge-3" d="${ridge([[0, 380], [110, 350], [230, 374], [360, 352]])}" opacity="0.38"/>` +
      `<path class="sc-ridge-2" d="${ridge([[0, 450], [140, 418], [270, 444], [360, 424]])}" opacity="0.58"/>` +
      `<path class="sc-river" d="M0,500 C130,484 250,516 360,498 L360,640 L0,640 Z" opacity="0.85"/>` +
      `<ellipse class="sc-mist" cx="130" cy="580" rx="172" ry="18"/>`,
  );
}

export const SCENE_BUILDERS: Record<string, (p: PoemLite) => string> = {
  title: sceneTitle,
  "jy-window": jyWindow,
  "jy-frost": jyFrost,
  "jy-lookup": jyLookup,
  "jy-village": jyVillage,
  "cx-dawn": cxDawn,
  "cx-birds": cxBirds,
  "cx-rain": cxRain,
  "cx-petals": cxPetals,
  "dq-sunset": dqSunset,
  "dq-river": dqRiver,
  "dq-climb": dqClimb,
  "dq-summit": dqSummit,
  "outro-moon": outroMoon,
  "outro-dawn": outroDawn,
  "outro-wide": outroWide,
};

/** 合法的非标题场景类型池（供任意诗词的导演分配使用） */
export const SCENE_KIND_POOL = Object.keys(SCENE_BUILDERS);

// ── 页面包装（静态渲染用；不含关键帧动画） ───────────────────────

const STAGE_CSS = `
html, body { margin: 0; padding: 0; overflow: hidden; background: #1D1813; }
svg { display: block; }
.sc-sky { fill: #2A231B; }
.sc-sky-deep { fill: #1D1813; }
.sc-moon { fill: #EFE7D5; }
.sc-moon-glow { fill: rgba(239,231,213,0.14); }
.sc-gold-glow { fill: rgba(200,165,106,0.24); }
.sc-ridge-1 { fill: #171310; }
.sc-ridge-2 { fill: #1A1611; }
.sc-ridge-3 { fill: #211B14; }
.sc-frame { fill: none; stroke: rgba(239,231,213,0.26); stroke-width: 3; }
.sc-frame-thin { fill: none; stroke: rgba(239,231,213,0.18); stroke-width: 1.5; }
.sc-beam { fill: rgba(239,231,213,0.09); }
.sc-ground { fill: #16120E; }
.sc-frost { fill: rgba(239,231,213,0.42); }
.sc-silhouette { fill: #0F0C09; }
.sc-window-light { fill: rgba(200,165,106,0.24); }
.sc-bird { fill: none; stroke: rgba(239,231,213,0.6); stroke-width: 2; stroke-linecap: round; }
.sc-petal { fill: #D8BF90; }
.sc-rain { stroke: rgba(239,231,213,0.2); stroke-width: 1.2; stroke-linecap: round; }
.sc-sun { fill: #C8A56A; }
.sc-river { fill: #322A1F; }
.sc-river-hi { fill: rgba(200,165,106,0.34); }
.sc-tower { fill: #17120D; }
.sc-mist { fill: rgba(239,231,213,0.06); }
.sc-title-text { fill: #EFE7D5; font-family: "Songti SC", "STSong", "SimSun", Georgia, serif; font-weight: 600; }
.sc-title-sub { fill: #AC9F82; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
.sc-seal { fill: #B03A2E; }
.sc-seal-text { fill: #FEFCF6; font-family: "Songti SC", "STSong", "SimSun", Georgia, serif; }
`;

/** 生成单幅场景的完整 HTML（供无头浏览器截图） */
export function scenePageHtml(svg: string, width: number, height: number): string {
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><style>` +
    STAGE_CSS +
    `html, body { width: ${width}px; height: ${height}px; }` +
    `svg { width: ${width}px; height: ${height}px; }` +
    `</style></head><body>${svg}</body></html>`
  );
}
