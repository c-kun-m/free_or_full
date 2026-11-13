import Foundation
import Combine

@MainActor
final class AssistantModel: ObservableObject {
    @Published var tasks: [TaskRecord] = []
    @Published var chats: [ChatTurnRecord] = []
    @Published var conversation: String?
    @Published var draft = "" { didSet { scheduleCacheWrite() } }
    @Published var agentConfigured = false
    @Published var error: String?
    @Published var connection = "未连接"
    @Published var connectionIssue: String?
    @Published private(set) var isConnected = false
    @Published private(set) var isPaired = false
    @Published private(set) var isPairing = false
    @Published private(set) var sending = false
    @Published private(set) var pending: ChatCommand?
    @Published private(set) var pendingError: String?
    private var api: (any CompanionTransport)?
    private var eventLoop: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var cursor = 0
    private var epoch = 0
    private var connectionGeneration = 0
    private var snapshotURL: URL?
    private var cacheWrite: Task<Void, Never>?
    private let cacheOverride: URL?
    private let makeAPI: @Sendable (ConnectionConfig) throws -> any CompanionTransport
    private let saveCredentials: (ConnectionConfig) throws -> Void

    init(cacheURL: URL? = nil,
         makeAPI: @escaping @Sendable (ConnectionConfig) throws -> any CompanionTransport = { try CompanionAPI(config: $0) },
         saveCredentials: @escaping (ConnectionConfig) throws -> Void = { try CredentialStore.save($0) }) {
        self.cacheOverride = cacheURL
        self.makeAPI = makeAPI
        self.saveCredentials = saveCredentials
    }
    var visibleChats: [ChatTurnRecord] { Array(chats.filter { $0.conversation_id == conversation }.reversed()) }
    var canSend: Bool { isPaired && isConnected && agentConfigured && !sending && !isPairing && pending == nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func persist() throws {
        if let snapshotURL {
            try LocalSnapshot(tasks: tasks, chats: chats, pending: pending, cursor: cursor,
                              draft: draft, pendingError: pendingError).save(to: snapshotURL)
        }
    }
    private func scheduleCacheWrite() {
        guard snapshotURL != nil, cacheWrite == nil else { return }
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
    @discardableResult
    func pair(address: String, fingerprint: String, code: String) async -> Bool {
        guard !isPairing, !sending else { return false }
        guard pending == nil else { error = "请先处理待发送消息，再切换配对电脑。"; return false }
        isPairing = true
        defer { isPairing = false }
        do {
            let temporary = try makeAPI(ConnectionConfig(address: address, fingerprint: fingerprint, token: ""))
            let result: PairingResult
            do {
                result = try await temporary.post("v1/pairings/claim", body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "name": "iPhone"], as: PairingResult.self)
            } catch { await temporary.close(); throw error }
            await temporary.close()
            let config = ConnectionConfig(address: address, fingerprint: fingerprint, token: result.token)
            try saveCredentials(config)
            try await connect(config)
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    // Injected transport/cache allow the real client state machine to run in XCTest.
    func connect(_ config: ConnectionConfig, startEvents: Bool = true) async throws {
        let unpairedDraft = isPaired ? "" : draft
        let nextAPI = try makeAPI(config)
        let nextCache = try cacheOverride ?? LocalSnapshot.fileURL(config: config)
        pause()
        connectionGeneration += 1
        agentConfigured = false
        if let api { await api.close() }
        api = nextAPI
        snapshotURL = nextCache
        let cached = LocalSnapshot.load(from: nextCache)
        cursor = cached?.cursor ?? 0
        tasks = cached?.tasks ?? []
        chats = cached?.chats ?? []
        conversation = chats.first?.conversation_id
        pending = cached?.pending
        pendingError = cached?.pendingError
        draft = cached?.draft ?? unpairedDraft
        isPaired = true
        connectionIssue = nil
        if startEvents { await resume() }
    }
    func refresh() async throws {
        guard let api else { return }
        let expected = epoch
        let response = try await api.get("v1/snapshot", as: AppSnapshot.self)
        guard expected == epoch, response.cursor >= cursor else { return }
        // Merge concurrent acceptance/live updates; an earlier snapshot must not erase them.
        for record in response.tasks { merge(record) }
        for turn in response.chats { merge(turn) }
        cursor = response.cursor
        try persist()
    }
    func synchronize() async throws {
        guard let api else { return }
        let expected = epoch
        let info = try await api.get("v1/info", as: ServiceInfo.self)
        try await refresh()
        guard expected == epoch else { return }
        agentConfigured = info.assistant.configured
        isConnected = true
        connection = "已连接"
        connectionIssue = nil
    }
    func resume() async {
        guard let api, eventLoop == nil else { return }
        let expected = epoch
        connection = "正在连接"
        eventLoop = Task { [weak self] in
            defer { if let self, self.epoch == expected { self.eventLoop = nil } }
            var delay = 1
            while !Task.isCancelled {
                guard let self, self.epoch == expected else { return }
                do {
                    try await self.synchronize()
                    guard self.epoch == expected, !Task.isCancelled else { return }
                    let stream = await api.events(after: self.cursor)
                    guard self.epoch == expected, !Task.isCancelled else { stream.cancel(with: .goingAway, reason: nil); return }
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
                        guard self.epoch == expected else { return }
                        if event.event_seq <= self.cursor { continue }
                        if let id = event.payload.chat_id {
                            let turn = try await api.get("v1/chats/" + id, as: ChatTurnRecord.self)
                            guard self.epoch == expected else { return }
                            self.merge(turn)
                        } else if let id = event.payload.task_id {
                            let record = try await api.get("v1/tasks/" + id, as: TaskRecord.self)
                            guard self.epoch == expected else { return }
                            self.merge(record)
                        }
                        self.cursor = max(self.cursor, event.event_seq)
                        self.scheduleCacheWrite()
                    }
                } catch {
                    // Do not let an old connection close a newly paired socket.
                    guard self.epoch == expected, !Task.isCancelled else { return }
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    self.isConnected = false
                    self.connectionIssue = error.localizedDescription
                    if (error as? ClientError)?.requiresPairing == true {
                        self.connection = "配对已失效，请重新配对"
                        return
                    }
                    self.connection = "连接中断，正在重连"
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 15)
                }
            }
        }
    }
    func reconnect() async { pause(); await resume() }
    func pause() {
        cacheWrite?.cancel(); cacheWrite = nil
        try? persist()
        epoch += 1
        eventLoop?.cancel(); eventLoop = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        isConnected = false
        connection = "连接已暂停"
    }
    private func merge(_ turn: ChatTurnRecord) {
        if let old = chats.first(where: { $0.id == turn.id }), old.version > turn.version { return }
        chats.removeAll { $0.id == turn.id }; chats.append(turn)
        chats.sort { $0.created_at > $1.created_at }
        chats = Array(chats.prefix(100))
    }
    private func merge(_ task: TaskRecord) {
        if let old = tasks.first(where: { $0.id == task.id }), old.version > task.version { return }
        tasks.removeAll { $0.id == task.id }; tasks.append(task)
        tasks.sort { $0.created_at > $1.created_at }
        tasks = Array(tasks.prefix(100))
    }
    func send() async {
        guard canSend else { return }
        let original = draft
        pending = ChatCommand(request_id: UUID().uuidString, prompt: original, conversation_id: conversation)
        pendingError = nil
        draft = ""
        do { try persist() } catch {
            pending = nil; draft = original
            self.error = "无法保存待发送请求，尚未提交：" + error.localizedDescription
            return
        }
        await retryPending()
    }
    func retryPending() async {
        guard !sending, !isPairing, pendingError == nil, let api, let command = pending else { return }
        let expected = connectionGeneration
        let selected = conversation
        sending = true
        defer { sending = false }
        do {
            let turn = try await api.post("v1/chats", body: command, as: ChatTurnRecord.self)
            guard expected == connectionGeneration else { return }
            pending = nil; pendingError = nil
            if conversation == selected { conversation = turn.conversation_id }
            merge(turn)
            try persist()
            // The acceptance already contains the authoritative record. Events deliver later changes.
        } catch {
            guard expected == connectionGeneration else { return }
            if (error as? ClientError)?.rejectedSubmission == true {
                pendingError = error.localizedDescription
                try? persist()
            }
            self.error = error.localizedDescription
        }
    }
    func editRejectedMessage() {
        guard !sending, let command = pending, pendingError != nil else { return }
        let oldDraft = draft
        let oldError = pendingError
        draft = command.prompt; conversation = command.conversation_id
        pending = nil; pendingError = nil
        do { try persist() } catch {
            pending = command; pendingError = oldError; draft = oldDraft
            self.error = "无法保存草稿，请重试。"
        }
    }
    func interruptReply() async {
        guard let api else { return }
        let expected = connectionGeneration
        for turn in chats.filter({ $0.isRunning && $0.conversation_id == conversation }) {
            do {
                let stopped = try await api.post("v1/chats/" + turn.id + "/cancel", body: [String: String](), as: ChatTurnRecord.self)
                guard expected == connectionGeneration else { return }
                merge(stopped)
            } catch { if expected == connectionGeneration { self.error = "停止回答尚未确认：" + error.localizedDescription } }
        }
        try? persist()
    }
    func cancel(_ task: TaskRecord) async {
        guard let api else { return }
        let expected = connectionGeneration
        do {
            let record = try await api.post("v1/tasks/" + task.id + "/cancel", body: [String: String](), as: TaskRecord.self)
            guard expected == connectionGeneration else { return }
            merge(record); try persist()
        } catch { if expected == connectionGeneration { self.error = error.localizedDescription } }
    }
    func decide(_ task: TaskRecord, allow: Bool) async {
        guard let api, let approval = task.approval else { return }
        let expected = connectionGeneration
        struct Decision: Encodable, Sendable { let approval_id: String; let allow: Bool }
        do {
            _ = try await api.post("v1/tasks/" + task.id + "/approval", body: Decision(approval_id: approval.id, allow: allow), as: Acceptance.self)
            guard expected == connectionGeneration else { return }
            try await refresh()
        } catch { if expected == connectionGeneration { self.error = error.localizedDescription } }
    }
}
