# Phone Assistant

独立 iOS 助手 App＋基于 LangChain 的电脑助手。手机提供文字聊天与 App 内语音，Siri 不是使用前提。总体规划见 [技术架构](TECHNICAL_ARCHITECTURE.md)，实际交付范围见 [实施记录](docs/IMPLEMENTATION_STATUS.md)。

电脑端已实现 LangChain `createAgent`、普通聊天、历史关键词查询、Codex 任务工具、流式文字与回答取消，并保留 HTTPS 配对、持久任务、审批、任务取消和事件重放。SwiftUI 源码提供聊天页、电脑任务页、本地缓存、语音转文字、结果朗读和按钮打断。

iOS 客户端已通过 macOS／Xcode 16.4 编译及模拟器状态、界面测试；尚未完成 iPhone 真机配对与真实模型联调，当前没有签名 IPA。自动语音插话检测、自动播报、长期记忆提取／语义搜索、手机动作执行器尚未实现。当前语音为点按录入、编辑后发送和手动朗读。

~~~text
iOS 独立 App：文字 / App 内语音 → HTTPS / WSS
                                      ↓
                           LangChain Assistant
                             ├─ 直接对话
                             ├─ 查询助手自己的历史
                             └─ Codex 工具 → TaskService → Codex App Server
                                      ↓
                           SQLite 记录 + 流式文字回传
~~~

## 运行电脑服务

要求 Node.js 24、pnpm 11，以及用于电脑任务的已登录 Codex CLI。LangChain 聊天还需要独立的模型 API 配置。本次验证机器为 Windows，Codex 版本为 0.166.0-alpha.6；App Server 为实验性接口，升级后需重新运行验证。

~~~powershell
Set-Location D:\project\phone_assistant
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:service
pnpm start
~~~

默认只监听 127.0.0.1:4318。服务会生成本机 TLS 证书，并打印一次性配对码和证书 SHA-256 指纹。配对码 5 分钟内有效，使用一次后失效；需要重新配对时重启服务。

启动聊天功能前，在电脑当前 PowerShell 会话中配置：

~~~powershell
$env:PA_AGENT_MODEL = "替换为你可用且支持工具调用的模型ID"
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "输入模型 API Key" -AsSecureString)).Password
pnpm start
~~~

当前模型适配器是 `@langchain/openai` 的 `ChatOpenAI`；LangChain 在本机进程中运行，无需 LangSmith 账号。API Key 不发给手机，也不读取 Codex 桌面的登录令牌。未配置模型时，服务明确报告聊天不可用，保留 Codex 直接任务接口，不返回模拟回答。当前环境未配置模型 API，因此尚未验证真实 LangChain 云端推理的延迟和效果。

如需同一局域网内的 iPhone 连接：

~~~powershell
$env:PA_HOST = "0.0.0.0"
$env:PA_PROJECT_ROOT = "D:\project\phone_assistant"
pnpm start
~~~

手机填写 https://电脑的局域网IP:4318，不能填写 0.0.0.0 或 127.0.0.1。必要时在 Windows 防火墙仅为受信任专用网络开放此端口；本项目不会自动修改防火墙。

默认 Codex 工作在 read-only 沙盒。需要在配置的项目内修改文件时，在电脑上明确设置：

~~~powershell
$env:PA_SANDBOX = "workspace-write"
pnpm start
~~~

项目根目录由电脑启动配置决定，手机不能提交任意 cwd。Codex 的命令／文件审批显示在手机上；本客户端尚未支持的交互请求返回错误，不自动同意。

可用环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| PA_HOST | 127.0.0.1 | 监听地址 |
| PA_PORT | 4318 | HTTPS 端口 |
| PA_DATA_DIR | .local | SQLite 与 TLS 私钥目录 |
| PA_PROJECT_ROOT | 当前目录 | 允许操作的项目 |
| PA_CODEX_BIN | codex | 实际可执行文件路径；不使用 shell 拼接 |
| PA_CODEX_MODEL | 未设置 | 使用 Codex 配置中的可用模型 |
| PA_SANDBOX | read-only | read-only 或 workspace-write |
| PA_AGENT_MODEL | 未设置 | LangChain 助手使用的工具调用模型，与 Codex 模型独立 |
| OPENAI_API_KEY | 未设置 | 助手模型 API 凭证，仅在电脑配置 |

