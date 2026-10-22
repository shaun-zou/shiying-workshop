# 诗影工坊 · Code Wiki

> 本文档是 `shiying-workshop`（诗影工坊）的结构化代码百科，覆盖**整体架构、模块职责、关键类型与函数、依赖关系、运行方式与扩展点**。
>   
> 面向需要理解、维护或扩展本项目的开发者。

- 项目定位：古诗词短视频创作流水线 —— **输入一首诗 → 产出真实 MP4**（1080×1920 竖屏 / 30fps / H.264+AAC）
- 核心理念：**零运行时依赖**（Node 22.18+ 原生直跑 TypeScript）、**四道工序每道可换通道**、**离线随时可出片**、**缓存即省钱**
- 代码规模：`src/` 16 个 TS 模块 + 单文件前端 `web/index.html` + 1 个 Python 辅助脚本

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈与外部依赖](#2-技术栈与外部依赖)
3. [目录结构](#3-目录结构)
4. [整体架构](#4-整体架构)
5. [核心数据契约（types.ts）](#5-核心数据契约typests)
6. [模块详解与关键函数](#6-模块详解与关键函数)
7. [前端工作台（web/index.html）](#7-前端工作台webindexhtml)
8. [辅助脚本与数据文件](#8-辅助脚本与数据文件)
9. [模块依赖关系](#9-模块依赖关系)
10. [关键机制剖析](#10-关键机制剖析)
11. [产物目录与清单](#11-产物目录与清单)
12. [HTTP API 参考](#12-http-api-参考)
13. [配置项参考（环境变量）](#13-配置项参考环境变量)
14. [项目运行方式](#14-项目运行方式)
15. [扩展指南](#15-扩展指南)
16. [已知限制与设计取舍](#16-已知限制与设计取舍)

---

## 1. 项目概览

### 1.1 它做什么

把一首古诗词自动加工成一支带旁白、配乐、字幕、运镜的竖屏短视频：

```
诗词文本 ──► ① 文本工序  ──► ② 分镜工序 ──► ③ 画面工序 ──► ③.5 动效工序（可选） ──► ④ 声音工序 ──► ⑤ 合成工序 ──► video.mp4
          释义/背景/文案     标题+逐句+尾声   意境图(16种)   分段配音/节奏   FFmpeg 烧制混音
```

> 注：代码内阶段标识为 6 个（`text / scenes / images / motion / voice / compose`，motion 可选），产品语境常称「四道工序」（分镜并入文本策划）。

### 1.2 两种使用形态

| 形态    | 入口                                                                                                                 | 说明                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 命令行   | [src/cli.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/cli.ts) | `check / list / run / batch / studio` 五个子命令 |
| 本地工作台 | `node src/cli.ts studio` → <http://127.0.0.1:7788>                                                                 | 零依赖 HTTP 服务 + 单文件网页面板，**两段式「先审后产」**         |

### 1.3 通道（Provider）体系

每道工序抽象为可切换的「通道」，离线通道保底，真实服务通道提质：

| 工序 | 通道                                                                                              |
| -- | ----------------------------------------------------------------------------------------------- |
| 文本 | `offline`（内置数据/结构解析）· `glm` · `deepseek` · `openai`（OpenAI 兼容 chat/completions）                 |
| 画面 | `svg`（内置水墨引擎+无头浏览器截图）· `seedream`（AutoGLM 本地免 Key）· `siliconflow`（Kolors）· `agnes`（agnes-image-2.5-flash，国内站）· `cogview` · `openai` |
| 声音 | `edge`（微软 Edge 神经语音，默认）· `sapi`（Windows 本机语音兜底）· `openai` · `none`                              |
| 配乐 | `synth`（程序合成古琴/雨声，默认）· `none`                                                                   |

---

## 2. 技术栈与外部依赖

### 2.1 运行时与开发依赖

- **语言/运行时**：TypeScript（ESM，`"type": "module"`），要求 **Node.js ≥ 22.18**。利用 Node 22 原生 TypeScript 类型擦除能力直接 `node src/cli.ts` 运行，**无需构建步骤、无需 npm install**。
- **npm 依赖**：`dependencies` 为空（真正的零运行时依赖）。
- **devDependencies**：`typescript ^5`、`@types/node ^22`，仅用于 `npm run typecheck`（`tsc --noEmit`）。
- TS 配置要点（[tsconfig.json](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/tsconfig.json)）：`strict: true`、`module/moduleResolution: NodeNext`、`allowImportingTsExtensions`、`erasableSyntaxOnly`（只允许可被擦除的 TS 语法，这是原生直跑的前提）。

### 2.2 系统级外部依赖（非 npm）

| 依赖                              | 用途                     | 必需性                | 发现方式                                |
| ------------------------------- | ---------------------- | ------------------ | ----------------------------------- |
| **FFmpeg / ffprobe**            | 视频合成、音频归一、水印裁切、封面帧     | 出片必需               | PATH → `SHIYING_FFMPEG`             |
| **Edge / Chrome 无头浏览器**         | `svg` 画面通道截图           | 用 svg 通道时必需        | 常见安装路径 → PATH → `SHIYING_BROWSER`   |
| **Python + edge-tts**           | Edge 神经语音              | 可选（推荐）；缺失自动回退 SAPI | `SHIYING_PYTHON` 或 `python`         |
| **Windows SAPI（System.Speech）** | 离线配音兜底                 | Windows 可选         | PowerShell `Add-Type System.Speech` |
| **网络**                          | LLM / AI 生图 / Edge TTS | 仅真实通道需要            | —                                   |
| **AutoClaw 本地 token 服务**        | `seedream` 通道免 Key 取令牌 | 仅 seedream         | `http://127.0.0.1:18432/get_token`  |

---

## 3. 目录结构

```
shiying-workshop/
├── src/                        # 全部后端/流水线源码（17 个模块）
│   ├── cli.ts                  # 命令行入口（check/list/run/batch/studio）
│   ├── server.ts               # 本地工作台零依赖 HTTP 服务（任务 API + SSE + 媒体 + 通道设置 API）
│   ├── pipeline.ts             # 流水线编排（五阶段 + 事件回传 + manifest 落盘）
│   ├── types.ts                # 领域类型：工序间数据契约
│   ├── config.ts               # .env 解析 + 通道预设 + 音色档案 + 设置覆盖钩子
│   ├── settings.ts             # 工作台通道设置：studio-settings.json 读写/合并/脱敏/应用
│   ├── util.ts                 # 子进程/文件/哈希/发现器/并发池/控制台样式
│   ├── text.ts                 # ① 文本：内置数据 / 结构解析 / LLM 解析与降级
│   ├── scenes.ts               # ② 分镜导演：标题镜+逐句镜+尾声镜、关键词场景分配
│   ├── persona.ts              # 人物一致性：同一人判定 + 固定形象注入
│   ├── prompts.ts              # 画面提示词：风格锚 + 文案主体 + 构图参考
│   ├── styles.ts               # 艺术风格配方卡（9 种风格锚 + 动效母题）
│   ├── svg.ts                  # 水墨分镜引擎：16 个 SVG 场景构建器 + HTML 包装
│   ├── image.ts                # ③ 画面：6 种通道 + 缓存 + 重试 + Agnes 节流 + 图源侧车
│   ├── motion.ts               # ③.5 动效（可选）：agnes-video-2.5-flash 关键分镜图生视频
│   ├── voice.ts                # ④ 声音：edge/sapi/openai + 节奏停顿 + 缓存
│   ├── audio.ts                # WAV 读写/拼接 + 原创配乐合成（古琴/雨声）
│   ├── srt.ts                  # 字幕：标准 SRT + 样式化 ASS
│   └── compose.ts              # ⑤ 合成：FFmpeg 运镜/拼接/烧字幕/混音/MP4
├── web/
│   └── index.html              # 工作台 V3「卷轴书斋」单文件前端（HTML+CSS+原生 JS，无框架）
├── scripts/
│   └── edge_tts_once.py        # Edge TTS 单段合成辅助脚本（Python）
├── data/
│   ├── poems.json              # 内置 3 首诗词完整数据（静夜思/春晓/登鹳雀楼）
│   ├── studio-settings.json    # 工作台通道设置（节点密钥为 AES-256-GCM 密文，勿提交）
│   └── studio.key              # 密钥加密主密钥（首次自动生成，丢失后已存密钥需重填，勿提交）
├── docs/                       # 迭代说明与复盘报告（HTML）+ 素材图片/语音样例
├── output/                     # 运行产物（gitignore；job-<时间戳>/ 与 cache/）
├── .env.example                # 环境变量模板
├── package.json                # 脚本与元信息（无运行时依赖）
├── tsconfig.json
└── readme.md                   # 用户向使用手册
```

---

## 4. 整体架构

### 4.1 分层视图

```
┌─────────────────────────────────────────────────────────────┐
│  接入层    cli.ts（命令行）          server.ts（HTTP + SSE）  │
│                                  └─ web/index.html（浏览器） │
├─────────────────────────────────────────────────────────────┤
│  编排层    pipeline.ts                                         │
│            runPipeline()：五阶段顺序执行 / 事件流 / 清单落盘    │
├─────────────────────────────────────────────────────────────┤
│  工序层    text → scenes → image → voice → compose           │
│            (persona/prompts/svg 为 image 的支撑模块)           │
│            (audio/srt 为 voice/compose 的支撑模块)             │
├─────────────────────────────────────────────────────────────┤
│  基础层    config.ts（配置）  util.ts（进程/文件/发现/并发）    │
│            types.ts（契约）  data/poems.json（内置数据）       │
├─────────────────────────────────────────────────────────────┤
│  系统件    Node 22 原生 API · FFmpeg · 无头浏览器 · Python     │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 流水线时序

[src/pipeline.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/pipeline.ts) 的 `runPipeline(opts, sink, controls)` 是唯一编排入口：

1. **准备**：`getConfig()` 读配置 → 生成 `jobId`（时间戳+随机后缀）→ 创建 `output/job-<id>/` 与 `output/cache/`。
2. **① text**：若传入 `opts.analysis`（用户编辑后重合成）直接使用并标记 `origin.text="edited"`；否则 `analyzeText()` 解析。随后 `derivePersona()` 判定/固化人物形象，写 `analysis.json`。
3. **② scenes**：`buildScenes()` 产出 `Scene[]`（标题镜 1 + 逐句镜 N + 尾声镜 1）；尾声镜带 `reuseImage:true`。
4. **审核断点**：`controls.stopAfter === "scenes"` 时立即返回（`manifest=null`），工作台「先审后产」即利用此断点。
5. **③ images**：`generateImages()` 并发生成/复用各镜意境图，写回 `scene.image`；`reuseImage` 镜（尾声）跳过出图，在生成阶段结束后复制相邻上一张图（含 `imageUrl`）。
6. **④ voice**：`generateVoice()` 逐段合成配音、拼接、按配音时长回填 `scene.durMs`；`assembleNarration()` 产出整条 `narration.wav`。
7. **配乐铺垫**：`bgmCached()` 按片长取合成配乐（古琴/雨声）。
8. **⑤ compose**：`composeVideo()` 单遍 FFmpeg 出 MP4 + 封面；`buildSrt()` 写 `subtitles.srt`。
9. **收尾**：计算每镜起点/总时长，写 `manifest.json`，发出 `done` 事件。

每个阶段通过 `EventSink = (ev: JobEvent) => void` 回报 `stage/log/done/error` 事件；CLI 把它渲染成进度条，Server 把它广播给 SSE 客户端。

### 4.3 两段式「先审后产」（工作台）

工作台把一次出片拆成两个任务（[src/server.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/server.ts) 的 `mode`）：

- **`analyze`**：只跑 ① 文本 + ② 分镜，在分镜后停住，不产生生图/配音成本。前端拿到 `analysis` 供用户行内编辑。
- **`render`**：携带（可能被编辑过的）`analysis` 与 `options`（音色/配乐/复用策略）跑完整后半段。默认通过 `reuseImagesFrom` 复用上次画面，实现「图片复用 → 增量配音 → 重新合成」；勾选「重新生成意境图」则 `freshImages=true` 全量重出。

---

## 5. 核心数据契约（types.ts）

[src/types.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/types.ts) 集中定义工序之间流转的全部接口。

| 类型            | 角色                            | 关键字段                                                                                                 |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `BuiltinPoem` | `data/poems.json` 中一首内置诗的完整数据 | `lines[]` 原文、`gloss[]` 逐句释义、`notes[]` 知识卡片、`script` 故事文案、`sceneDefs[]` 指定分镜、`persona?` 精修人物设定        |
| `PoemScript`  | 故事化旁白文案                       | `name` 标题、`hook` 开场、`beats[]` 逐句旁白（与 lines 一一对应）、`outro` 收尾                                          |
| `PoemPersona` | 跨镜人物一致性设定                     | `consistent`、`who`、`look`（逐字注入的固定形象）、`basis`（curated/heuristic/llm/manual）                           |
| `Analysis`    | **①文本工序产物**，全片的语义源头           | `lines/gloss/notes/script`、`origin`（来源与降级提示）、`persona`                                               |
| `Scene`       | **分镜**：画面输入、合成底稿              | `kind`、`subtitle`（大字诗句）、`caption`（小字旁白/释义）、`narrationSegments[]`、`minDurMs/durMs`、`image`、`audio`    |
| `RunOptions`  | 运行参数（CLI/Server/流水线共用）        | 输入来源、各 provider、`style`（艺术风格）、`voiceProfile`、`narration`、`bgm`、`size`、`analysis`、`reuseImagesFrom`、`freshImages` 等 |
| `Manifest`    | 任务清单（落盘 `manifest.json`）      | `jobId`、`providers`、`style`、`scenes[]`（含起点/时长/文件名）、`files`、`totalMs`、`tips`                                  |
| `JobEvent`    | 流水线事件                         | `type: stage/log/done/error`、`stage`、`status`、`progress`、`overall`、`message`                         |

另有：

- `type StageId = "text" | "scenes" | "images" | "voice" | "compose"`
- `STAGE_ORDER`：阶段顺序常量；`STAGE_LABELS`：中文名映射；`type EventSink`。

**核心数据流**：

```
BuiltinPoem/文本输入
      │ analyzeText()
      ▼
   Analysis ──► derivePersona() ──► Analysis(含 persona)
      │ buildScenes()
      ▼
   Scene[] ──generateImages()──► Scene[].image
          ──generateVoice()───► Scene[].audio / durMs
      │ composeVideo() + buildSrt()
      ▼
 video.mp4 + subtitles.srt/ass + cover.jpg + manifest.json
```

---

## 6. 模块详解与关键函数

### 6.1 config.ts —— 配置层

[src/config.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/config.ts)

- 极简 `.env` 解析（无第三方 dotenv）：`loadDotenv()`（单次幂等）、`env(key, fallback)`。
- 三套通道端点/模型预设表：`TEXT_PRESETS`（glm/deepseek/openai）、`IMAGE_PRESETS`（cogview/openai/siliconflow/agnes）、`VOICE_PRESETS`。
- `getConfig(): AppConfig` —— 汇总文本/画面/声音三个 `ProviderConfig`（provider/apiKey/baseUrl/model），以及 `motion、style、bgm、size、outRoot、concurrency、keepWatermark、seedreamTokenService`。环境变量优先，缺省全部可离线跑。`style` 读 `SHIYING_STYLE`（默认 `ink`，见 styles.ts）。
- `parseSize("1080x1920")` —— 解析输出尺寸，非法值回退 1080×1920。
- `VOICE_PROFILES`：三个中文音色档案，每个档案同时携带三套通道参数：
  - `yunque` 云阙·沉静男声 → Edge **YunjianNeural（−8%）** / SAPI 低音塑形 pitch 0.85 / OpenAI `onyx`
  - `qingzheng` 清徵·清亮女声 → Edge **XiaoxiaoNeural（−4%）** / SAPI 原声 / OpenAI `nova`
  - `songfeng` 松风·苍劲男声 → Edge **YunyangNeural（−12%）** / SAPI pitch 0.78 / OpenAI `echo`
- `BGM_LABELS`：guqin/rain/none 展示名。
- **设置覆盖钩子**：`getConfig()` 返回值经 `applySettings()`（settings.ts）包装——工作台「通道配置」保存的节点会覆盖 text/image/voice/motion 四段的 provider/baseUrl/model/apiKey；节点留空的字段回落 `.env` 值。每次任务开始都会重新 `getConfig()`，设置保存后新任务即时生效、无需重启。

### 6.1a settings.ts —— 工作台通道设置

[src/settings.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/settings.ts)

- **存储**：`data/studio-settings.json`（`{ version: 1, channels: { text/image/video/voice: { active, nodes[] } } }`）；`loadSettings()` 容错读取（坏文件返回 null 并补齐通道结构），`writeSettings()` 落盘前统一把残留明文密钥加密（惰性迁移）。
- **密钥加密存储**：AES-256-GCM（`encryptSecret()` / `decryptSecret()`），密文格式 `enc:v1:<iv>:<tag>:<cipher>`（base64url）；主密钥为 32 字节随机数，首次使用自动生成于 `data/studio.key`（独立文件、已 gitignore，chmod 600 尽力而为）；旧版明文在读取时原样兼容、下次落盘自动迁移；主密钥文件损坏时旧密文按未配处理（需在配置页重填）。`revealNodeKey()` 供连通性测试接口解密。
- **节点模型**：`ChannelNode { id, label, baseUrl?, model?, apiKey?, builtin?, note? }`；ID 规则 `^[a-zA-Z][a-zA-Z0-9_-]{0,31}$`；voice 限 `edge/sapi/openai`、video 限 `none/agnes`（与分发代码对齐），text/image 支持任意 OpenAI 兼容节点；节点列表清空回退内置预设。
- **密钥合并语义**（`normalizeIncoming()`）：提交 `""`/缺省 = **保留旧值**；`"__clear__"` = 清除。服务端永不向前端发明文 Key——`settingsView()` 输出脱敏视图（`hasKey` + `keyMask` 前4…后4 + `keyFrom` 来源标记：`node`=保存在设置文件 / `env`=回落 .env 通道密钥，本地引擎 offline/svg/seedream/none/edge/sapi 免密钥不做回落展示）；`.env` 里有而节点表没有的 provider 会自动补一个「来自 .env 配置」节点，保证所见即所得。
- **应用**：`applySettings(cfg)` 按各通道 active 节点覆盖 `AppConfig` 对应字段；motion（动效视频）密钥默认复用 Agnes 图像 Key（`SHIYING_IMAGE_API_KEY_AGNES` → `SHIYING_IMAGE_API_KEY` 兜底）。

### 6.2 util.ts —— 工具层

[src/util.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/util.ts)

| 函数                                          | 说明                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `run(cmd, args, opts)`                      | **无 shell 子进程调用**（参数数组直传，杜绝引号问题）；支持超时、stdin、`allowFail`、stdout 流式回调（FFmpeg 进度解析用） |
| `ensureDir / exists / readJson / writeJson` | 文件与 JSON 助手                                                                       |
| `sha1Short(...parts)`                       | 内容哈希指纹（缓存键），取 SHA1 前 16 位                                                         |
| `jobStamp()`                                | 任务 id：`YYYYMMDD-HHMMSS-xxxxxx`                                                    |
| `findInPath / findBrowser / findFfmpeg`     | 可执行文件发现；浏览器 Edge 优先、其次 Chrome，支持环境变量覆盖                                            |
| `pool(items, limit, worker)`                | 简单**并发池**：按并发数跑任务、保持原顺序（画面并发出图用，默认并发 2）                                           |
| `sleep / fmtMs / fileSizeHuman / safeName`  | 杂项                                                                                |
| `C / log / progressBar`                     | CLI 控制台 ANSI 样式                                                                   |


### 6.3 text.ts —— ① 文本工序

[src/text.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/text.ts)

三条解析路径，统一产出 `Analysis`：

- **内置数据**：`loadBuiltins()`（带缓存读 `data/poems.json`）、`findBuiltinByText()`（按标题/诗句模糊命中）、`fromBuiltin()` 深拷贝成 `Analysis`。
- **离线结构解析**：`structureParse(raw, hints)` —— 从任意诗词文本中提取《标题》、朝代+作者（限定首尾两行、带朝代词表正则）、按标点切句（≤16 字），产出 `script=null` 的**纯朗诵版**，并在 `tips` 中说明降级。
- **大模型**：`callChat()` 调 OpenAI 兼容 `/chat/completions`；`SYSTEM_PROMPT` 要求严格 JSON（含 lines/gloss/notes/script/persona 的完整 schema 与数量一致约束）；`parseJsonLoose()` 容错剥离 markdown 代码块；`normalizeLlmAnalysis()` 校验、对齐数组长度、归一化字段。
- **主入口** `analyzeText(input)`：poemId → 内置；offline → 命中内置否则结构解析；其他 provider → 调 LLM，**失败自动降级**（命中内置走内置，否则纯朗诵版），降级原因写入 `tips`。

### 6.4 scenes.ts —— ② 分镜导演

[src/scenes.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/scenes.ts)

- `buildScenes(analysis, builtin, opts)`：生成 **标题镜 + 每句一镜 + 尾声镜**。
  - 内置诗使用 `builtin.sceneDefs`（与原型逐镜一致的 kind/label/dur）；任意诗用通用导演。
  - 句镜的 `caption`（旁白、字幕、画面主体来源）取**逐句释义 `gloss[i]`**，缺失时回退故事 beat；`narrationSegments` 在 `both` 模式为 `[诗句, 旁白]`，`line` 模式仅 `[诗句]`。
- `assignLineKinds(lines)`：对任意诗，按 `KIND_RULES` 关键词正则（月/霜/窗/望/花/鸟/雨/江/日落……16 条优先级规则）映射场景类型；同类重复时换 `FALLBACK_POOL` 中未用过的类型，避免画面雷同。
- `outroKindFor()`：按全诗情绪在 `outro-moon / outro-dawn / outro-wide` 中选尾声。
- 尾声镜固定带 `reuseImage: true`：导演层声明「本镜不生新画面」——画面工序复制相邻上一张图、动效工序跳过它（默认关键镜为首镜+最后一句镜），省一次出图与视频额度；配音/字幕仍独立。该标志透传到 `manifest.scenes[].reuseImage`，工作台分镜条据此显示「复用」角标。
- 默认时长：标题 4200ms / 句镜 5000ms / 尾声 6000ms（后续若配音更长则以配音为准）。

### 6.5 persona.ts —— 人物一致性

[src/persona.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/persona.ts)

解决「多镜人物是同一张脸、同一身装束」：

- `derivePersona(analysis)`：已有判定（含用户手改）原样返回；否则 `matchBuiltinPoem()`（诗句重合度 ≥75% 且 ≥2 句）取内置精修设定（`basis=curated`）；再否则 `heuristicPersona()` 关键词推断（识别农人/渔樵等他者主角，或按第一人称/动作信号词密度判定抒情主人公=作者本人，按朝代生成文人形象）。
- `personaAppearance(scene)`：逐镜判定出镜强度 —— `must`（诗句/释义含「我/望/听/醉/归…」等人物信号，须出现人物）或 `may`（写景句，如出现则须一致；标题/尾声固定 may）。
- `personaPromptBlock(persona, scene)`：生成逐字注入图像提示词的「人物设定 · 全片同一人」段落，含固定形象、中远景/侧身避免正面特写、不出现其他人物等约束。

### 6.6 prompts.ts —— 画面提示词

[src/prompts.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/prompts.ts)

- `STYLE_ANCHOR`：默认水墨风格锚（从 `styles.ts` 的 `ink` 配方取），保留以兼容旧调用。
- `KIND_COMPOSITIONS`：16 种场景类型的**构图/光线/气氛参考**（只描述构图不写死物件，避免与编辑后文案冲突）。
- `sceneImagePrompt(poem, scene, style?)`：按「**风格锚（由所选风格决定，默认 ink）** + **画面主体（最高优先＝该镜文案 caption，纯朗诵版回退诗句）** + 人物一致性块 + 构图参考 + 出处一致性」五段拼装提示词。`style` 可为风格 id 或 `ArtStyle` 对象，缺省走 `getArtStyle()` 回退水墨。`genericFromText()` 为未知 kind 提供意象词兜底。

### 6.6a styles.ts —— 艺术风格配方卡

[src/styles.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/styles.ts)

借鉴 [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion)「风格配方卡」思路。每种风格 `ArtStyle` = `id / label / hint / styleAnchor（画风·色调·材质，注入出图提示词） / motionHint（画面如何运动，注入图生视频提示词） / swatch（工作台色卡）`。

- `ART_STYLES`：9 种风格注册表 —— `ink`（水墨，默认）· `gongbi`（工笔重彩）· `dunhuang`（敦煌壁画）· `ukiyoe`（浮世绘）· `oil`（古典油画）· `postimpression`（后印象派/梵高）· `impression`（印象派/莫奈）· `shinkai`（新海诚）· `pixel`（8-bit 像素）。
- `getArtStyle(id)`：取配方卡，未知 id 回退默认水墨。
- `STYLE_LIST`：工作台展示顺序。
- 风格锚**只约束画风/色调/材质，不写死具体物件**（与 prompts.ts 设计原则一致）；具体内容以该镜文案为准。
- 缓存键含风格（`img-v2` / `motion-v2`），换风格不会命中旧图。
- `svg` 离线引擎不读取风格（固定水墨调色板），风格仅对 AI 出图通道生效。

### 6.7 svg.ts —— 水墨分镜引擎（离线画面）

[src/svg.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/svg.ts)

- 从 V1 原型移植的**纯字符串 SVG 生成器**：`sceneTitle / jyWindow / jyFrost / jyLookup / jyVillage / cxDawn / cxBirds / cxRain / cxPetals / dqSunset / dqRiver / dqClimb / dqSummit / outroMoon / outroDawn / outroWide` 共 **16 个场景构建器**，viewBox 固定 360×640，全部用几何元素（月、山脊、雾、剪影、雨丝、花瓣）绘制。
- `SCENE_BUILDERS`：kind → 构建器映射表；`SCENE_KIND_POOL`：合法类型池。
- `svgWrap()`：SVG 外壳；`scenePageHtml(svg, w, h)`：注入 `STAGE_CSS`（水墨色板）包成完整 HTML，供无头浏览器截图。静态渲染不含动画（动效由合成段 zoompan 运镜承担）。

### 6.8 image.ts —— ③ 画面工序

[src/image.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/image.ts)

主入口 `generateImages(input: ImageStageInput)`：scenes 先按 `reuseImage` 分流——正常镜通过 `pool()` 并发处理，每镜依次尝试 **复用旧任务图 → 内容哈希缓存 → 实际生成（失败重试 4 次，退避 3s/8s/15s）→ 写缓存**；全部正常镜完成后进入复用后处理，`reuseImage` 镜（尾声）直接 `copyFileSync` 相邻上一张图到自己的 `scene-N` 路径并继承 `imageUrl`，不发起任何出图请求。进度分母仍是全镜数，开始/结束事件会注明「实际出图 N 镜 / M 镜复用」。

各通道实现：

- **svg**：`renderSvgScene()` —— 写 HTML → 启动无头浏览器 `--headless --screenshot`。注意两个工程细节：
  - 浏览器对 profile 目录有独占锁 → 全局 `withSvgLock()` 串行化 + 每镜独立 profile；
  - Edge 启动器可能「转后台先退出」→ **不信退出码，轮询等待 PNG 文件大小稳定**（90s 超时）。
- **seedream**：`seedreamGenerate()` —— ① 向本机 `127.0.0.1:18432/get_token` 现取短时 Bearer 令牌（不落盘）；② 按 AutoGLM 技能协议加 `X-Auth-Appid/TimeStamp/Sign`（Appid `100003` + MD5 签名）；③ 调网关拿回 `image_url` 下载。`cropWatermark()` 用 FFmpeg 裁掉右下角 6%/4% 水印区。
- **siliconflow / cogview / openai / agnes**：`callOpenAiStyleImage()` —— OpenAI 兼容 `/images/generations`，按 provider 适配尺寸参数（siliconflow 用 `image_size:720x1280` 且读 `images[0].url`；cogview `768x1344`；其他 `1024x1536`），支持 url 与 b64_json 两种返回。
  - **agnes**：端点 `https://api.agnes-ai.cn/v1`（**国内站**，Key 也必须来自国内站 platform.agnes-ai.cn；国际站是 `apihub.agnes-ai.com`，Key 不通用，混用必 401）。参数为档位式 `size`（≥1080 宽 → `2K`，否则 `1K`）+ `ratio`（竖版 `9:16`），产物 `.png`。
  - **agnes 限流保护**：免费档实际 RPM 为 1K=10 / 2K=5（2026-06 官方限额）。`withAgnesPacer()` 把出图请求全局串行化并按 `60000/RPM+300ms` 最小间隔放行（并发池多 worker 也在此排队），可用 `SHIYING_AGNES_RPM` 覆盖（企业/Token Plan）。HTTP 429 时不再用 3/8/15s 短退避，而是读 `Retry-After`（缺省等 62s 一个完整窗口，封顶 120s）。
- 缓存键 `cacheKeyFor(provider, prompt, size)`；svg/siliconflow/agnes 存 `.png`，其余 `.jpg`。

### 6.8a motion.ts —— ③.5 动效工序（可选）

[src/motion.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/motion.ts)

- `generateMotion()`：provider=agnes 时启用（`SHIYING_MOTION_PROVIDER` / CLI `--motion agnes`）。`selectKeyScenes()` 先剔除 `reuseImage` 镜（尾声任何模式下都不生成视频），再选关键分镜（默认首镜+最后一句镜；`SHIYING_MOTION_SCENES="1,3,6"` 或 `all`，显式列出尾声也会被跳过），以分镜图远端 URL（`scene.imageUrl`，画面工序缓存侧车 `<key>.url.txt` 提供）作首帧图生视频。
- 接口（国内站 `api.agnes-ai.cn`，OpenAI Videos 兼容）：提交 `POST /v1/videos`（`mode:"keyframe"` + `first_frame` + `size:"720P"` + `aspect_ratio` + `seconds` 取 4–12）；轮询 `GET /agnesapi?video_id=..&model_name=..` 每 2s，完成取顶层 `url` 下载为 `scene-N.mp4`。
- 免费档 1 RPM：提交全局串行且间隔 ≥61s；503 队列满/429 限流自动退避重试（30/60/90s，读 Retry-After）；单镜失败只降级回静态图+运镜，不拖垮整片。片段按 (model+prompt+时长+画幅+图源URL) 哈希入缓存。
- 产出写入 `scene.video`；compose.ts 检测到后用视频镜头直接作输入（scale/crop 到目标画布 + fps/trim 对齐），替代静态图 zoompan。

### 6.9 voice.ts —— ④ 声音工序

[src/voice.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/voice.ts)

主入口 `generateVoice(input): Promise<boolean>`：

- `none`/无音色 → 跳过，时长取设计下限；`edge` 先 `python -c "import edge_tts"` 探测，不可用则整体回退 `sapi`。
- 逐镜逐段（`narrationSegments`）合成，缓存键含 provider+音色+语速/音高+文本（`tts-v3` 前缀），失败重试 1 次。
- 场景音频＝段间插入 **450ms 停顿**（`SEG_GAP_MS`）拼接；场景时长 = max(设计时长, 配音时长 + **750ms 尾白** `TAIL_PAD_MS`)，回填 `scene.durMs`。

通道实现：

- **sapi**：内嵌 PowerShell 脚本（`SAPI_PS1`，落盘 `sapi-tts.ps1`）调 `System.Speech`，按 `preferNames` 选中文音色；`shapePitch()` 用 FFmpeg `asetrate+atempo` 在不变速下降调塑形（仅当实际音色不在理想清单）。
- **edge**：`edgeSynthesize()` 调 [scripts/edge\_tts\_once.py](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/scripts/edge_tts_once.py) 出 MP3，再 FFmpeg 转 44.1k 单声道 PCM16 WAV。
- **openai**：`openaiTts()` 调 `/audio/speech`。

其他导出：

- `assembleNarration(scenes, jobDir)`：把每镜音频＋尾部静音（无音频镜补整段静音）拼成 `narration.wav`。
- `resolveVoiceProfiles()`：解析每个音色档案在本机的**实际落点**（Edge 显示神经语音名；SAPI 列出已安装音色并判断是否音高塑形），供工作台透明展示「音色映射」。

### 6.10 audio.ts —— WAV 工具与原创配乐

[src/audio.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/audio.ts)

- WAV 底层（纯 JS）：`readWav()`（解析 RIFF/fmt/data）、`wavDurationMs()`、`mkSilenceWav()`、`concatWavFiles(files, dest, gapMs)`（必要时经 FFmpeg 归一到 44.1k/单声道/PCM16，返回总时长）、`writeFloatWav()`。
- **程序合成配乐（无版权）**：
  - `synthGuqin()`：**Karplus-Strong 拨弦算法** + D 宫五声音阶随机漫步旋律（带八度/五度泛音、0.42s 延迟山谷回响、淡入淡出）。
  - `synthRain()`：多级低通滤波白噪声 + 低频 rumble + 缓慢响度调制。
  - `synthBgm(kind, durationMs, dest)`：合成单声道后做 14ms 右声道延迟（Haas 立体声扩散）。
  - `bgmCached()`：按类型 + **5s 时长分桶**缓存复用。

### 6.11 srt.ts —— 字幕

[src/srt.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/srt.ts)

- `sceneStarts(scenes)` / `totalDurationMs(scenes)`：时间轴计算。
- `buildSrt(scenes)`：标准 SRT（文本取大字诗句行），可导入剪辑软件。
- `buildAss(scenes, opts)`：样式化 ASS —— `Poem` 楷体大字（KaiTi、暖白、描边）+ `Caption` 微软雅黑小字，按 1080×1920 基准自适应字号/边距，每条带 320ms 淡入淡出，供 libass 烧制。

### 6.12 compose.ts —— ⑤ 合成工序

[src/compose.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/compose.ts)

`composeVideo(input)` 用**单遍 FFmpeg** 完成：

1. 写 `subtitles.ass`；
2. 每镜作为 `-loop 1 -t 时长` 的图片输入，旁白/配乐作为额外输入（配乐 `-stream_loop -1`）；
3. filter_complex：每镜先放大 1.08 倍预留运镜空间 → `zoompan` 三种运镜（`zoompanExpr`：推近/拉远/推近+横移，按镜序 `i%3` 轮换）→ `concat` → `subtitles` 烧 ASS；
4. 音频链：旁白 + 配乐（BGM 音量 0.20、2s 淡入/3.2s 淡出，`amix`），无配音/无 BGM/全无 共四种分支（全无补静音轨）；
5. 编码：libx264 / preset medium / crf 19 / yuv420p / 30fps + AAC 192k / 44.1k / `+faststart`；
6. 解析 FFmpeg `-progress pipe:1` 的 `out_time_us` 回报百分比；
7. 抽 0.8s 首帧生成 `cover.jpg`。

- `ensureJobDir(root, jobId)`：创建 `job-<id>` 目录。

### 6.13 pipeline.ts —— 编排层

见 [4.2](#42-流水线时序)。导出：

- `runPipeline(opts, sink, controls?)` → `PipelineResult { jobId, dir, manifest, analysis, scenes }`。
- `readManifest(jobDir)`：供服务端读取历史任务清单（损坏返回 null）。

### 6.14 server.ts —— 本地工作台服务

[src/server.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/server.ts)

零依赖 `node:http`，**仅监听 127.0.0.1**：

- **任务模型**：内存 `Map<id, JobRecord>`，状态机 `queued → running → done/error`；一个简单的**串行队列**（`enqueue/drain`，同一时刻只跑一个渲染）。
- `startJob()`：把请求映射成 `RunOptions`，处理 `reuseFrom`（复用上一任务目录的图片），按 `mode` 决定是否在分镜后停住；事件汇入 `pushEvent()`。
- **进度**：`computeOverall()` 按阶段权重（text .06 / scenes .03 / images .42 / voice .20 / compose .29）算总进度；事件实时推给 SSE，缓冲上限 800 条。
- **媒体分发**：`serveFile()` 支持 **HTTP Range（206）**，是成片可拖动播放的关键；并做了路径穿越防护。
- **历史回看**：`/api/works` 扫描磁盘 `job-*` 目录取 manifest；内存中没有的任务可从磁盘重建视图（`diskJobView`，旧任务缺 persona 时仅在视图层补推导，不回写）。
- **通道设置 API**：`GET /api/settings`（脱敏视图，`/api/config` 亦改为 handler 内现读 `getConfig()`）；`POST /api/settings`（`normalizeIncoming()` 校验合并后 `writeSettings()`，全量替换）；`POST /api/settings/test`（连通性探测：`GET {baseUrl}/models`，12s 超时；本地通道 svg/seedream/offline/none/edge/sapi 直接返回无需测试；401/403 判定密钥错误、404/405 判定「服务可达但 /models 不可用」）。

### 6.15 cli.ts —— 命令行入口

[src/cli.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/cli.ts)

- 极简参数解析 `parseArgs()`（`--key value` / 布尔开关）；`applyOptions()` 把 CLI 选项映射为 `SHIYING_*` 环境变量；`runOptionsFromArgs()` 组装 `RunOptions`（支持 `--file` 读入）。
- 子命令：
  - `check`：体检 Node/FFmpeg/浏览器/SAPI 中文音色/edge-tts/seedream token 服务/当前通道/内置诗。
  - `list`：列出内置诗。
  - `run`：跑一首（无参数打印用法）。
  - `batch`：顺序批量出片（可指定 id 列表）。
  - `studio`：动态 `import('./server.ts')` 启动工作台（默认端口 7788，`--port` 覆盖）。
- `makeConsoleSink()`：把 JobEvent 渲染成带 ANSI 颜色的阶段行与进度条。

---

## 7. 前端工作台（web/index.html）

[web/index.html](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/web/index.html) 是约 1600 行的**单文件、无框架**应用（原生 JS + 一套宣纸/墨/朱砂 CSS 设计 token，V3「卷轴书斋」版）。

- **长卷五卷动线**（设计方向经三方向初稿评选确定，见 `design-demos/` 与 `direction-approved.md`）：卷一研墨（诗库/任意输入/**最近作品折叠**：`loadWorks()` 存 `state.works`、`renderRecentWorks()` 只渲染最近 5 件，「更多作品」按钮打开 `dlgWorks` 作品库子页——`openWorksDialog()` 全量列表 + `worksFiltered()` 按日期范围过滤（自/至日期输入 + 清除过滤），点任一成品即关闭子页并 `loadJob()` 回看）→ 卷二展卷（逐句释义、背景知识、故事文案、人物形象的**行内编辑**，contenteditable，`toggleEdit/commitEdit`）→ 卷三调色（九风格色卡墙、音色/配乐、审核确认块）→ 卷四作画（五道工序节点进度）→ 卷五钤印（深色舞台：成片播放（手机框样式 `<video>`）、分镜缩略图跳转、导出）；顶栏吸顶含五卷锚点导航，卷节进入视口时点亮（IntersectionObserver 只点亮一次），`scrollToJu()` 在流程节点间自动引导滚动。
- **状态机**：全局 `state`，`phase: idle | analyzing | review | rendering | done`。
- **通道配置页**：顶栏「通道配置」按钮 → `dlgSettings` 宽对话框（`openSettings()` 拉 `GET /api/settings` 得脱敏副本 `setView`，全部编辑只改内存、点「保存全部」才 `POST` 落盘）。四通道区块由 `CH_META` 驱动（印章字/说明/是否可新增/本地通道表），节点行 `renderSetNode()` + 内联编辑表单 `renderSetForm()`（ID 内置只读、Key 密码框留空保留、可勾选清除）；`bindSettingsEvents()` 用事件委托处理新增/编辑/删除/测试/radio 启用切换；保存成功后重拉 `/api/config` 刷新顶部「本地渲染/AI 出图」标记。
- **关键函数**：
  - `init()`：拉 `/api/config`，渲染诗词库/音色（含映射说明）/配乐，支持 `?job=<id>` 直达历史任务。
  - `analyzePoem()` → `startJob({mode:"analyze"})`；`renderFilm()` → 携带编辑后 `analysis` 与 `reuseCandidate()`（同题同句才复用）发 `mode:"render"`。
  - `startPolling/pollJob`：**1.2s 轮询**任务视图（服务端另提供 SSE，双通道）；`renderPipeline()` 渲染五段流程条与总进度。
  - `onJobDone()`：渲染成片、分镜、导出区；`seekScene/videoTimeUpdate` 做缩略图与播放位置联动。
- 修改 `src/` 需重启服务（Node 无热加载）；改前端刷新浏览器即可。

---

## 8. 辅助脚本与数据文件

- [scripts/edge\_tts\_once.py](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/scripts/edge_tts_once.py)：Edge 神经语音单段合成。读文本文件 → `edge_tts.Communicate(voice/rate/pitch/volume)` → MP3；预处理兼容 `--rate -8%` 这类负号参数；失败重试 1 次。
- [data/poems.json](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/data/poems.json)：内置 3 首——`jingyesi`（静夜思·李白）、`chunxiao`（春晓·孟浩然）、`dengque`（登鹳雀楼·王之涣），每首含 lines/gloss/notes/script/persona/sceneDefs 完整数据。
- `docs/`：交付报告、人物一致性/硅基流动通道/先审后产/Edge 音色等迭代说明与故障复盘（HTML），及配图、音色样例等资产，属于过程文档而非运行依赖。

---

## 9. 模块依赖关系

### 9.1  import 关系（自底向上）

```
config.ts ──► (node 内置)
util.ts   ──► (node 内置)
types.ts  ──► (无)
svg.ts    ──► (无，纯字符串)
srt.ts    ──► types
text.ts   ──► types, config, util, data/poems.json
persona.ts──► types, text
scenes.ts ──► types
prompts.ts──► types, persona
audio.ts  ──► util(+FFmpeg)
image.ts  ──► types, config, util, prompts, svg(+浏览器/FFmpeg)
voice.ts  ──► types, config, util, audio(+Python/PowerShell/FFmpeg)
compose.ts──► types, config, util, srt(+FFmpeg)
pipeline.ts──► 上述全部工序模块
cli.ts    ──► config, pipeline, text, types, util
server.ts ──► config, pipeline, text, persona, voice, types, util
web/index.html ──► server.ts 暴露的 HTTP API（浏览器侧 fetch/SSE）
```


依赖方向严格自底向上，**基础层不反向依赖工序层**；所有跨模块数据结构统一收口在 `types.ts`。

### 9.2 外部进程/服务关系

```
image(svg)  ──spawn──► msedge.exe / chrome.exe --headless --screenshot
image(seedream) ──fetch──► 127.0.0.1:18432 (AutoClaw token) ──► autoglm-api.zhipuai.cn
image(LLM类) ──fetch──► 各 OpenAI 兼容 /images/generations
voice(edge) ──spawn python──► scripts/edge_tts_once.py ──► 微软 Edge 语音服务
voice(sapi) ──spawn powershell──► System.Speech(SAPI)
voice/compose/audio ──spawn──► ffmpeg / ffprobe
text(LLM)  ──fetch──► 各 OpenAI 兼容 /chat/completions
```

---

## 10. 关键机制剖析

1. **零依赖原生 TS**：全部用 Node 内置模块（`fs/path/http/crypto/child_process/url`）+ 全局 `fetch`/`AbortSignal.timeout`；TS 仅用可擦除语法，Node 22 直接执行。
2. **统一事件流**：流水线只认 `EventSink`；CLI 与 Server 是两个等价观察者（控制台进度条 / SSE 广播），新增接入方无需改流水线。
3. **内容哈希缓存（省钱核心）**：
   - 图片：`sha1(img-v1, provider, prompt, size)`；
   - 配音：`sha1(tts-v3, provider, profile, 语速音高, text)`；
   - 配乐：按类型 + 5s 时长分桶。
   - 编辑重合成走「复用旧图 → 增量配音 → 重新合成」。
4. **失败重试与降级**：生图 4 次指数退避；配音 1 次；LLM 失败降级内置/纯朗诵；edge 不可用降级 sapi；保证「随时能出片」。
5. **离线优先的通道设计**：默认 `offline + svg + edge(回退sapi) + synth`，无任何 Key 也能闭环；真实通道以环境变量/CLI 热切换。
6. **并发与串行化**：生图用 `pool` 并发（默认 2）；svg 截图因浏览器 profile 锁额外全局串行；服务端任务队列串行，避免渲染争用。
7. **时长回推时间轴**：分镜先有 `minDurMs`，配音完成后用真实音频时长 + 尾白回写 `durMs`，字幕/运镜/总时长全部以此为准。
8. **人物一致性注入**：分析期判定同一人 → 固定形象描述逐字进入每镜提示词，按 must/may 决定出镜强度。
9. **运镜代替视频生成**：静态意境图 + zoompan 推拉/横移得到动态感，把昂贵的图生视频留给后续升级。
10. **安全**：HTTP 仅绑 127.0.0.1；媒体接口校验 `..` 与绝对路径；请求体限 5MB；子进程一律参数数组直传（无 shell 注入面）。

---

## 11. 产物目录与清单

每次运行生成 `output/job-<jobId>/`：

| 文件                | 产生模块          | 说明                                           |
| ----------------- | ------------- | -------------------------------------------- |
| `video.mp4`       | compose       | 成片 1080×1920 · 30fps · H.264+AAC · faststart |
| `subtitles.srt`   | srt/pipeline  | 标准字幕                                         |
| `subtitles.ass`   | compose       | 烧制用样式字幕                                      |
| `cover.jpg`       | compose       | 0.8s 处封面帧                                    |
| `scene-N.png/jpg` | image         | 各分镜意境图                                       |
| `narration.wav`   | voice         | 整条旁白轨                                        |
| `voice/`          | voice         | 分段/场景 wav、PowerShell 脚本等中间件                  |
| `analysis.json`   | text/pipeline | 解析产物（可编辑后重合成）                                |
| `manifest.json`   | pipeline      | 任务清单（时间轴、通道、文件、tips）                         |

共享缓存位于 `output/cache/`（图片哈希文件、`voice/`、`audio/bgm-*`），另有 `.browser-profile/` 无头浏览器档案。

---

## 12. HTTP API 参考

基址 `http://127.0.0.1:<port>`（默认 7788），仅本机。

| 方法       | 路径                     | 说明                                                                                                                     |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET/HEAD | `/`                    | 返回 `web/index.html`                                                                                                    |
| GET      | `/api/config`          | 内置诗列表、音色解析结果、配乐项、尺寸、默认值与当前 provider                                                                                    |
| POST     | `/api/jobs`            | 创建任务。Body：`{poemId?, text?, title?, author?, dynasty?, analysis?, options?, mode: full\|analyze\|render}`；返回 `{jobId}` |
| GET      | `/api/jobs/:id`        | 任务视图：status/mode/stage/进度/events/analysis/manifest/result                                                              |
| GET      | `/api/jobs/:id/events` | **SSE** 事件流（连接时补发历史，结束发 `eof`）                                                                                         |
| GET      | `/api/works`           | 全量磁盘历史作品（读 manifest，按创建时间倒序；前端自行折叠展示最近 5 件）                                                  |
| GET      | `/api/settings`        | 通道设置脱敏视图（`{settings}`；无文件时按当前生效 provider 兜底，所见即所得）                                                                       |
| POST     | `/api/settings`        | 全量保存通道设置。Body：`{version:1, channels:{...{active, nodes[]}}}`；Key 语义：空串=保留、`"__clear__"`=清除；返回保存后的脱敏视图                    |
| POST     | `/api/settings/test`   | 节点连通性测试。Body：`{channel, node:{id, baseUrl, apiKey?}}`；返回 `{ok, status: ok\|warn\|error\|local, message}`                   |
| GET/HEAD | `/media/:jobId/:file`  | 产物文件分发，支持 `Range`（206，视频拖动）                                                                                            |

`options` 常用字段：`image / voice / bgm / narration / cropWatermark / freshImages / concurrency / reuseFrom`。

---

## 13. 配置项参考（环境变量）

模板见 [.env.example](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/.env.example)，均有离线兜底：

| 变量                                           | 作用                                      | 默认                                 |
| -------------------------------------------- | --------------------------------------- | ---------------------------------- |
| `SHIYING_TEXT_PROVIDER`                      | offline/glm/deepseek/openai             | offline                            |
| `SHIYING_TEXT_API_KEY / _BASE_URL / _MODEL`  | 文本通道凭据与端点                               | 预设 glm-4-flash 等                   |
| `SHIYING_IMAGE_PROVIDER`                     | svg/seedream/siliconflow/agnes/cogview/openai | svg                                |
| `SHIYING_IMAGE_API_KEY / _BASE_URL / _MODEL` | 图像通道凭据；另支持按通道命名 Key（如 `SHIYING_IMAGE_API_KEY_AGNES`，优先于通用 Key） | 预设 Kolors/cogview-3-flash/agnes-image-2.5-flash 等 |
| `SHIYING_AGNES_RPM`                          | agnes 通道出图速率上限（次/分），覆盖免费档默认 1K=10/2K=5 的自动节流 | 按出图档位取官方免费档限额                 |
| `SHIYING_MOTION_PROVIDER`                    | 动效工序：none（默认）/ agnes（agnes-video-2.5-flash 关键分镜图生视频） | none                               |
| `SHIYING_MOTION_SCENES`                      | 动效镜头选择："1,3,6"（1-based）/ "all"；缺省首镜+尾镜        | 首+尾                                |
| `SHIYING_MOTION_BASE_URL / _MODEL`           | 动效接口覆盖项                                             | api.agnes-ai.cn/v1 · agnes-video-2.5-flash |
| `SHIYING_VOICE_PROVIDER`                     | edge/sapi/openai/none                   | edge                               |
| `SHIYING_VOICE_API_KEY / _BASE_URL / _MODEL` | 语音通道                                    | tts-1                              |
| `SHIYING_PYTHON`                             | 含 edge-tts 的 Python 解释器                 | python                             |
| `SHIYING_BGM_PROVIDER`                       | synth/none                              | synth                              |
| `SHIYING_SIZE`                               | 输出尺寸                                    | 1080x1920                          |
| `SHIYING_OUT`                                | 产物根目录                                   | `<root>/output`                    |
| `SHIYING_CONCURRENCY`                        | 生图并发                                    | 2                                  |
| `SHIYING_KEEP_WATERMARK`                     | seedream 是否保留水印（`0` 裁切）                 | 1                                  |
| `SHIYING_SEEDREAM_TOKEN_SERVICE`             | 本地令牌服务                                  | <http://127.0.0.1:18432/get_token> |
| `SHIYING_BROWSER / SHIYING_FFMPEG`           | 可执行文件覆盖                                 | 自动发现                               |

> **工作台通道设置**：环境变量之上还有一层 `data/studio-settings.json`（工作台「通道配置」页写入），优先级为「设置文件 → `.env` → 内置预设」；节点留空字段自动回落 `.env`，保存后新任务即时生效。见 6.1a。

---

## 14. 项目运行方式

### 14.1 环境准备

- 安装 **Node.js ≥ 22.18**。
- 出片必需 **FFmpeg**（Windows：`winget install Gyan.FFmpeg`）；用默认 svg 画面需 **Edge/Chrome**。
- 推荐神经语音：`pip install edge-tts`（不装也能跑，自动回退系统语音）。
- 无需 `npm install` 即可运行；仅做类型检查时执行 `npm install`。

### 14.2 常用命令（package.json scripts）

```bash
node src/cli.ts check        # 或 npm run check  —— 环境体检
node src/cli.ts list         # 或 npm run list   —— 列出内置诗
node src/cli.ts run --poem jingyesi          # npm run run —— 一键出片
node src/cli.ts batch                         # npm run batch —— 批量出片
node src/cli.ts studio                        # npm run studio —— 工作台 → http://127.0.0.1:7788
npm run typecheck                            # tsc --noEmit 类型检查
```

### 14.3 run 常用参数与示例

```bash
# 任意诗词
node src/cli.ts run --file poem.txt --title 静夜思 --author 李白 --dynasty 唐

# 真实 AI 图 + 指定音色 + 无配乐
node src/cli.ts run --poem chunxiao --image seedream --voice qingzheng --bgm none

# 硅基流动通道（需 Key）
node src/cli.ts run --poem jingyesi --image siliconflow

# seedream 裁水印 / 忽略缓存全量重出 / 换端口
node src/cli.ts run --poem dengque --image seedream --crop-watermark
node src/cli.ts run --poem jingyesi --fresh-images
node src/cli.ts studio --port 8899
```

`run` 全部选项：`--poem --text --file --title --author --dynasty --image --text-provider --voice --narration both|line --bgm --size --crop-watermark --fresh-images --concurrency --out`。

### 14.4 工作台操作流程

1. `node src/cli.ts studio`，浏览器访问 `http://127.0.0.1:7788`；
2. 卷一研墨：选诗或输入任意诗词 → 生成解析与文案（只跑文本/分镜，不耗出图成本）；
3. 卷二展卷：行内修改逐句释义/背景/文案/人物形象；卷三调色：选风格、音色与配乐；
4. 卷三确认「落墨 · 开始生成成片」→ 卷四实时看五道工序进度 → 卷五钤印在线播放/拖动/导出 MP4、SRT、文案；
5. 后续修改回卷二「应用修改并重新合成」默认复用画面只重做声音与合成；换风格或勾选「重新生成意境图」则全量重出。

---

## 15. 扩展指南

- **新增画面/文本/语音通道**：在对应模块仿照现有分支增加 provider 实现，并在 `config.ts` 的 `*_PRESETS` 登记端点/模型；画面通道注意沿用缓存键与重试包装。
- **新增水墨场景**：在 [src/svg.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/svg.ts) 增构建器并注册 `SCENE_BUILDERS`，同时在 [src/prompts.ts](file:///c:/Users/qingx/.openclaw-autoclaw/agents/vibe-coding-2/workspace/shiying-workshop/src/prompts.ts) 的 `KIND_COMPOSITIONS` 补构图参考（两处 kind 需对齐），在 `scenes.ts` 关键词规则中可引用。
- **新增音色**：在 `VOICE_PROFILES` 增档案（补齐 sapi/edge/openai 三套参数）。
- **新增内置诗**：往 `data/poems.json` 加一条完整 `BuiltinPoem`（建议含 persona 与 sceneDefs）。
- **新增 CLI 选项**：`cli.ts` 解析 → `RunOptions`（types.ts）→ pipeline/各工序消费；工作台同步在 server `startJob` 与前端 `options` 接通。
- ~~升级图生视频~~：已完成（motion.ts，`--motion agnes`，2026-10-11 实测 2/2 镜出片）；后续可加更多视频通道（可灵/即梦/Vidu）。

---

## 16. 已知限制与设计取舍

- `cogview/openai` 的文本与语音通道按公开文档实现，**缺 Key 未在本机实测**；`siliconflow`（Kolors 720×1280）已实测、无平台水印；`agnes`（国内站 `api.agnes-ai.cn`，2K/9:16 = 1472×2624）已实测，免费档 429 由客户端节流 + Retry-After 退避兜底。
- `seedream` 依赖本机 AutoClaw 运行时的令牌服务，仅本机可用，出图带平台水印（可裁切）；项目不保存长期密钥。
- 离线模式下内置三首之外为**纯朗诵版**（无释义/文案），属有意设计的降级路径。
- ASS 字幕位置/字号按 1080×1920 调校，其他尺寸依赖 `buildAss` 的自适应参数。
- 1080×1920 约 80 秒成片，medium preset 下渲染约 2–3 分钟（视机器）。
- 服务端任务队列为**进程内串行**，状态不持久（历史产物靠磁盘 manifest 回看）；上云需外接队列/对象存储（见 readme 路线图）。

---

*本文档基于当前源码（`src/` 16 模块、`web/index.html`、`scripts/edge_tts_once.py`、`data/poems.json`）整理，代码变更后请同步更新对应小节。*
