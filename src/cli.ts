// ════════════════════════════════════════════════════════════════
// 诗影工坊 · 命令行入口
//   node src/cli.ts check             环境体检
//   node src/cli.ts list              列出内置诗词
//   node src/cli.ts run [options]     跑一首诗的完整流水线（出 MP4）
//   node src/cli.ts batch             批量跑内置诗词
//   node src/cli.ts studio            启动本地工作台（V2 网页面板）
// ════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import { loadBuiltins } from "./text.ts";
import type { JobEvent, RunOptions } from "./types.ts";
import { STAGE_LABELS } from "./types.ts";
import { C, log, findBrowser, findFfmpeg, run } from "./util.ts";

interface CliArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[0] ?? "help";
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, options, positionals };
}

/** CLI 参数 → 环境变量（各工序通过 getConfig 读取） */
function applyOptions(options: Record<string, string | boolean>): void {
  const asEnv: Array<[string, string | undefined]> = [
    ["image", "SHIYING_IMAGE_PROVIDER"],
    ["text-provider", "SHIYING_TEXT_PROVIDER"],
    ["voice-provider", "SHIYING_VOICE_PROVIDER"],
    ["size", "SHIYING_SIZE"],
    ["out", "SHIYING_OUT"],
  ];
  for (const [opt, env] of asEnv) {
    const v = options[opt];
    if (typeof v === "string" && env) process.env[env] = v;
  }
  if (options["crop-watermark"] === true) process.env.SHIYING_KEEP_WATERMARK = "0";
}

function runOptionsFromArgs(args: CliArgs): RunOptions {
  const o = args.options;
  const text = typeof o.text === "string" ? o.text : undefined;
  const file = typeof o.file === "string" ? o.file : undefined;
  let inputText = text;
  if (file) inputText = fs.readFileSync(file, "utf8");
  return {
    poemId: typeof o.poem === "string" ? o.poem : args.positionals[0],
    text: inputText,
    title: typeof o.title === "string" ? o.title : undefined,
    author: typeof o.author === "string" ? o.author : undefined,
    dynasty: typeof o.dynasty === "string" ? o.dynasty : undefined,
    textProvider: typeof o["text-provider"] === "string" ? o["text-provider"] : undefined,
    imageProvider: typeof o.image === "string" ? o.image : undefined,
    voiceProfile: typeof o.voice === "string" ? o.voice : undefined,
    narration: o.narration === "line" ? "line" : "both",
    bgm: typeof o.bgm === "string" ? o.bgm : undefined,
    size: typeof o.size === "string" ? o.size : undefined,
    outRoot: typeof o.out === "string" ? o.out : undefined,
    keepWatermark: o["crop-watermark"] === true ? false : undefined,
    freshImages: o["fresh-images"] === true ? true : undefined,
    concurrency: typeof o.concurrency === "string" ? Number(o.concurrency) : undefined,
  };
}

// ── 控制台事件渲染 ──────────────────────────────────────────────
function makeConsoleSink(): (ev: JobEvent) => void {
  const lastPct: Record<string, number> = {};
  return (ev) => {
    if (ev.type === "log") {
      console.log(`  ${C.dim}·${C.reset} ${ev.message ?? ""}`);
      return;
    }
    if (ev.type === "done") {
      process.stdout.write("\n");
      console.log(`${C.green}${C.bold}✔ ${ev.message ?? "完成"}${C.reset}`);
      return;
    }
    if (ev.type === "error") {
      process.stdout.write("\n");
      console.log(`${C.red}✘ ${ev.message ?? "错误"}${C.reset}`);
      return;
    }
    // stage 事件
    const stage = ev.stage ? STAGE_LABELS[ev.stage] : "工序";
    if (ev.status === "start") {
      process.stdout.write(`\n${C.cyan}▶ ${stage}${C.reset} ${ev.message ?? ""}\n`);
    } else if (ev.status === "done" || ev.status === "skip") {
      process.stdout.write(`\r${C.green}✔ ${stage}${C.reset} ${ev.message ?? ""}${" ".repeat(12)}\n`);
      if (ev.stage) delete lastPct[ev.stage];
    } else if (ev.status === "progress") {
      const key = ev.stage ?? "x";
      const prev = lastPct[key] ?? -1;
      const pct = Math.round((ev.progress ?? 0) * 100);
      if (pct >= prev + 5 || pct === 100) {
        lastPct[key] = pct;
        const bars = Math.round(pct / 5);
        const bar = `${"█".repeat(bars)}${"░".repeat(20 - bars)}`;
        process.stdout.write(`\r  ${C.dim}${stage}${C.reset} ${bar} ${String(pct).padStart(3)}%  ${C.dim}${ev.message ?? ""}${C.reset}   `);
      }
    }
  };
}

