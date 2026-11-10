# Phone Assistant：技术选型与架构设计

版本：v0.2

更新日期：2026-11-10（Asia/Shanghai）

状态：已进入原型实施；实际完成范围见 [实施记录](docs/IMPLEMENTATION_STATUS.md)。文中的性能数字仍为验收目标。

本文规划一个独立原生 iOS 助手 App，提供文字聊天、可阅读的回答、App 内语音交互，能够调用电脑 Codex、查询长期记忆并执行受支持手机操作。Siri 不是使用前提。电脑端明确采用 LangChain JS 构建助手 Agent。

## 1. 产品目标与必须先验证的前提

### 1.1 核心需求

1. 用户打开独立 iOS App，通过文字或 App 内语音与助手对话；回答和任务结果始终可以在界面阅读。
2. 助手可以创建、续接和取消电脑上的 Codex 任务，并朗读结果。
3. 历史问题优先使用自己的记忆系统，不为查历史而启动 Codex。
4. 用户插话后立即停止当前播报，听完新问题再回答。
5. 助手能够执行手机软件中的实际操作，并验证操作结果。
6. 手机仅承担必要的音频、界面、缓存和执行工作，电脑负责重计算和完整记录。

### 1.2 本版规划采用的工作假设

| 项目 | 暂定方案 | 状态 |
|---|---|---|
| 手机平台 | 普通、未越狱 iPhone，最低 iOS 18 作为产品候选基线 | 待目标机型确认 |
| 电脑平台 | Windows 优先，保留 macOS 适配边界 | 规划基线 |
| 用户规模 | 单用户、一台主电脑、一台主手机 | 第一版范围 |
| 网络 | 先局域网，后跨网络远程访问 | 阶段安排 |
| 模型部署 | 电脑调用配置的云端模型；允许后续接入电脑本地模型 | 默认方案，数据上传需明示 |
| 手机本地模型 | 第一版不作为必要依赖 | 技术决定 |
| 发行方式 | 先内部原型，是否公开上架尚未确定 | 待产品确认 |
| 目标手机软件 | 尚未指定，先验证 3 个 App、5 个核心动作 | 前置验证项 |

以上是用于推进设计的假设，不代表用户已经确认机型、云端授权或发行渠道。

### 1.3 iOS 能力边界

| 用户期望 | 普通 iOS App 的规划方式 |
|---|---|
| 独立 App 中聊天 | SwiftUI 原生界面，文字输入、语音输入、可阅读回答和历史记录 |
| Siri 唤起助手 | 仅作为未来可选入口，不属于当前必要依赖 |
| 活跃语音会话 | 用户明确开启后进行收音、识别、播报与打断 |
| 锁屏继续当前会话 | 作为真机验证项；依赖合法后台音频活动和系统调度 |
| 被结束后仍用自定义唤醒词随时启动 | 不作为第一版承诺 |
| 创建日历、提醒事项 | 使用获得授权的系统 API |
| 调用第三方 App 功能 | 使用该 App 明确提供的 API、链接或已安装快捷指令 |
| 通用跨 App 看屏幕、点击、输入 | 普通 iOS App 缺少可用于此目标的通用公开接口 |
| 读取任意 App 的私有数据 | 不属于普通应用权限范围 |