.env.example 是配置说明，不会自动加载。数据目录应只对当前操作系统用户开放；Windows 下应使用本地用户目录／合适的 NTFS ACL。当前原型未实现凭证轮换、设备撤销管理页和数据库加密。

## iOS 客户端

iOS 源代码在 apps/ios。本地开发环境为 Windows，仓库通过 GitHub Actions 的 macOS runner 编译与运行模拟器测试。iPhone 安装、签名和实际联网验收使用你的 Mac 与 iPhone。模块范围与验收步骤见 [iOS 客户端模块](docs/IOS_CLIENT_MODULE.md)。

在 Mac 的仓库根目录执行 `bash scripts/check-ios.sh`，可以复现自动化检查（需 Xcode、iPhone 模拟器和 XcodeGen）。报告输出到 `apps/ios/build`。

1. 在 Mac 安装兼容 iOS 18+ 的 Xcode 与 XcodeGen。
2. 在 apps/ios 目录运行以下命令。
3. 在 Xcode 中设置自己的 Signing Team 和唯一 Bundle Identifier。
4. 选择 iPhone 真机，运行应用并允许局域网访问。

~~~sh
cd apps/ios
xcodegen generate
open PhoneAssistant.xcodeproj
~~~

在手机选择“配对电脑”，填写 HTTPS 地址、电脑打印的证书指纹和一次性配对码。凭证存入 Keychain，不出现在请求 URL 中。

客户端只接受与输入指纹完全匹配的服务器证书，不全局信任自签证书。原型使用人工复制指纹建立首次信任；具体 ATS／真机证书行为仍需 Mac 端编译及设备验证。

“聊天”页支持文字输入、阅读回答、切换历史会话；“电脑任务”页显示 Codex 输出、执行审批和停止按钮。普通聊天由 LangChain 助手回答，要求电脑执行工作时才调用 Codex 工具。继续旧 Codex 上下文时，可以告诉助手对应任务编号或描述，助手先查询再续接。

点麦克风开始 App 内录音，结束后可以编辑识别文字再发送；点“朗读”播放文字。点“打断回答”或再次开启录音，会立即停止本机播报，并请求电脑停止当前回答。新消息也会中止旧的回答代次。**这不等于取消已经提交的 Codex 工作**，停止执行需要使用“电脑任务”中的停止按钮。

语音采集最长 45 秒；优先使用设备支持的本地识别，否则可能使用 Apple 的语音识别服务。进入后台停止录音／播报并关闭事件连接，回到前台读取快照并重连。尚未实现无需按钮的全双工连续语音、自动结果播报或后台唤醒。

网络失败后的“重试发送”复用 request_id，界面保留未确认消息。服务器明确拒绝的请求可恢复到输入框编辑。草稿、待发送请求与聊天／任务快照保存在受文件保护的本地文件中；重复配对会在待发送消息处理完后开放。实时事件只获取变更的单条记录，缓存写入合并到约每秒一次。此缓存是第一阶段实现，不是长期记忆数据库。不同配对身份使用独立缓存。

## 验证 Codex

~~~powershell
# 只检查协议握手和登录状态，不启动模型任务
pnpm smoke:codex

# 启动一个真实、只读、禁止调用工具的简单回答任务
pnpm smoke:codex --run

# 排查协议时打印方法名及受限的错误摘要，不打印凭证或完整协议消息
pnpm smoke:codex --run --trace
~~~

真实模型请求会使用已有 Codex 账号及额度。实际输出依赖账号、模型、插件启动与网络状态；握手成功不等于模型任务成功。