// ── check：环境体检 ─────────────────────────────────────────────
async function cmdCheck(): Promise<void> {
  const cfg = getConfig();
  const rows: string[] = [];
  const ok = (b: boolean) => (b ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`);

  rows.push(`Node.js       ${ok(Number(process.versions.node.split(".")[0]) >= 22)} v${process.versions.node}（需 ≥ 22.18，原生 TS 直跑）`);

  const ff = findFfmpeg();
  let ffVer = "";
  if (ff) {
    const r = await run(ff.ffmpeg, ["-version"], { allowFail: true, timeoutMs: 15000 });
    ffVer = (r.stdout.split("\n")[0] ?? "").slice(0, 40);
  }
  rows.push(`FFmpeg        ${ok(!!ff)} ${ff ? `${ff.ffmpeg}（${ffVer}）` : "未找到，安装：winget install Gyan.FFmpeg"}`);

  const browser = findBrowser();
  rows.push(`无头浏览器    ${ok(!!browser)} ${browser ? `${browser.brand} · ${browser.exe}` : "未找到 Edge/Chrome（svg 画面需要）"}`);

  // SAPI 语音
  let sapiLine = "非 Windows 平台不适用";
  if (process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
      "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    const r = await run("powershell.exe", ["-NoProfile", "-Command", script], { allowFail: true, timeoutMs: 30000 });
    const voices = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const zh = voices.filter((v) => v.includes("|zh"));
    sapiLine = `${ok(zh.length > 0)} ${voices.length} 个音色（中文 ${zh.length} 个${zh.length ? "：" + zh.map((v) => v.split("|")[0]).join("、") : ""}）`;
    if (zh.length === 0) sapiLine += " — 建议改用 --voice-provider openai 或 none";
  }
  rows.push(`Windows 语音  ${sapiLine}`);

  // Edge 神经语音
  const pyExe = process.env.SHIYING_PYTHON || "python";
  const edgeProbe = await run(pyExe, ["-c", "import edge_tts; print(edge_tts.__version__)"], { allowFail: true, timeoutMs: 20000 });
  const edgeVer = edgeProbe.stdout.trim();
  const edgeOk = edgeProbe.code === 0 && edgeVer.length > 0;
  rows.push(`Edge 神经语音 ${ok(edgeOk)} ${edgeOk ? `edge-tts v${edgeVer}（推荐用于朗诵）` : "未安装：pip install edge-tts"}`);

  // Seedream 本地通道
  let seedOk = false;
  try {
    const res = await fetch(cfg.seedreamTokenService, { signal: AbortSignal.timeout(4000) });
    seedOk = res.ok;
  } catch {
    seedOk = false;
  }
  rows.push(`Seedream 通道 ${ok(seedOk)} ${seedOk ? "本机 token 服务可达（--image seedream 可出真图）" : "token 服务不可达（需 AutoClaw 运行时；或用 --image svg / cogview）"}`);

  rows.push(`文本工序      ${C.cyan}${cfg.text.provider}${C.reset}${cfg.text.provider === "offline" ? "（离线内置数据；接入大模型设置 SHIYING_TEXT_PROVIDER=glm）" : ` · ${cfg.text.model}`}`);
  rows.push(`画面工序      ${C.cyan}${cfg.image.provider}${C.reset}`);
  rows.push(`声音工序      ${C.cyan}${cfg.voice.provider}${C.reset}`);
  rows.push(`配乐          ${C.cyan}${cfg.bgm}${C.reset} · 输出尺寸 ${cfg.size.label}`);

  const poems = Object.values(loadBuiltins());
  rows.push(`内置诗词      ${poems.length} 首：${poems.map((p) => p.title).join(" / ")}`);

  console.log(`\n${C.bold}诗影工坊 · 环境体检${C.reset}\n`);
  rows.forEach((r) => console.log(`  ${r}`));
  console.log(`\n${C.dim}运行示例：node src/cli.ts run --poem jingyesi --image seedream${C.reset}\n`);
}

// ── list ────────────────────────────────────────────────────────
function cmdList(): void {
  const poems = Object.values(loadBuiltins());
  console.log(`\n${C.bold}内置诗词（${poems.length} 首）${C.reset}\n`);
  for (const p of poems) {
    console.log(`  ${C.cyan}${p.id.padEnd(10)}${C.reset}《${p.title}》 · ${p.dynasty} · ${p.author}`);
    console.log(`  ${C.dim}${" ".repeat(10)}${p.lines.join("，")}。${C.reset}`);
  }
  console.log(`\n${C.dim}运行：node src/cli.ts run --poem <id>；或运行任意诗词：node src/cli.ts run --text "床前明月光……"${C.reset}\n`);
}

// ── run ─────────────────────────────────────────────────────────
async function cmdRun(args: CliArgs): Promise<void> {
  applyOptions(args.options);
  const opts = runOptionsFromArgs(args);
  if (!opts.poemId && !opts.text) {
    console.log(`用法：node src/cli.ts run --poem <id> | --text "诗句…" [--file 文件] [选项]\n`);
    console.log(`常用选项：`);
    console.log(`  --image svg|seedream|siliconflow|cogview|openai   画面通道（默认 svg）`);
    console.log(`  --voice yunque|qingzheng|songfeng|none 朗诵音色`);
    console.log(`  --narration both|line                 旁白模式（诗句+旁白 / 只念诗句）`);
    console.log(`  --bgm guqin|rain|none                 配乐`);
    console.log(`  --size 1080x1920                      输出尺寸`);
    console.log(`  --crop-watermark                      seedream 出图时裁掉右下角水印区`);
    console.log(`  --fresh-images                        忽略画面缓存与复用，全量重出全部意境图`);
    return;
  }
  const cfg = getConfig();
  console.log(`\n${C.bold}诗影工坊${C.reset} ${C.dim}· 文本=${cfg.text.provider} 画面=${cfg.image.provider} 声音=${cfg.voice.provider} 配乐=${cfg.bgm} 尺寸=${cfg.size.label}${C.reset}`);
  const t0 = Date.now();
  const result = await runPipeline(opts, makeConsoleSink());
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.bold}产物目录${C.reset} ${result.dir}`);
  if (result.manifest) {
    console.log(`  ${C.green}▸ 成片${C.reset}     ${path.join(result.dir, result.manifest.files.video)}`);
    console.log(`  ${C.green}▸ 字幕${C.reset}     ${path.join(result.dir, result.manifest.files.srt)}`);
    console.log(`  ${C.green}▸ 封面${C.reset}     ${path.join(result.dir, result.manifest.files.cover)}`);
    console.log(`  ${C.dim}共 ${result.manifest.scenes.length} 镜 · ${(result.manifest.totalMs / 1000).toFixed(1)} 秒 · 用时 ${secs}s${C.reset}\n`);
  } else {
    console.log(`  ${C.dim}仅解析与文案（审核模式）· 用时 ${secs}s${C.reset}\n`);
  }
}

