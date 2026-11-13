# 实施记录

更新日期：2026-11-13

## 本次里程碑

P1 已扩展为独立 iOS 聊天 App＋LangChain 电脑助手＋Codex 工具。P0 中需要具体目标 App 和 iPhone 的验证仍待完成。iOS 已编写基础 App 内语音，但尚未进入完整语音或长期记忆交付。

已编写：

- pnpm／TypeScript 项目骨架与可构建的 Windows 电脑伴随服务。
- HTTPS、一次性配对、令牌哈希存储、接口验证和请求限流。
- SQLite worker、任务与事件原子写入、幂等提交和项目串行执行。
- Codex stdio 初始化、会话创建／续接、流式输出、命令／文件审批与取消。
- 取消和完成竞争处理，进程恢复时标记未知状态。
- 事件游标重放与一致快照。
- SwiftUI 文字客户端、证书固定、Keychain、缓存与待发送请求。
- 独立 SwiftUI 聊天／电脑任务页面、会话切换、可阅读的文字结果，不依赖 Siri。
- LangChain JS `createAgent`＋`ChatOpenAI`，工具为历史关键词搜索、最近任务、任务状态和 Codex 提交。
- 聊天持久化、关联任务编号、请求去重、停止回答、新问题替代旧回答、迟到输出丢弃。
- App 内点按录音、可编辑识别文字、手动朗读、立即停播及服务器回答取消的 Swift 源码。
- 变更记录单独获取，缓存写入合并，避免每个流式片段拉取全量会话。
- 请求与事件契约的初始类型；完整 JSON Schema 生成链路尚未引入。

## 当前限制

- iOS 已通过 macOS／Xcode 16.4 编译及模拟器测试，但尚未在用户 iPhone 上签名安装、配对及真实模型联调，不能视为真机交付完成。
- 未实现自动语音插话检测／回声消除、连续全双工语音、自动结果播报、手机动作执行器和长期记忆整理。
- Siri 不属于必要入口；当前 App 内交互不使用 Siri。
- 已实现的历史搜索是电脑侧中文关键词匹配，尚无摘要提取、语义搜索、知识图谱或手机离线问答 Agent。
- LangChain 云端推理需要 PA_AGENT_MODEL 和 OPENAI_API_KEY；当前环境未配置，没有完成真实模型联调或延迟测量。
- 手机缓存暂用受保护 JSON 快照；GRDB 迁移在记忆阶段实施。
- 电脑只配置一个项目，任务列表暂限最近 100 条。
- 暂无设备撤销／凭证轮换界面、公网中继和安装器。
- 未自动删除旧任务／事件，不适合长时间无人维护运行。
- 原型只处理命令与文件审批；其他 Codex 交互请求明确拒绝。
- Codex App Server 的兼容性需随安装版本重新验证。

详细运行方法见仓库 README。

## 已完成的验证

- Node.js 24.19.0、pnpm 11.24.0 环境下通过 TypeScript 严格类型检查与构建。
- 当前 3 个测试文件、19 项自动化测试通过；编译后 HTTPS 服务启动、可信证书、配对、聊天／任务快照和模型配置状态检查通过。
- 自动化测试覆盖认证、配对一次性使用、幂等提交、串行执行、取消竞争、审批关联、设备隔离、事件重放、重启恢复和 stdio 协议。
- 新增测试实际运行 LangChain 图和工具循环，模型使用测试用 FakeToolCallingModel；验证普通聊天不启动 Codex、工具提交去重、历史隔离、回答取消与聊天恢复。该测试不代表真实云端模型已联调。
- 编译后的实际服务通过可信 TLS 请求、一次性配对与带认证任务快照检查。
- 本机 Codex 0.166.0-alpha.6 协议握手成功，检测到已有登录。
- 真实只读任务最终返回 READY，终态 succeeded；此前出现上游 responseStreamDisconnected 重试，并有两次 90 秒测试主动取消。未把这些取消尝试当作成功验证。
- Windows 本机没有 Swift／Xcode；已通过 GitHub Actions 的 macOS runner 执行原生 iOS 构建与 XCTest／XCUITest。真机验证尚未执行。

生产入口使用真实 CodexEngine 和配置后的 LangChainAssistant，不使用模拟结果代替实际执行。未配置助手模型时，接口明确返回配置提示。

## 依赖与下一次验证

锁文件记录 LangChain 1.6.3、@langchain/core 1.3.5、@langchain/openai 1.8.2。调用方式参考 [LangChain Agent](https://docs.langchain.com/oss/javascript/langchain/agents) 与 [流式输出](https://docs.langchain.com/oss/javascript/langchain/streaming)。

下一次真机验证先覆盖客户端文字模块：首次配对、真实消息与任务、断线、后台恢复和证书固定。完整语音模块另行验证首次授权、中文识别、点按停播、耳机／来电中断。用户已确认有 Mac 和 iPhone；当前交付不包含签名安装包。

App 内语音使用 [Apple Speech 音频识别请求](https://developer.apple.com/documentation/speech/sfspeechaudiobufferrecognitionrequest) 和 [AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)，与 Siri 入口无关。

## M1 客户端基础模块（2026-11-13）

本轮只修改 iOS 基础客户端和构建／测试入口，未扩展电脑 Agent、记忆整理或手机动作。

- 保存输入草稿，待发送消息与请求 ID 可跨启动恢复；写盘失败不提交网络请求。
- 区分网络结果未知与服务器明确拒绝；前者重试原请求，后者可恢复编辑。
- 配对表单独立、配对防重复、临时连接释放；重连错误改为页面内提示。
- 快照不会覆盖更高版本记录或抹去刚收到的接受响应；旧连接响应不得写入新连接。
- 测试覆盖成功发送、恢复重试、拒绝编辑、缓存写入失败、快照竞争、配对失败、草稿保存和连接配置校验。
- 最终原生验证：[Xcode 16.4 构建与 12 项客户端测试通过](https://github.com/c-kun-m/free_or_full/actions/runs/43389500874)，其中 11 项状态测试、1 项界面测试，验证代码提交 `1ec7580`。
- 额外覆盖发送中切换会话、第一次发送结果未知后重试被拒绝的竞争情况。完整模块验收追踪见 [M1 文档](IOS_CLIENT_MODULE.md)。