App Intents 使应用自身的动作能被 Siri、快捷指令等系统入口发现；并不自动授予调用其他应用全部动作的权限。跨应用访问仍受沙盒与公开接口约束。参见 [App Intents](https://developer.apple.com/documentation/appintents) 与 [Apple 平台安全说明](https://support.apple.com/en-my/guide/security/sec15bfe098e/web)。

### 1.4 决策门：通用手机操作是否为不可替代目标

**必须先验证执行能力，再扩大产品开发。**

- 如果目标动作有系统 API 或目标 App 的公开入口：继续本设计的 iOS 主线。
- 如果关键动作只能靠任意界面操作完成：普通 iOS 产品路线不满足该需求，需要明确选择下面的实验路线。
- iOS 实验路线：用 Appium／XCUITest／WebDriverAgent 在配置好的测试设备上验证；它不是普通 App 安装即用的能力。
- Android 实验路线：新增 Android 执行器，验证获授权的辅助功能操作；需要另行评估设备差异与发行政策。
- 若用户坚持“普通 iPhone＋安装即用＋任意 App 自主操作”，应记录需求与平台能力冲突，不能用增加模型规模或服务器算力掩盖。

Appium 真机方案需要开发配置、签名和设备信任，主要工具链依赖 macOS／Xcode，非 macOS 支持有限。[Appium 系统要求](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/system-requirements/)、[真机配置](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/)

Android 辅助功能 API 提供部分跨界面操作能力，但 Google Play 对自主规划和执行的辅助功能自动化有限制；内部验证成功不等于允许公开发行。[Android 开发文档](https://developer.android.com/guide/topics/ui/accessibility/service)、[Google Play 政策](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)

## 2. 第一版范围与架构决策

### 2.1 第一版交付范围

- 一个原生 iOS 客户端。
- 一个 Windows 用户会话内运行的电脑伴随服务。
- 一个助手 Agent：处理对话、历史问题、任务分派和结果解释。
- 一个 Codex 适配器：负责专用会话和执行事件。
- 一套电脑主存储与手机记忆副本。
- 一套手机能力目录，接入少量已经验证的动作。
- 文字输入、语音输入、流式文字输出、语音播报、插话中断。
- 配对、重连、任务恢复与最小诊断工具。

### 2.2 主要决策

| 编号 | 决策 | 原因 |
|---|---|---|
| ADR-001 | iOS 使用独立 Swift／SwiftUI App | 文字与 App 内语音并列，不依赖 Siri |
| ADR-002 | 电脑使用模块化单体服务 | 单用户阶段易部署、调试和恢复；模块接口保留拆分空间 |
| ADR-003 | 助手对话与 Codex 执行分离 | 历史问答不应等待代码执行器 |
| ADR-004 | 电脑权威存储＋手机选择性副本 | 兼顾完整记录、手机资源和本地查询速度 |
| ADR-005 | 原始记录＋摘要＋事实＋全文检索 | 避免只存摘要丢失证据，或提前引入复杂图数据库 |
| ADR-006 | 手机能力使用注册表与适配器 | 不把尚不存在的系统权限写进 Agent 规划能力 |
| ADR-007 | 播放中断与任务取消分别建模 | 插话必须快；任务取消需要执行端确认 |
| ADR-008 | REST 命令＋WebSocket 事件 | 容易处理鉴权、重试、流式进度和恢复 |
| ADR-009 | 先使用可观察的 ASR→文本模型→TTS 链路 | 便于调试转写错误、检索错误和打断问题 |
| ADR-010 | 不默认引入多 Agent 协作框架 | 当前复杂度主要在设备与状态一致性，而非 Agent 数量 |
| ADR-011 | 电脑助手使用 LangChain JS 的 createAgent＋类型化工具 | 按用户明确选型；Codex 保持为独立执行工具，任务状态由业务服务维护 |

## 3. 技术选型

版本策略：下面指定产品基线与必要的大版本。实施时固定依赖补丁版本和锁文件，并记录兼容性验证结果；不把“最新版本”作为运行时自动升级策略。

### 3.1 iOS

| 层次 | 选择 | 说明 |
|---|---|---|
| 语言与界面 | Swift 6、SwiftUI | 原生实现，配合结构化并发与 Actor 管理共享状态 |
| 最低系统 | iOS 18 候选基线 | 这是支持范围决策；上线前按目标机型调整 |
| 开发与构建 | 支持目标设备的稳定版 Xcode、Swift Package Manager | 真机签名与构建需要 macOS 环境；现有 Windows 不能独立承担完整 iOS 构建 |
| 音频采集 | AVAudioEngine、AVAudioSession | 统一管理录音、路由、来电中断和回声处理 |
| 语音识别 | Apple Speech 适配器，首版采用 SFSpeechRecognizer | 必须检测语言与服务可用性，处理识别任务结束及限额 |
| 说话检测 | 本地 VAD 适配器 | 第一轮比较系统音频处理结合轻量检测与可移植 VAD 实现，按误打断率选择 |
| 语音播报 | AVSpeechSynthesizer | 按句播放；后续可替换为远程 TTS |
| 数据库 | SQLite＋GRDB | 会话副本、事实、摘要、同步游标和本地待发送队列 |
| 网络 | URLSession、URLSessionWebSocketTask | HTTPS 请求和加密事件流 |
| 凭证 | Keychain | 保存设备私钥、会话凭证和信任材料 |
| 主入口 | SwiftUI App 内聊天页与麦克风按钮 | 无需 Siri；App Intents／App Shortcuts 作为未来可选扩展 |
| 初始手机动作 | EventKit、已验证应用链接与用户安装的快捷指令 | 日历／提醒事项优先作为可验证样例 |
| 测试 | Swift Testing／XCTest、XCUITest、Instruments | 重点测状态转换、真机音频和性能 |

Apple Speech 的识别可用性依赖语言和环境；文档要求处理单次任务时长及服务限制。不能将一个识别请求无限维持为永久监听。连续会话由应用管理多个识别任务，并在边界处避免重复转写和丢失首字。离线识别只有在运行时确认支持时才启用。[SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)

数据库封装选用 [GRDB](https://github.com/groue/GRDB.swift)。获得授权后可通过 [EventKit](https://developer.apple.com/documentation/eventkit) 操作日历和提醒事项。

### 3.2 电脑伴随服务

| 层次 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node.js 24 LTS，固定验证过的补丁版本 | 当前仍为 LTS；升级到其他 LTS 前验证原生依赖与 Codex |
| 语言 | TypeScript，开启严格类型检查 | 便于协议与适配器开发 |
| 包管理 | pnpm workspace | 单仓库管理服务、协议和测试工具 |
| HTTP 服务 | Fastify 5 | 插件化路由、请求校验与结构化日志 |
| WebSocket | 与 Fastify 版本匹配的 WebSocket 插件 | 长连接只在可运行时维持 |
| 数据库 | SQLite WAL＋better-sqlite3 | 单用户低维护；同步数据库调用放入专用 worker，避免阻塞语音控制事件 |
| 数据迁移 | 编号 SQL migrations | 数据结构可审计，支持迁移前备份与恢复 |
| 后台队列 | SQLite jobs 表＋单写入协调器 | 摘要、索引、同步任务先不引入 Redis |
| 日志 | Pino＋本地轮转文件 | 默认记录标识与时延，不记录凭证、原始音频及完整敏感内容 |
| Agent 编排 | LangChain JS createAgent＋Zod 工具 Schema | 模型／工具循环交给 LangChain；业务层保留持久化、去重、取消和权限校验 |
| 对话模型 | LangChain BaseChatModel 接口；首个适配器为 @langchain/openai 的 ChatOpenAI | 模型 ID 由 PA_AGENT_MODEL 配置；后续增加其他提供商适配器 |
| Codex | 本机 App Server＋stdio | 手机通过伴随服务访问，协议变化封装在适配器内 |
| 测试 | Vitest、契约样例、真实 App Server 冒烟验证 | 关注重试、取消、恢复和权限映射 |
| 初期管理入口 | CLI＋仅本机可用的简易管理页 | 配对、选择项目、查看连接与诊断 |
| 后续桌面壳 | 需要托盘与安装器时评估 Tauri | 不作为第一轮功能验证依赖 |

[Node.js 发布计划](https://nodejs.org/en/about/previous-releases) 将 24 列为 LTS；Fastify 与原生数据库绑定的实际组合仍需项目验证。[Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

对话循环采用 [LangChain createAgent](https://docs.langchain.com/oss/javascript/langchain/agents)，模型接入使用 [ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。LangChain 在电脑进程内运行，不需要额外部署 LangSmith 服务。助手模型、语音服务和 Codex 的授权、额度及费用分别记录；助手 API Key 只在电脑配置，不读取或复用 Codex 桌面登录令牌。

### 3.3 暂缓引入的组件

| 组件 | 暂缓原因 | 引入条件 |
|---|---|---|
| Neo4j 等图数据库 | 尚无大量跨实体、多跳查询证据 | 关系查询成为主要需求且普通关系表难以维护 |
| 独立向量数据库 | 单用户数据量小，增加运维负担 | 检索评测证明全文检索不足，再选择本地向量扩展或独立服务 |
| 手机大型语言模型 | 会扩大内存、功耗与机型差异 | 完全离线复杂问答被确认为硬需求 |
| 多 Agent 编排平台 | 增加调用次数与追踪复杂度 | 明确任务分工能带来可测收益 |
| 微服务、消息集群、Kubernetes | 当前不需要分布式容量 | 多用户或独立扩容成为实际需求 |
| 自建公网中继 | 会增加身份、路由和运维工作 | 局域网闭环通过后实现 |

## 4. 总体架构

~~~mermaid
flowchart TB
    User["用户"] --> ChatUI
    subgraph Phone["iPhone"]
        ChatUI["独立 SwiftUI App：文字聊天与任务结果"]
        Voice["语音会话与打断"]
        Session["会话控制器"]
        Cache["SQLite 记忆副本"]
        Executor["手机动作执行器"]
        ChatUI <--> Session
        ChatUI <--> Voice
        Voice <--> Session
        Session <--> Cache
        Session --> Executor
    end
    Session <-->|"HTTPS / WSS"| Gateway
    subgraph Desktop["电脑伴随服务"]
        Gateway["设备网关"]
        Agent["LangChain 助手 Agent"]
        Tasks["任务管理器"]
        Registry["能力与权限目录"]
        Adapter["Codex 适配器"]
        Codex["Codex App Server"]
        DB["原始记录与权威状态"]
        Worker["记忆整理与索引 Worker"]
        Gateway <--> Agent
        Agent <--> Registry
        Agent <--> Tasks
        Agent <--> DB
        Tasks <--> Adapter
        Adapter <--> Codex
        Tasks --> DB
        DB <--> Worker
    end
    Agent <-->|"少量必要上下文"| Model["云端或电脑本地模型"]
    DB -->|"增量同步"| Cache
    Registry -.->|"可执行能力"| Executor
~~~

### 4.1 部署边界

- 手机拥有音频播放控制权和手机动作最终执行权。
- 电脑拥有完整会话、任务状态、记忆整理和项目文件。
- 模型负责提出答案或结构化操作建议；执行器负责校验与实际调用。
- Codex 是电脑任务执行后端，不负责所有日常对话。
- 原型阶段，一个电脑服务进程加一个数据库／后台 worker 即可。
- 电脑伴随服务先在登录用户上下文中运行，方便访问已有登录和项目；不一开始改成系统级 Windows Service。

### 4.2 模块职责

| 模块 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| VoiceSession | 麦克风、播放回调、音频中断 | 转写、说话事件、播放位置 | 本地停播不等待网络 |
| ConversationController | 转写／文字、缓存、当前任务 | 本地答案或远程请求 | 管理有效回答代次 |
| Gateway | 已认证设备请求 | 响应与事件 | 权限、限流、重连 |
| LangChainAssistant | 用户问题与检索证据 | 流式回答、工具调用 | 历史检索结果不能当作执行指令；设备身份由服务注入 |
| TaskManager | 已校验的任务命令 | 权威任务状态 | 单任务取消与重复请求处理 |
| CodexAdapter | 项目、会话、输入 | 规范化执行事件 | 隔离版本差异 |
| CapabilityRegistry | 设备上报和已配置集成 | 可用动作列表 | 未注册能力不能被调度 |
| MemoryWorker | 新增原始事件 | 摘要、事实、索引 | 异步、可重建、可追溯 |
| SyncService | 手机游标与范围 | 变更页、快照 | 手机无需下载完整历史 |

### 4.3 LangChain 的实施边界

当前代码使用 `createAgent` 执行模型与工具循环，工具包括 `search_history`、`list_recent_tasks`、`get_task_status` 和 `submit_codex_task`。前两项直接访问助手自己的电脑数据库；查询历史不启动 Codex。下一阶段把关键词检索替换为摘要、事实、全文索引和按需语义检索，仍遵循第 8 节的存储方案。

`ChatService` 管理聊天请求幂等性、回答代次、取消和持久化；`TaskService` 管理 Codex 串行任务、权限审批和任务恢复。模型不能提供设备身份、任意工作目录，也没有自动批准执行的工具。每轮最多提交一个 Codex 任务，并立即返回可追踪的任务编号。

聊天和执行任务有各自 ID。新问题会停止旧回答，已经提交的电脑任务继续按独立任务生命周期运行；需要停止执行时使用任务上的停止按钮。服务重启后不重放未完成的工具调用，未完成回答标为停止，Codex 未确认任务标为未知。

本阶段通过 SQLite 的近期记录重建有长度上限的对话上下文；尚未实现 LangGraph 检查点恢复工具循环。未来引入检查点时，必须继续使用现有持久幂等键，不能因为恢复图状态而重复执行电脑工作。

## 5. 手机操作能力设计

### 5.1 能力必须显式注册

每个动作至少声明：

~~~json
{
  "capability_id": "ios.reminders.create",
  "version": 1,
  "executor": "ios_native",
  "availability": "available",
  "requires_foreground": true,
  "requires_unlocked": true,
  "permission_state": "granted",
  "effect": "write",
  "cancellation": "before_dispatch",
  "result_verification": "read_back"
}
~~~

字段表示能力目录的协议设计。是否需要前台／解锁等值必须由对应动作验证得出，示例不是对所有 EventKit 操作的系统要求声明。输入和输出另有 JSON Schema，明确时间、时区、对象 ID 与必填字段。

能力目录来源为本应用实现的动作、用户安装并配置的快捷指令、以及已经验证的外部集成。第一版不假设可以自动枚举手机上所有 App 的所有动作。

### 5.2 执行优先级

1. 获授权的系统或服务 API。
2. 目标应用公开且可验证的动作。
3. 用户配置的快捷指令桥接。
4. 应用链接，仅用于其明确支持的导航或动作。
5. 专门的实验性 UI 执行器，仅在对应测试环境启用。

打开 URL 成功只代表系统接受了打开请求，不代表目标业务动作已经完成。快捷指令只有在返回可信结果或能核对状态时才标记成功；无法验证时使用“已发起／结果待确认”。

快捷指令桥接使用已安装、已授权的工作流，并传入经过校验的参数。切换应用、授权提示和回调丢失都属于正常的待处理状态。[Apple 快捷指令 URL 文档](https://support.apple.com/en-bn/guide/shortcuts/apd624386f42/ios)

### 5.3 初始能力清单

| 能力 | 后端 | 首轮验证点 |
|---|---|---|
| 创建提醒事项 | EventKit | 授权、日期解析、回读验证、重复请求 |
| 创建日历事件 | EventKit | 时区、日历选择、冲突、回读验证 |
| 打开指定应用页面 | 已验证链接 | 安装状态、跳转失败、是否真正支持目标路径 |
| 执行一个用户安装的快捷指令 | Shortcuts Bridge | 参数、前台切换、完成回调 |
| 提交电脑 Codex 任务 | CodexAdapter | 项目映射、流式事件、结果状态 |
| 查询任务状态 | TaskManager | 区分最新状态与手机缓存状态 |

微信、购物、外卖等第三方 App 的具体动作尚未核实，不在本表中预先宣称支持。

### 5.4 扩展执行器接口

~~~typescript
interface DeviceExecutor {
  listCapabilities(): Promise<Capability[]>;
  execute(command: ValidatedCommand): Promise<ExecutionReceipt>;
  cancel(executionId: string): Promise<CancelReceipt>;
  inspect(executionId: string): Promise<ExecutionStatus>;
}
~~~

原生 iOS、快捷指令、Android 和 Appium 实验执行器分别实现此接口。不同后端必须如实报告取消能力、观测范围与前后台要求。

## 6. Codex 接入与任务模型

### 6.1 接入方式

电脑服务启动本机 Codex App Server，通过 stdio 交换协议消息。连接后完成初始化，创建或恢复专用会话，再开始 turn；将流式消息与终态转换为本产品的事件。取消使用对应 turn 的中断请求。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

官方 CLI 参考当前将 App Server 标为实验性能力。第一版可作为验证后端，但产品发布前必须固定兼容版本、保留协议样例，并验证升级与回退。[Codex CLI 参考](https://learn.chatgpt.com/docs/cli/reference)

实施原则：

- 不解析桌面窗口文本，不依赖内部数据库格式。
- 不将 App Server 原始端口直接暴露给手机或公网。
- 业务层只调用本项目的 CodingAgentAdapter 接口。
- 连接复用，按需创建会话，不为每次查询重新启动进程。
- 将安装版本对应的协议类型固定在适配器内；不手写依赖未经确认的字段。
- 不把本工具环境中的内部 Codex 工具当成第三方产品可用的公开 API。

### 6.2 会话映射与并发

持久保存以下关联：

~~~text
assistant_conversation_id
project_id
codex_thread_id
task_id
codex_turn_id
adapter_version
~~~

第一版由助手管理专用会话。导入已有桌面聊天、同步桌面新消息、接管桌面进行中的任务，作为单独的兼容性验证事项。

同一 Codex 会话最多执行一个活跃 turn。同一工作目录的写任务默认串行；如后续增加并发写任务，使用隔离工作目录或 worktree，并设计合并步骤。

### 6.3 任务状态

~~~mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running
    queued --> cancelled
    running --> waiting_approval
    waiting_approval --> running
    waiting_approval --> cancel_requested
    running --> cancel_requested
    cancel_requested --> cancelled
    cancel_requested --> succeeded
    cancel_requested --> failed
    cancel_requested --> unknown
    running --> succeeded
    running --> failed
    running --> unknown
    unknown --> running
    unknown --> succeeded
    unknown --> failed
    unknown --> cancelled
~~~

取消与完成可能同时发生，因此收到取消请求后仍可能观察到任务已经完成。必须按执行器最终证据对账，不能强行覆盖为 cancelled。

unknown 表示服务重启或执行通道失联后暂时不能确定结果。手机网络断开本身不应把电脑仍在运行的任务改为 unknown。

### 6.4 重试、审批与恢复

- 创建任务使用 request_id 和输入摘要去重；相同 ID 配不同输入返回冲突。
- 接收任务后先持久化再确认；手机丢失确认时可查询原 request_id。
- 本地去重不等于外部动作绝对只执行一次。调用发生后、结果落库前崩溃，需要凭执行 ID 或业务标记对账；无法核实时禁止自动重放写操作。
- 将 Codex 实际发出的审批请求映射成手机上的明确动作，携带任务、turn、请求 ID、操作内容和有效期。
- 手机没有回应时保持等待或按超时规则终止，不将超时当作同意。
- 电脑重启后加载未结束任务，核对执行器状态；仅恢复可证明安全的步骤。
- 任务取消不会自动撤销已写入文件或其他已完成效果。
- 工具产物与执行事实仍要保存，即使对应回答已被用户打断。

## 7. 语音、回答与打断

### 7.1 首版语音链路

~~~text
手机麦克风
  → 音频会话与回声处理
  → 本地说话检测
  → 流式 ASR
  → 会话控制器
  → 本地记忆／助手模型／执行器
  → 流式文本
  → 分句
  → 手机 TTS 播报
~~~

首版以文字为跨设备主要载荷，减少音频网络依赖。Apple ASR 不可用时保留文字输入；需要长时间稳定连续识别时，增加独立的流式 ASR 后端。切换到会上传音频的后端前，在产品设置中明确说明。

首版语音回答优先输出结论、关键结果和下一步，长日志与代码在界面展示。正在执行的任务只能播报已观察到的进度，不能推测百分比或声称尚未确认的成功。

### 7.2 两个独立状态机

语音状态：

~~~text
inactive → listening → recognizing → thinking → speaking
                                              ↓
                                  interrupting → listening
~~~

任务状态独立维护，不能用“当前在说话／没有说话”推导任务是否运行。

### 7.3 插话时序

~~~mermaid
sequenceDiagram
    participant U as 用户
    participant P as 手机
    participant S as 助手服务
    participant E as 对应生成或执行后端
    S-->>P: 回答片段 generation=12
    P-->>U: 正在播报
    U->>P: 开始说话
    P->>P: 停播、清空队列、作废 generation=12
    P->>S: interrupt generation=12
    S->>S: 封锁该代次的新工具分派
    S->>E: 取消该回答的生成
    S-->>P: 旧代次晚到片段
    P->>P: 丢弃旧片段
    U->>P: 新问题说完
    P->>S: 新问题及已播放位置
    S-->>P: 新回答 generation=13
~~~

实施细节：

1. 本地检测到有效插话后立即停播，不等待 ASR 完整转写或服务端确认。
2. generation_id 标识一次可播报回答；手机和服务端都记录有效代次。
3. 所有新工具调用在执行前检查所属代次是否已经被取消；已失效回答不能继续发起新动作。
4. 服务端取消模型请求；若此回答直接对应一个 Codex turn，则请求中断该 turn。
5. 同一 Codex 会话的新 turn 等旧 turn 终态或完成必要恢复后再启动。
6. 检测说话开始和检测说话结束采用不同阈值；开始要快，结束需容忍停顿。
7. 保留少量录音预缓冲，避免 VAD 判定后才开始录音造成首字丢失。
8. 来电、耳机断开等系统音频中断使用独立事件，不误识别成用户新问题。

### 7.4 “停回答”与“停任务”的产品语义

| 行为 | 默认处理 |
|---|---|
| 用户在听解释时插话 | 立即停播、取消当前解释生成、听新问题 |
| 用户打断与 Codex turn 绑定的直接回答 | 同时请求中断该 turn |
| 后台任务进行中，用户打断一段进度播报 | 只取消进度播报；后台任务按既有授权继续 |
| 用户明确说停止／取消任务 | 向指定 task_id 发取消请求，显示等待确认 |
| 用户修改正在执行的任务目标 | 阻止冲突的新写操作，先处理原任务，再按新目标继续 |

“暂停”不是所有工具都支持的能力。后端只支持取消时，产品应显示停止，不能承诺能在任意步骤无损恢复。

### 7.5 用户实际听到的内容

保存 answer_id、generation_id、已完成句子编号、正在播放的句子、播放位置估计和 interrupted 标记。完整生成文本仍可作为记录保留，但下一轮对话需要知道哪些内容尚未确认被听到。

原生 TTS 的文字回调不一定等于精确声学播放位置，应按句子完成和保守进度标记，不能伪造逐字精确对齐。

如果后续替换为 Realtime 音频方案，需按所选传输处理取消、输出缓冲和未播放音频的上下文截断，不能只停止扬声器。[Realtime 会话与打断](https://developers.openai.com/api/docs/guides/realtime-conversations)

## 8. 记忆与检索

### 8.1 选择混合存储的原因

| 方案 | 优点 | 局限 | 本项目用途 |
|---|---|---|---|
| 摘要文件 | 可读、易导出 | 易遗漏，版本冲突与精确检索较弱 | 作为查看与导出格式 |
| 知识图谱 | 关系和依赖清晰 | 实体消歧、关系更新和证据维护成本高 | 先用关系表表达，后续按需扩展 |
| 向量检索 | 能找到语义相近内容 | 不擅长独立保证状态、时间和精确值 | 第二阶段根据评测补充 |
| 原始记录＋摘要＋事实＋检索索引 | 兼顾证据、上下文与查询速度 | 需要整理及版本管理 | 第一版主方案 |

SQLite 保存权威数据。Markdown 可导出给用户阅读，但不作为客户端间同步的主数据库。

### 8.2 数据层次

1. 原始记录：用户输入、可见助手输出、工具回执、任务事件。
2. 会话摘要：本次目标、已经完成的工作、待确认事项、决策理由。
3. 项目摘要：长期目标、当前阶段、关键约束、未完成任务。
4. 结构化事实：明确偏好、已确认决策、约定、对象关系。
5. 索引：项目／时间过滤、全文搜索、可选向量索引。

不依赖获取模型隐藏推理。记忆的事实依据是用户消息与可核对的执行证据。

### 8.3 数据表草案

| 表 | 关键字段 | 权威来源 |
|---|---|---|
| devices | id、public_key、revoked_at、last_seen | 配对与设备管理 |
| projects | id、display_name、allowed_root、permissions | 用户配置 |
| conversations | id、project_id、codex_thread_id、version | 会话服务 |
| messages | id、conversation_id、role、content、source、created_at | 原始输入输出 |
| tasks | id、request_id、state、executor、external_id、version | 任务管理器 |
| task_events | id、task_id、type、payload、event_seq | 执行器与任务管理器 |
| execution_receipts | id、task_id、capability_id、result、evidence | 实际动作回执 |
| approvals | id、task_id、request_digest、state、expires_at | 执行器审批流程 |
| playback_receipts | answer_id、generation_id、played_sentence、interrupted | 手机播放回调 |
| memories | id、kind、content、project_id、source_ids、status、version | 记忆整理与明确用户修正 |
| memory_relations | from_id、relation、to_id、source_ids | 关系提取或用户确认 |
| summaries | scope_id、content、source_watermark、version | 摘要任务 |
| memory_changes | cursor、entity_id、version、operation | 同步变更日志 |
| jobs | id、kind、input_digest、state、attempt、lease_until | 持久后台队列 |
| request_dedup | device_id、request_id、payload_hash、result_ref | 网关 |
| sync_state | device_id、scope、cursor、snapshot_version | 同步服务 |

原始时间保存 UTC 与必要的原始时区；“明天下午”按用户所在时区解析，默认场景为 Asia/Shanghai。时间不能仅保存成不带时区的展示字符串。

### 8.4 事实结构示例

~~~json
{
  "id": "mem_01",
  "kind": "decision",
  "project_id": "phone_assistant",
  "content": "第一版使用 SQLite 保存记忆",
  "reason": "需要本地检索和简单的增量同步",
  "source_ids": ["message_101", "message_108"],
  "status": "confirmed",
  "valid_from": "2026-11-09T02:00:00Z",
  "supersedes": null,
  "version": 1
}
~~~

status 区分 candidate、confirmed、superseded、retracted。模型推测不能直接变成用户已确认的偏好。任务成功与否以执行回执为准，不由摘要模型推断。

### 8.5 整理流程

~~~text
原始事件落库
  → 提交后台整理任务
  → 提取候选事实与增量摘要
  → 检查证据、重复、冲突和作用范围
  → 原子提交记忆版本与变更日志
  → 更新索引
  → 手机增量同步
~~~

任务状态可以立即同步；摘要稍后生成，二者不互相阻塞。摘要记录覆盖到哪个原始事件，避免把未整理完的内容当作完整历史。

每次整理以新增原始消息和相关原始证据为输入；定期从原始记录重建项目摘要，避免无限摘要压缩。用户更正应形成有出处的新版本。

### 8.6 查询路径

- 明确事实问题：优先查本地结构化字段，可用模板回答。
- 原因／比较问题：按项目和时间召回摘要及原文片段，再交给助手模型组织解释。
- 精确引用／旧日志问题：摘要不足时按 source_id 拉取对应原文，不下载整段会话。
- 证据不足时明确说明缺失内容，不能用模型记忆补成事实。
- 回答在界面提供来源和数据更新时间；语音仅在影响结论时说明新鲜度。

初期全文检索使用 FTS5，中文在写入和查询时使用相同的规范化与分词／n-gram 规则，单独测试中英混合与代码标识符。[SQLite FTS5](https://www.sqlite.org/fts5.html)

若以后加入向量索引，保存 embedding_model、dimension 和 version；模型更换需要重建索引。手机只缓存部分向量时，不应声称拥有完整检索覆盖。

## 9. 手机缓存与同步

### 9.1 缓存内容与预算

手机初始记忆预算设为 100 MB，可调整为 50～150 MB；这是产品预算，不是对运行内存或安装包大小的保证。

优先保留当前会话、近期项目摘要、已确认偏好、重要决策、未结束任务和常用证据片段。完整附件、代码差异、大日志和原始音频不默认同步。

淘汰依据为容量、访问时间、项目活跃程度和固定保留标记。待发送消息、待确认动作与未结束任务不能被普通缓存淘汰移除。

### 9.2 同步协议

1. 电脑为记忆变更分配单调递增 cursor。
2. 手机以 after_cursor 请求一页变更，服务器返回 next_cursor 与 has_more。
3. 同一事务提交数据变更及本地游标；失败则整页重试。
4. 按实体 ID 和 version 去重，允许重复投递。
5. 删除使用 tombstone；相关摘要与索引同时失效或重新生成。
6. 游标过旧时返回需要快照；手机以快照基准 cursor 建立副本，再补增量。
7. 快照的基准游标与内容必须一致，避免快照生成期间的新消息丢失。

电脑是共享记忆的主写入方。手机新增消息和用户更正先存入本地 outbox，以唯一 ID 提交电脑；手机可以展示临时状态，但不擅自覆盖电脑的事实版本。更正冲突依据实体版本检测，不单纯使用设备时间的最后写入胜出。

### 9.3 前后台行为

| 场景 | 行为 |
|---|---|
| 前台／活跃语音会话 | 持续接收变更并同步 |
| 进入后台 | 依系统允许的运行时间处理必要工作 |
| 后台通知 | 只作为可用时触发同步的提示 |
| 重新打开 | 立即补增量，显示最后同步时间 |
| 电脑离线 | 使用本地副本；明确最新状态无法核实 |
| 手机断网 | 保留未发送文字；不自动延后执行有副作用的过时命令 |

后台通知可能延迟或不投递，不能用它保证手机记忆始终实时。[Apple 后台通知说明](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)

### 9.4 离线能力的准确边界

- 本地数据查看和结构化事实查询可离线工作。
- 语音离线可用取决于设备、语言和已安装能力，不能统一保证。
- 第一版开放式复杂历史问答仍依赖电脑助手模型。
- 电脑离线且必须支持复杂问答时，需要增加端侧模型或独立云端助手；它不是“多缓存一些文字”就能自动实现的能力。

## 10. 对外接口与事件协议

以下是本产品拟定的协议，不是 Codex 原始接口。业务请求和事件均带 protocol_version；服务端校验设备、作用域、参数与会话归属。

### 10.1 HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /v1/pairings/claim | 兑换一次性配对材料，绑定设备 |
| POST | /v1/sessions/refresh | 刷新设备会话 |
| GET | /v1/capabilities | 查询可用能力及限制 |
| POST | /v1/conversations | 创建助手会话 |
| POST | /v1/conversations/{id}/messages | 提交文字或最终转写 |
| POST | /v1/conversations/{id}/interrupt | 中断指定回答代次 |
| POST | /v1/tasks | 创建明确的执行任务 |
| GET | /v1/tasks/{id} | 查询权威状态与版本 |
| POST | /v1/tasks/{id}/cancel | 请求取消任务 |
| POST | /v1/approvals/{id}/decision | 回答有效审批请求 |
| POST | /v1/memory/search | 电脑端检索 |
| GET | /v1/sync/changes | 按 cursor 拉取变更 |
| GET | /v1/sync/snapshot | 获取指定范围的一致快照 |
| POST | /v1/device-executions/{id}/receipt | 上传手机动作结果 |
| POST | /v1/playback/receipts | 上报实际播放进度 |
| GET | /v1/events | 建立鉴权后的 WebSocket 事件通道 |

配对入口必须依赖短期、一次性材料；其他业务接口需要设备认证。命令路径中的 ID 与登录设备权限共同校验，不能只凭知道一个任务 ID 就访问它。

### 10.2 持久事件封装

~~~json
{
  "protocol_version": 1,
  "event_id": "evt_001",
  "event_seq": 418,
  "type": "task.status.changed",
  "conversation_id": "conv_001",
  "task_id": "task_001",
  "generation_id": null,
  "causation_id": "req_001",
  "occurred_at": "2026-11-09T02:00:00Z",
  "payload": {
    "status": "running",
    "version": 2
  }
}
~~~

event_seq 是本账号范围内持久事件的恢复序号；memory cursor 是记忆变更游标，两者不能混用。客户端请求重放时，只返回其获授权的事件。

### 10.3 主要事件

~~~text
message.accepted
assistant.text.delta
assistant.answer.completed
assistant.answer.interrupted
task.status.changed
task.progress
approval.required
device.action.requested
device.action.finished
memory.updated
sync.required
connection.health.changed
~~~

回答文本片段可适度合并后持久化；临时 ASR 结果、心跳和音频帧走独立的非持久消息格式。重连恢复文字与任务状态，不自动重播旧语音。

### 10.4 请求一致性

- 所有写命令有 request_id；数据库对 device_id＋request_id 建唯一约束。
- 请求重复且内容一致时返回原结果；内容不一致时返回冲突。
- 控制命令使用独立处理路径，不排在长时间模型调用或音频队列后面。
- 状态返回 version；手机拒绝将旧版本状态覆盖到新版本。
- 外部副作用不承诺分布式“恰好一次”；用去重、回执和对账控制重复风险。
- 事件至少一次投递，客户端按 event_id 去重；慢客户端通过重连追赶，不能无限积压内存。

## 11. 延迟、资源与费用预算

### 11.1 测量定义

区分以下时间：

- 唤起时间：系统入口触发到助手可接收输入。
- 首个有效回答时间：用户说完到开始播放有实际内容的回答；不把“正在处理”算作有效回答。
- 任务确认时间：服务端接受并持久化任务的时间。
- 任务完成时间：实际业务动作完成并得到验证的时间。
- 本地停播时间：检测到有效用户语音到音频输出停止的时间。

以下为原型验收候选目标，条件是应用已进入语音会话、电脑在线、连接已建立。冷启动、系统唤起、弱网和模型排队单独报告。

| 指标 | 候选目标 | 验证方式 |
|---|---|---|
| 本地缓存检索 | 目标 P95 ≤ 100 ms | 指定规模的真实中文记忆集合 |
| 本地打断停播 | 目标 P95 ≤ 250 ms | 对齐音频采集与实际输出时间 |
| 简单本地事实问答首声 | 典型目标 ≤ 1 s | 从用户说完开始计时 |
| 云端模型问答首声 | 典型预算 1.5～4 s | 分别报告 P50、P95 和失败率 |
| 简单手机动作 | 典型预算 1～3 s | 仅适用于已授权、无人工交互的动作 |
| Codex 任务接受确认 | 局域网目标 P95 ≤ 1 s | 不包含执行任务的耗时 |
| Codex 实际完成 | 不设统一秒级承诺 | 按任务类别统计 |
| 旧回答晚到片段被播放 | 验收用例中为 0 | 人工延迟、乱序与重放事件 |

这些数字不是已测性能。模型与设备选择应以测量结果修改目标，而不是将目标写成产品保证。

### 11.2 优化优先级

1. 本地播放控制与 VAD 不走网络。
2. 明确事实优先查结构化数据，避免每次调用大模型。
3. 语音边说边识别，文字按句播报。
4. 预先生成摘要并同步，不在用户提问时整理所有历史。
5. 连接、会话和模型上下文按需要复用。
6. 工具结果只传必要摘要；大日志按需读取。
7. 控制路径不运行同步全文索引或大型数据库扫描。
8. 最后才考虑更复杂的缓存、向量索引或更快模型。

### 11.3 手机资源策略

- 只在用户开启的活跃会话中持续收音。
- 使用有限长度的音频环形缓冲，默认不保存完整原始录音。
- 不默认运行手机端大型语言或视觉模型。
- 不持续录屏上传；实验性视觉执行器只在动作验证需要时采样。
- 后台整理、嵌入与大批量索引放在电脑。
- 缓存使用磁盘预算，不把全部历史加载进运行内存。

容量示例：单声道 16 kHz、16 位 PCM 约 32 KB／秒，10 秒约 320 KB。10,000 条平均 1 KB 的正文约 10 MB，索引和元数据另计。这只是计算示例，不能代表应用全部资源消耗。

设备验收至少覆盖两档目标 iPhone，记录空闲、连续对话 30 分钟、插话密集和后台切换场景的内存、耗电、温度及掉帧。语音系统还需遵守平台的后台音频运行方式。[Apple 音频指南](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/AudioGuidelinesByAppType/AudioGuidelinesByAppType.html)

### 11.4 模型与费用控制

- 单独统计对话生成、记忆整理、ASR、TTS 与 Codex 使用。
- 模型配置包含 provider、model_id、超时、单次预算和用户总预算。
- 记忆整理合并短消息后执行，避免每个 token 触发一次模型请求。
- 超时先取消旧请求并核对终态，不同时启动多个会产生副作用的重试。
- 第一版不在文档中承诺具体月费；选定模型和使用频率后按实测用量估算。
- 账号可用地区、网络条件和模型访问权限作为部署检查项。

## 12. 配对、部署与数据保护

### 12.1 局域网第一版

~~~text
iPhone
  └─ HTTPS / WSS
       └─ 电脑伴随服务
            ├─ SQLite 数据与后台 worker
            ├─ stdio → Codex
            └─ HTTPS → 已配置模型供应商
~~~

使用二维码携带电脑标识、连接地址、证书／公钥指纹和短期一次性配对材料。二维码是用户可见的首次信任通道；配对后设备通过独立凭证认证，材料兑换后失效。

TLS 信任验证只接受配对的主机密钥及其受控轮换，不全局忽略证书错误。自签证书、ATS 与 URLSession 的具体组合必须在真机通过验证；若该组合不满足平台要求，改用受信证书或已有安全隧道。

局域网发现可后续使用 Bonjour；初次验证允许扫描二维码或手动填写地址，避免将发现协议作为核心前置条件。

### 12.2 外网阶段

建议顺序：

1. 内部试用通过已有的安全网络／隧道验证跨网体验。
2. 产品化时增加设备身份服务和中继，两端主动建立出站连接。
3. 控制与同步载荷使用经过审查的标准加密方案；若要求中继不可见内容，明确实现应用层端到端加密，不能仅凭 HTTPS 宣称端到端。
4. 中继失效时保留本地历史能力，显示电脑连接不可用。
5. 推送只携带必要通知信息，详细内容通过认证通道获取。

电脑休眠不会因为普通 WebSocket 请求自动唤醒。网络唤醒或常在线主机属于后续可选部署能力。

### 12.3 操作与数据边界

- 电脑项目根目录由用户登记；远程请求不能随意指定任意系统路径。
- 保留 Codex 自身权限与沙盒语义，不默认关闭审批。
- 手机动作在手机上再次检查权限、前台和解锁条件。
- 历史文本、网页内容、工具输出属于待分析数据，不能修改执行权限。
- 手机设备凭证可撤销；撤销后停止事件订阅与后续任务提交。
- 电脑凭证保存在操作系统提供的凭证保护机制中，手机凭证放 Keychain。
- 日志默认脱敏；详细诊断导出由用户主动触发。
- 原始记录与索引的删除应覆盖手机副本、派生记忆和备份保留策略；不能只删除界面中的一条消息。
- 已离线设备的删除同步无法即时完成，必须记录待同步状态；必要时撤销该设备访问。

本产品不是任意远程 shell。Agent 只能在已授权项目与能力集合中分派任务。

## 13. 项目目录规划

单仓库，Swift 工程与 TypeScript workspace 分别使用各自工具链。

~~~text
phone_assistant/
├─ TECHNICAL_ARCHITECTURE.md
├─ apps/
│  ├─ ios/
│  │  ├─ PhoneAssistant/
│  │  │  ├─ App/
│  │  │  ├─ Features/
│  │  │  │  ├─ Conversation/
│  │  │  │  ├─ Tasks/
│  │  │  │  ├─ Memories/
│  │  │  │  └─ Settings/
│  │  │  ├─ Voice/
│  │  │  ├─ Networking/
│  │  │  ├─ Persistence/
│  │  │  ├─ Sync/
│  │  │  ├─ DeviceActions/
│  │  │  └─ AppIntents/
│  │  └─ PhoneAssistantTests/
│  └─ companion/
│     ├─ src/
│     │  ├─ gateway/
│     │  ├─ identity/
│     │  ├─ conversations/
│     │  ├─ orchestration/
│     │  ├─ tasks/
│     │  ├─ capabilities/
│     │  ├─ memory/
│     │  ├─ sync/
│     │  ├─ workers/
│     │  ├─ storage/
│     │  └─ diagnostics/
│     └─ tests/
├─ packages/
│  ├─ protocol/
│  │  ├─ schemas/
│  │  ├─ fixtures/
│  │  └─ generated/
│  ├─ codex-adapter/
│  ├─ llm-provider/
│  └─ test-support/
├─ experiments/
│  ├─ ios-capabilities/
│  ├─ ios-audio/
│  └─ ui-executor/
├─ migrations/
│  ├─ desktop/
│  └─ ios/
├─ scripts/
└─ docs/
   ├─ decisions/
   ├─ capability-matrix.md
   ├─ compatibility.md
   └─ test-reports/
~~~

这是拟建结构；本次仅创建规划文档，不代表目录中的代码已经存在。

协议 JSON Schema 是消息结构的唯一规范源，TypeScript 类型和 Swift Codable 类型依据规范生成或维护，并共享契约样例。Swift／TypeScript 的日期、可选字段、整数范围和枚举未知值都要显式处理。

运行时数据库、凭证、日志与原始音频放在应用数据目录，不提交进仓库。迁移脚本、协议样例和匿名化测试样本可以进入版本控制。

## 14. 失败与降级策略

| 情况 | 用户可见行为 | 系统动作 |
|---|---|---|
| 电脑关机／休眠 | 可查看历史，电脑任务不可执行 | 不假装任务已接受 |
| 手机断网 | 显示离线，允许本地查询与文字草稿 | outbox 保存；有副作用命令重连后重新核对时效 |
| ASR 不可用 | 显示文字输入或按配置切换识别后端 | 保留原会话，不死循环请求 |
| 模型超时 | 显示本次回答失败，可重试 | 取消旧生成，保留证据和任务状态 |
| Codex 需要审批 | 展示待确认操作 | 保持 waiting_approval |
| Codex 进程退出 | 显示执行状态待核对 | 对账原任务，避免盲目重复执行 |
| 手机动作要求前台 | 提示回到助手／目标界面继续 | 不声称已执行 |
| 应用链接打开但无回执 | 显示已打开或已发起 | 不标为业务成功 |
| 用户插话后旧包到达 | 不继续播报旧内容 | 丢弃失效 generation |
| 缓存没有历史证据 | 在线时检索电脑，离线时说明缺失 | 不编造具体决定 |
| 手机与电脑记忆版本冲突 | 保留更正记录和当前有效版本 | 拉取最新并进行显式合并 |
| 手机中途被系统结束 | 重新打开后恢复状态 | 从持久游标和本地 outbox 续接 |

## 15. 实施阶段与验收门槛

工作量为功能开发的粗略人日估算，假定开发者熟悉相应技术，具备 Mac、目标 iPhone、Windows 测试机和必要账号。它不是承诺工期，不包含应用商店审核与未知平台问题。

| 阶段 | 工作内容 | 交付物 | 通过条件 | 粗略工作量 |
|---|---|---|---|---|
| P0：可行性验证 | 3 个目标 App／5 个核心动作、语音打断、Codex 协议和版本验证 | 能力矩阵、真机报告、路线决定 | 核心动作有实际执行路径，限制明确 | 5～8 人日 |
| P1：文字闭环 | 独立 iOS 聊天界面、设备配对、LangChain 助手、Codex 工具、事件与取消 | 手机文字控制电脑原型 | 重连后状态正确，重试不重复创建任务 | 5～8 人日 |
| P2：语音闭环 | ASR、TTS、VAD、回声处理、代次取消 | 可连续语音对话的原型 | 插话能停播，旧回答不复活，音频中断可恢复 | 7～12 人日 |
| P3：记忆与同步 | 原始记录、摘要、事实、检索、手机副本 | 带出处的历史问答 | 能区分旧决定与新决定，离线行为准确 | 6～10 人日 |
| P4：手机动作 | 接入 P0 验证的动作、参数与结果核对 | 支持明确能力列表的助手 | 所有宣称成功的动作有验证证据 | 5～8 人日 |
| P5：稳定化与远程 | 跨网验证、打包、诊断、恢复和资源优化 | 内部测试版本与报告 | 核心场景通过故障注入和真机持续使用 | 7～12 人日 |

完整规划约 35～58 人日，仅作为初始资源估算。P0 未通过前，不应把后续阶段总投入视为已经决定。平台路线改变、UI 自动化和商业发行会产生额外工作。

### 15.1 P0 必须回答的问题

1. 指定 App 的指定动作是否有可用接口、快捷指令或受支持执行途径？
2. 若只能 UI 自动化，用户是否接受专用测试环境或 Android 路线？
3. 真机扬声器下，助手声音是否会触发误打断？
4. 中文、代码术语和中英混合转写是否足以支持实际任务？
5. 锁屏、来电和切换 App 后，音频与会话能否按预期恢复？
6. 本机 Codex 版本是否支持需要的会话、事件、审批和取消行为？
7. 创建专用 Codex 会话是否满足需求，还是必须双向同步已有桌面聊天？

### 15.2 P0 的继续／调整规则

- 核心手机动作无执行路径：先调整平台或产品范围，不能仅标记为“以后优化”。
- 只有后台音频不满足：可以收敛为前台语音体验，但必须由产品明确接受。
- 系统 ASR 不满足长会话：比较替代识别后端的延迟、费用和资源，再继续。
- Codex 版本不兼容：修正适配层或固定已验证版本；不先绑定无法验证的内部实现。
- 只有少量非核心动作缺失：明确支持列表和人工衔接方式后进入 P1。

## 16. 验证计划与可观察性

### 16.1 必须覆盖的用例

| 范围 | 用例 |
|---|---|
| 语音 | 外放、蓝牙耳机、中文停顿、说话重叠、长句、来电、音频路由改变 |
| 打断 | 播放中插话、生成中插话、取消后旧文本到达、取消与完成竞争 |
| 网络 | 请求发出后断网、已接受但确认丢失、WebSocket 重连、事件重复 |
| 任务 | 取消排队任务、取消运行任务、审批超时、进程退出、状态未知恢复 |
| 记忆 | 用户更正、旧决定被替代、摘要未覆盖最新消息、准确引用、删除传播 |
| 同步 | 重复页、提交前崩溃、游标过期、快照期间新增记录、手机离线新增消息 |
| 手机动作 | 权限拒绝、未安装目标 App、要求解锁、回调缺失、重复执行防护 |
| 权限 | 撤销设备、跨项目访问、过期审批、篡改动作参数 |
| 性能 | 连续 30 分钟对话、较大缓存、慢客户端、后台整理与语音同时运行 |

### 16.2 测量字段

统一关联 trace_id、request_id、conversation_id、task_id、generation_id 和 adapter_version。

记录 user_speech_end、asr_final、request_received、retrieval_done、model_first_text、tts_started、speech_detected、playback_stopped、tool_started、tool_finished。

同一设备内的时长使用单调时钟。跨设备端到端耗时优先由手机起止点测量，不能直接相减未校准的手机与电脑墙上时钟。

### 16.3 原型验收方式

- 建立至少 30 个真实中文语音和历史问答样例，包含否定、更正、日期和指代。
- 每个关键手机动作重复执行并加入异常场景，分别统计成功、失败与无法确认。
- P0 先建立耗电／内存基线，后续按相同机型和条件比较；不凭单次体验声明低功耗。
- 模型答案质量、检索命中率、首声时延、动作完成率分别记录，避免一个综合评分掩盖问题。
- 单元测试只覆盖状态机、协议、去重和关键数据逻辑；真实音频与跨 App 能力必须真机验证。

## 17. 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 普通 iOS 不支持核心跨 App 动作 | 产品目标无法实现 | P0 能力验证作为继续开发门槛 |
| 自用原型与商业发行条件不同 | 技术演示无法直接转产品 | 分别维护执行能力与发行可行性结论 |
| Codex 实验性接口变化 | 升级后无法运行 | 适配器隔离、固定版本、契约样例与回退 |
| ASR 长会话与可用性限制 | 识别停止或首字丢失 | 分段会话管理、预缓冲、替代后端 |
| 依赖电脑常在线 | 外出体验不稳定 | 准确离线能力、远程连接、可选常在线主机 |
| 摘要丢失或扭曲事实 | 历史回答不可信 | 原文证据、版本、来源和重建 |
| 取消只能停止后续执行 | 用户误认为已撤销操作 | 明确取消状态与已完成效果 |
| UI 自动化耗时与易变 | 多步任务慢、成功率低 | 优先 API，逐步核对，限制首版动作范围 |
| 手机持续语音耗电 | 使用时长受限 | 活跃会话模式、轻量手机端、实测资源 |
| 弱网重试产生重复副作用 | 重复创建或发送 | request_id、回执、对账、未知状态不盲重试 |

## 18. 待产品确认的事项

这些事项不影响完成架构规划，但会影响 P0 的验证样例与最终支持范围：

1. 首批 3～5 个手机 App，以及每个 App 的具体目标动作。
2. 自用、少量内部用户，还是面向公众上架。
3. 是否允许专用测试手机、开发者模式，或调整为 Android。
4. 必须持续锁屏语音，还是允许用户先进入助手会话。
5. 是否必须连接桌面 Codex 已有聊天，还是可以使用助手专用会话。
6. 是否允许云端模型处理必要的语音／对话片段。
7. 电脑离线时需要做到何种程度的问答与手机操作。
8. 目标 iPhone 型号、iOS 版本、可用 Mac 构建环境和预期日使用时长。

已完成电脑端 Codex 接入的初步验证并实现 LangChain 聊天原型。后续先在 Mac 编译独立 iOS 客户端并进行真机联调，再完成手机动作能力矩阵、自动语音打断与记忆检索评测。不要将本文规划的全部能力等同于当前已交付功能。