// ── batch ───────────────────────────────────────────────────────
async function cmdBatch(args: CliArgs): Promise<void> {
  applyOptions(args.options);
  const poems = Object.values(loadBuiltins());
  const ids = args.positionals.length > 0 ? args.positionals : poems.map((p) => p.id);
  console.log(`\n${C.bold}批量出片${C.reset}：${ids.join(" / ")}\n`);
  const results: Array<{ id: string; video: string }> = [];
  for (const id of ids) {
    console.log(`${C.cyan}── ${id} ${"─".repeat(40)}${C.reset}`);
    const result = await runPipeline({ ...runOptionsFromArgs(args), poemId: id }, makeConsoleSink());
    results.push({ id, video: result.manifest ? path.join(result.dir, result.manifest.files.video) : result.dir });
  }
  console.log(`\n${C.bold}批量完成：${results.length} 支成片${C.reset}`);
  results.forEach((r) => console.log(`  ${C.green}▸${C.reset} ${r.video}`));
  console.log();
}

// ── studio ──────────────────────────────────────────────────────
async function cmdStudio(args: CliArgs): Promise<void> {
  applyOptions(args.options);
  const port = typeof args.options.port === "string" ? Number(args.options.port) : 7788;
  const { startServer } = await import("./server.ts");
  await startServer({ port });
}

function cmdHelp(): void {
  console.log(`
${C.bold}诗影工坊 · 古诗词短视频创作流水线${C.reset}

用法：node src/cli.ts <命令> [选项]

命令：
  check     环境体检（FFmpeg / 浏览器 / 语音 / 通道）
  list      列出内置诗词
  run       跑一首诗的完整流水线，产出真实 MP4
  batch     批量跑内置诗词
  studio    启动本地工作台（V2 网页面板）

run 选项：
  --poem <id>            内置诗词 id（list 查看）
  --text "诗句…"          任意诗词文本
  --file <路径>           从文件读入诗词
  --title/--author/--dynasty   手工指定题名信息
  --image svg|seedream|siliconflow|cogview|openai
  --text-provider offline|glm|deepseek|openai
  --voice yunque|qingzheng|songfeng|none
  --narration both|line  旁白模式
  --bgm guqin|rain|none
  --size 1080x1920
  --crop-watermark       seedream 出图裁掉右下角水印区
  --fresh-images         忽略画面缓存与复用，全量重出全部意境图
  --concurrency 2

示例：
  node src/cli.ts run --poem jingyesi --image seedream
  node src/cli.ts run --text "床前明月光，疑是地上霜。举头望明月，低头思故乡。"
  node src/cli.ts run --poem chunxiao --text-provider glm --voice qingzheng
`);
}

// ── main ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = parseArgs(argv);
try {
  switch (args.command) {
    case "check":
      await cmdCheck();
      break;
    case "list":
      cmdList();
      break;
    case "run":
      await cmdRun(args);
      break;
    case "batch":
      await cmdBatch(args);
      break;
    case "studio":
      await cmdStudio(args);
      break;
    default:
      cmdHelp();
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`\n${C.red}✘ 运行失败：${msg}${C.reset}\n`);
  process.exitCode = 1;
}
