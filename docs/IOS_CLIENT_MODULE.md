# M1：iOS 客户端基础模块

更新日期：2026-11-13。负责人范围：本次只推进原生客户端、客户端状态与构建验证，不扩展电脑 Agent、长期记忆或手机动作。

## 交付边界

交付一个可在 iPhone 上运行的文字客户端：配对电脑、聊天、查看任务、切换会话、显示连接状态，断线或发送失败时能恢复。已有语音代码保留，但自动播报、语音插话检测不属于本模块。

| 子模块 | 实现位置 | 验收要求 |
|---|---|---|
| 原生界面 | ContentView、PairingView | 可打开聊天／任务页、配对表单，输入与等待状态正确 |
| 客户端状态 | AssistantModel | 未确认发送使用同一请求编号；拒绝的消息可恢复草稿；旧连接不得覆盖新连接 |
| 通信适配器 | CompanionAPI、CompanionTransport | HTTPS、证书指纹、认证状态、单条变更获取 |
| 本地缓存 | LocalSnapshot、Keychain | 保存草稿、待发送请求和近期记录；按配对身份隔离 |
| 验证入口 | XCTest、XCUITest、check-ios.sh | 原生 App 编译、状态回归、启动及配对表单检查 |

## 本轮变更

- 输入框使用持久草稿；写入待发送请求失败时保留原文，且不发网络请求。
- 网络超时保留原请求 ID，重启 App 后可继续重试；只有服务器明确拒绝的请求才允许恢复编辑。
- 接受响应直接更新聊天，避免紧随其后的旧快照把新消息覆盖。
- 重连错误显示在页面，不每次重试都弹窗；认证失效提示重新配对。
- 配对过程中禁用重复提交和关闭操作；临时网络会话在成功／失败时均释放。
- 客户端网络依赖可注入测试实现；生产默认依然使用真实 HTTPS 服务。

## 在 Mac 验证

前提：Xcode 已完成首次启动并安装 iOS 模拟器，命令行工具选中 Xcode，安装 XcodeGen。最低部署版本为 iOS 18；使用支持 Swift 6 的 Xcode。

```sh
git clone https://github.com/c-kun-m/free_or_full.git
cd free_or_full
brew install xcodegen
bash scripts/check-ios.sh
```

脚本生成工程并选择已安装的 iPhone 模拟器，执行客户端单元测试和界面冒烟测试。测试使用独立的临时缓存和模拟网络，不会调用真实模型或执行 Codex 工作。

真机步骤：

1. 在 Mac 运行 `cd apps/ios && xcodegen generate`，打开 `PhoneAssistant.xcodeproj`。
2. 设置自己的 Signing Team 和唯一 Bundle Identifier，连接 iPhone 并运行。
3. 电脑配置模型并启动伴随服务；手机和电脑接入同一局域网。
4. 在 App 中填写电脑地址、证书指纹、一次性配对码。
5. 验证普通文字对话、Codex 任务、审批、停止任务、后台恢复和历史显示。
6. 断开网络后尝试发送／重连，确认待发送请求未丢失、重试不创建重复任务。

GitHub Actions 使用 macOS runner 进行同样的模拟器验证，并保存 `.xcresult`。它不是签名 IPA，也不代替 iPhone 上的网络、证书和音频验证。

## 完成判定

- [ ] macOS 上原生 App 构建成功。
- [ ] 客户端状态测试通过。
- [ ] 模拟器界面启动／导航测试通过。
- [ ] iPhone 安装与首次配对验证通过。
- [ ] iPhone 与真实 LangChain／Codex 完成一轮文字任务。

最后两项需要用户的 Mac／iPhone 和模型配置。没有实测证据的项保持未完成，不以电脑端 TypeScript 测试替代。

构建配置参考：[GitHub macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[XcodeGen ProjectSpec](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md)。
