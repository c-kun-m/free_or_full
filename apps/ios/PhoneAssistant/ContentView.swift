import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AssistantModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voice = VoiceController()
    @State private var prompt = ""
    @State private var dictationPrefix = ""
    @State private var address = "https://"
    @State private var fingerprint = ""
    @State private var code = ""
    @State private var showPairing = false

    private var conversations: [ChatTurnRecord] {
        var seen = Set<String>()
        return model.chats.filter { seen.insert($0.conversation_id).inserted }
    }

    var body: some View {
        TabView {
            NavigationStack {
                ScrollViewReader { proxy in
                    List {
                        Section {
                            Label(model.connection, systemImage: "desktopcomputer")
                            if !model.isPaired {
                                Text("配对电脑后，在这里输入文字或使用语音，与助手聊天。")
                                Button("配对电脑") { showPairing = true }
                            } else if !model.agentConfigured {
                                Text("电脑尚未启用助手模型，请按 README 配置后重启电脑服务。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if model.visibleChats.isEmpty {
                            Section {
                                Text("有什么可以帮你？").font(.title3)
                                Text("可以询问以前的记录，也可以让电脑里的 Codex 处理项目。")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        ForEach(model.visibleChats) { turn in
                            Section {
                                HStack {
                                    Spacer(minLength: 30)
                                    Text(turn.prompt).padding(12)
                                        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                                }.textSelection(.enabled)
                                VStack(alignment: .leading, spacing: 10) {
                                    Label("助手", systemImage: "sparkles").font(.caption).foregroundStyle(.secondary)
                                    if !turn.output.isEmpty { Text(turn.output).textSelection(.enabled) }
                                    if turn.isRunning { ProgressView("正在回答…") }
                                    else if turn.status != "succeeded" { Text(turn.statusLabel).font(.caption).foregroundStyle(.secondary) }
                                    if let error = turn.error { Text(error).font(.caption).foregroundStyle(.red) }
                                    if !turn.task_ids.isEmpty {
                                        Text("已关联 \(turn.task_ids.count) 个电脑任务，可在“电脑任务”查看进度与审批。").font(.caption)
                                    }
                                    if !turn.output.isEmpty && !turn.isRunning {
                                        Button { voice.speak(turn.output) } label: { Label("朗读", systemImage: "speaker.wave.2") }
                                    }
                                }
                            }.id(turn.id)
                        }
                        Color.clear.frame(height: 1).listRowSeparator(.hidden).id("bottom")
                    }
                    .buttonStyle(.borderless)
                    .onChange(of: model.visibleChats.last?.id) { _, _ in
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
                .navigationTitle("助手")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showPairing = true } label: { Image(systemName: "desktopcomputer") }.accessibilityLabel("配对电脑")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("新建聊天", systemImage: "square.and.pencil") { model.conversation = nil; prompt = "" }
                            ForEach(conversations) { turn in
                                Button(String(turn.prompt.prefix(24))) { model.conversation = turn.conversation_id }
                            }
                        } label: { Image(systemName: "bubble.left.and.bubble.right") }.accessibilityLabel("聊天记录")
                    }
                }
                .safeAreaInset(edge: .bottom) { composer }
                .refreshable { do { try await model.refresh() } catch { model.error = error.localizedDescription } }
            }.tabItem { Label("聊天", systemImage: "bubble.left.and.bubble.right") }

            NavigationStack {
                List {
                    if model.tasks.isEmpty { Text("让助手提交电脑工作后，任务进度会显示在这里。") }
                    ForEach(model.tasks) { task in
                        Section {
                            Text(task.prompt).font(.headline)
                            Text(task.statusLabel).foregroundStyle(.secondary)
                            if let progress = task.progress, !task.isTerminal { Text(progress).font(.caption) }
                            if !task.output.isEmpty {
                                Text(task.output).textSelection(.enabled)
                                Button { voice.speak(task.output) } label: { Label("朗读结果", systemImage: "speaker.wave.2") }
                            }
                            if task.output_truncated { Text("结果超过当前保存上限，已截断。").font(.caption) }
                            if let error = task.error { Text(error).foregroundStyle(.red) }
                            if let approval = task.approval {
                                Text("需要确认").font(.headline)
                                Text(approval.description).font(.caption).textSelection(.enabled)
                                HStack {
                                    Button("允许本次") { Task { await model.decide(task, allow: true) } }
                                    Button("拒绝", role: .destructive) { Task { await model.decide(task, allow: false) } }
                                }
                            }
                            if !task.isTerminal {
                                Button("停止任务", role: .destructive) { Task { await model.cancel(task) } }
                                    .disabled(task.status == "cancel_requested")
                            }
                        }
                    }
                }.buttonStyle(.borderless).navigationTitle("电脑任务")
                    .safeAreaInset(edge: .bottom) {
                        if voice.isSpeaking {
                            Button("停止播报") { voice.stopSpeaking() }.padding().frame(maxWidth: .infinity).background(.bar)
                        }
                    }
            }.tabItem { Label("电脑任务", systemImage: "desktopcomputer") }
        }
        .onChange(of: voice.transcript) { _, text in
            prompt = dictationPrefix + (dictationPrefix.isEmpty || text.isEmpty ? "" : " ") + text
        }
        .onChange(of: voice.error) { _, error in if let error { model.error = error; voice.error = nil } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { voice.stop() } }
        .sheet(isPresented: $showPairing) { pairingSheet }
        .alert("助手提示", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if voice.isSpeaking || model.chats.contains(where: { $0.isRunning }) {
                Button("打断回答") {
                    voice.stop()
                    Task { await model.interruptReply() }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.pending != nil {
                HStack {
                    Text("发送尚未确认，重试不会重复提交。").font(.caption)
                    Button("重试") { Task { await model.retryPending() } }.disabled(model.sending)
                }
            }
            HStack(alignment: .bottom) {
                Button {
                    if voice.isRecording || voice.isStarting { voice.stopRecording() }
                    else {
                        voice.stopSpeaking()
                        dictationPrefix = prompt
                        Task { await model.interruptReply() }
                        Task { await voice.start() }
                    }
                } label: { Image(systemName: voice.isRecording || voice.isStarting ? "stop.circle.fill" : "mic.fill").font(.title2) }
                    .accessibilityLabel(voice.isRecording ? "结束录音" : "语音输入并打断回答")
                    .disabled(!model.isPaired || model.sending)
                TextField("输入消息，或点麦克风说话", text: $prompt, axis: .vertical)
                    .lineLimit(1...6).textFieldStyle(.roundedBorder)
                    .disabled(voice.isRecording || voice.isStarting)
                Button {
                    voice.stop()
                    let text = prompt
                    prompt = ""
                    Task { await model.send(text) }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    .accessibilityLabel("发送消息")
                    .disabled(!model.isPaired || !model.agentConfigured || model.sending || model.pending != nil || voice.isRecording || voice.isStarting || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if voice.isRecording {
                Text("正在录音，结束后可编辑文字再发送（最长 45 秒）").font(.caption).foregroundStyle(.secondary)
            }
        }.padding().background(.bar)
    }

    private var pairingSheet: some View {
        NavigationStack {
            Form {
                Section("电脑连接信息") {
                    TextField("HTTPS 地址", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("证书 SHA-256 指纹", text: $fingerprint).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("一次性配对码", text: $code)
                    Text("从电脑服务启动输出中复制。配对码有效期为 5 分钟。").font(.caption)
                }
                Button("配对") {
                    voice.stop()
                    Task {
                        model.error = nil
                        await model.pair(address: address, fingerprint: fingerprint, code: code)
                        if model.error == nil { showPairing = false; code = "" }
                    }
                }
            }.navigationTitle("配对电脑").toolbar { Button("关闭") { showPairing = false } }
        }
    }
}
