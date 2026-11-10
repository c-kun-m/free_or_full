import Foundation
import Combine

@MainActor
final class AssistantModel: ObservableObject {
    @Published var tasks: [TaskRecord] = []
    @Published var chats: [ChatTurnRecord] = []
    @Published var conversation: String?
    @Published var agentConfigured = false
    @Published var error: String?
    @Published var connection = "未连接"
    @Published var isPaired = false
    @Published var sending = false
    @Published var pending: ChatCommand?
    private var api: CompanionAPI?
    private var eventLoop: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var cursor = 0
    private var epoch = 0
    private var connectionGeneration = 0
    private var snapshotURL: URL?
    private var cacheWrite: Task<Void, Never>?

    var visibleChats: [ChatTurnRecord] { Array(chats.filter { $0.conversation_id == conversation }.reversed()) }

    private func persist() throws {
        if let snapshotURL {
            try LocalSnapshot(tasks: tasks, chats: chats, pending: pending, cursor: cursor).save(to: snapshotURL)
        }
    }
    private func scheduleCacheWrite() {
        guard cacheWrite == nil else { return }
        cacheWrite = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.cacheWrite = nil
            do { try self.persist() } catch { self.error = "无法保存本地聊天缓存。" }
        }
    }

    func restore() async {
        guard api == nil, let config = CredentialStore.load() else { return }
        do { try await connect(config) } catch { self.error = error.localizedDescription }
    }
    func pair(address: String, fingerprint: String, code: String) async {
        do {
            let temporary = try CompanionAPI(config: ConnectionConfig(address: address, fingerprint: fingerprint, token: ""))
            let result = try await temporary.post("v1/pairings/claim",
                body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "name": "iPhone"], as: PairingResult.self)
            await temporary.close()
            let config = ConnectionConfig(address: address, fingerprint: fingerprint, token: result.token)
            try CredentialStore.save(config)
            pending = nil
            try await connect(config)
        } catch { self.error = error.localizedDescription }
    }
    private func connect(_ config: ConnectionConfig) async throws {
        pause()
        connectionGeneration += 1
        agentConfigured = false
        if let api { await api.close() }
        api = try CompanionAPI(config: config)
        snapshotURL = try LocalSnapshot.fileURL(config: config)
        let cached = LocalSnapshot.load(from: snapshotURL!)
        cursor = cached?.cursor ?? 0
        tasks = cached?.tasks ?? []
        chats = cached?.chats ?? []
        conversation = chats.first?.conversation_id
        pending = cached?.pending
        isPaired = true
        await resume()
    }
    func refresh() async throws {
        guard let api else { return }
        let expected = epoch
        let response = try await api.get("v1/snapshot", as: AppSnapshot.self)
        guard expected == epoch, response.cursor >= cursor else { return }
        // Never replace a newer task snapshot with an earlier concurrent response.
        let existing = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        tasks = response.tasks.map { incoming in
            if let old = existing[incoming.id], old.version > incoming.version { return old }
            return incoming
        }
        let existingChats = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, $0) })
        chats = response.chats.map { incoming in
            if let old = existingChats[incoming.id], old.version > incoming.version { return old }
            return incoming
        }
        cursor = max(cursor, response.cursor)
        try persist()
    }
    func resume() async {
        guard let api, eventLoop == nil else { return }
        let expected = epoch
        eventLoop = Task { [weak self] in
            var delay = 1
            while !Task.isCancelled {
                guard let self, self.epoch == expected else { return }
                do {
                    try await self.refresh()
                    let info = try await api.get("v1/info", as: ServiceInfo.self)
                    guard self.epoch == expected else { return }
                    self.agentConfigured = info.assistant.configured
                    self.connection = "已连接"
                    let stream = await api.events(after: self.cursor)
                    self.socket = stream
                    delay = 1
                    while !Task.isCancelled {
                        let frame = try await stream.receive()
                        let data: Data
                        switch frame {
                        case .string(let text): data = Data(text.utf8)
                        case .data(let bytes): data = bytes
                        @unknown default: continue
                        }
                        let event = try JSONDecoder().decode(EventMessage.self, from: data)
                        if event.event_seq <= self.cursor { continue }
                        // Fetch only the changed record, not the entire conversation history per token batch.
                        if let id = event.payload.chat_id {
                            let turn = try await api.get("v1/chats/" + id, as: ChatTurnRecord.self)
                            guard self.epoch == expected else { return }
                            self.merge(turn)
                        } else if let id = event.payload.task_id {
                            let record = try await api.get("v1/tasks/" + id, as: TaskRecord.self)
                            guard self.epoch == expected else { return }
                            if let old = self.tasks.first(where: { $0.id == id }), old.version > record.version { continue }
                            self.tasks.removeAll { $0.id == id }; self.tasks.append(record)
                            self.tasks.sort { $0.created_at > $1.created_at }
                            self.tasks = Array(self.tasks.prefix(100))
                        }
                        guard self.epoch == expected else { return }
                        self.cursor = max(self.cursor, event.event_seq)
                        self.scheduleCacheWrite()
                    }
                } catch {
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    if Task.isCancelled || self.epoch != expected { return }
                    self.connection = "连接中断，正在重连"
                    self.error = error.localizedDescription
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 15)
                }
            }
        }
    }
    func pause() {
        cacheWrite?.cancel(); cacheWrite = nil
        try? persist()
        epoch += 1
        eventLoop?.cancel(); eventLoop = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connection = "连接已暂停"
    }
    private func merge(_ turn: ChatTurnRecord) {
        if let old = chats.first(where: { $0.id == turn.id }), old.version > turn.version { return }
        chats.removeAll { $0.id == turn.id }; chats.append(turn)
        chats.sort { $0.created_at > $1.created_at }
        chats = Array(chats.prefix(100))
    }
    func send(_ prompt: String) async {
        guard !sending, pending == nil, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        pending = ChatCommand(request_id: UUID().uuidString, prompt: prompt, conversation_id: conversation)
        do { try persist() } catch {
            pending = nil
            self.error = "无法保存待发送请求，尚未提交：" + error.localizedDescription
            return
        }
        await retryPending()
    }
    func retryPending() async {
        guard !sending, let api, let command = pending else { return }
        let expected = connectionGeneration
        sending = true
        defer { sending = false }
        do {
            let turn = try await api.post("v1/chats", body: command, as: ChatTurnRecord.self)
            guard expected == connectionGeneration else { return }
            pending = nil
            conversation = turn.conversation_id
            merge(turn)
            try persist()
            try await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func interruptReply() async {
        guard let api else { return }
        let expected = connectionGeneration
        let running = chats.filter { $0.isRunning }
        for turn in running {
            do {
                let stopped = try await api.post("v1/chats/" + turn.id + "/cancel", body: [String: String](), as: ChatTurnRecord.self)
                guard expected == connectionGeneration else { return }
                merge(stopped)
            } catch { self.error = "停止回答尚未确认：" + error.localizedDescription }
        }
        try? persist()
    }
    func cancel(_ task: TaskRecord) async {
        do {
            _ = try await api?.post("v1/tasks/" + task.id + "/cancel", body: [String: String](), as: TaskRecord.self)
            try await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func decide(_ task: TaskRecord, allow: Bool) async {
        guard let approval = task.approval else { return }
        struct Decision: Encodable, Sendable { let approval_id: String; let allow: Bool }
        do {
            _ = try await api?.post("v1/tasks/" + task.id + "/approval",
                body: Decision(approval_id: approval.id, allow: allow), as: Acceptance.self)
            try await refresh()
        } catch { self.error = error.localizedDescription }
    }
}