2026-11-10 的真实只读任务已返回 READY 并完成；测试中曾出现 responseStreamDisconnected 重试，前两次尝试在 90 秒超时后中断。当前环境的上游网络延迟需要后续诊断，不应据此承诺稳定秒级响应。客户端会显示重试进度。

## 已实现的接口

除 health 与一次性配对兑换外，均要求 Authorization: Bearer 设备令牌。

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | /health | 基本存活与协议版本 |
| POST | /v1/pairings/claim | 一次性配对，返回设备令牌 |
| GET | /v1/info | 协议和项目名称 |
| GET | /v1/snapshot | 聊天＋任务的一致快照与游标 |
| POST | /v1/chats | 向 LangChain 助手提问；request_id、prompt、可选 conversation_id |
| GET | /v1/chats/:id | 单轮聊天、回答状态和关联 task_ids |
| POST | /v1/chats/:id/cancel | 停止本轮回答；不自动取消已提交任务 |
| POST | /v1/tasks | request_id、prompt、可选 conversation_id |
| GET | /v1/tasks | 最近 100 个任务与一致快照游标 |
| GET | /v1/tasks/:id | 任务快照 |
| POST | /v1/tasks/:id/cancel | 请求停止任务 |
| POST | /v1/tasks/:id/approval | approval_id、allow |
| GET | /v1/events/history?after=0 | 按游标查询持久事件 |
| WSS | /v1/events?after=0 | 可重放的事件通知 |

示例请求体：

~~~json
{
  "request_id": "a-unique-client-request-id",
  "prompt": "请概述这个项目当前有哪些模块。"
}
~~~

任务接口返回接受不等于执行成功。取消也不等于撤销已经产生的文件修改。

## 数据与恢复

- SQLite 在独立 worker 中运行，启用 WAL。
- 聊天 `running / succeeded / cancelled / failed` 与 Codex 任务状态独立保存。
- LangChain 使用有长度上限的近期上下文；历史关键词查询只访问当前设备记录，不启动 Codex。
- 回答最多 64,000 个 JavaScript 字符、每轮最多一个 Codex 提交、图执行深度上限 12、回答时限 120 秒。
- 重启停止未完成回答，不恢复工具循环，不重放可能产生副作用的命令。
- 任务状态与事件在同一事务提交。
- 相同设备的 request_id 唯一；重复且内容相同返回原任务，不同内容返回 409。
- 任务按项目串行，避免多个写任务同时操作工作目录。
- 重启后所有未结束任务标为 unknown；不会自动重放可能产生副作用的命令。
- unknown 会话不能直接自动续跑，需要核对后创建新会话。
- 事件是任务快照的失效通知，客户端读取快照后跳过已覆盖的旧事件。
- 单任务正文暂限 256,000 个 JavaScript 字符，超出时显式显示截断标记。
- 列表暂限最近 100 个任务，尚未实现分页、自动归档与历史清理。
- 聊天快照也暂限最近 100 轮；关键词检索保留原记录 ID，尚未实现摘要、向量或图谱。手机缓存和首连快照还需做大数据量压力测试。

## 项目结构

~~~text
apps/companion/src/
  main.ts               配置、TLS、进程入口
  server.ts             认证、配对、HTTP、WebSocket
  assistant.ts          LangChain createAgent、模型与四个工具
  chats.ts              聊天去重、上下文、打断、恢复
  tasks.ts              去重、队列、取消、恢复
  codex.ts              本机 App Server 适配
  storage/              SQLite worker
apps/companion/tests/   生命周期与协议测试
apps/ios/               SwiftUI 客户端与 XcodeGen 配置
packages/protocol/      共享协议类型与请求校验
scripts/                真实 Codex 冒烟检查
docs/                   实施记录与限制
~~~

## 下一步

先配置助手模型并验证真实云端推理，在 Mac 完成 iOS 编译和文字／语音真机联调；再实现自动语音打断、自动结果播报、记忆整理和受支持的手机动作。尚未通过平台验证的能力不作为已验证交付。
