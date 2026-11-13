import XCTest
@testable import PhoneAssistant

private actor TestTransport: CompanionTransport {
    var requests: [ChatCommand] = []
    var nextError: ClientError?
    var snapshot = #"{"tasks":[],"chats":[],"cursor":0}"#
    var closed = 0
    var hold = false
    var held: CheckedContinuation<Void, Never>?
    func setError(_ error: ClientError) { nextError = error }
    func setSnapshot(_ json: String) { snapshot = json }
    func holdNext() { hold = true }
    func release() { held?.resume(); held = nil }
    func requestIDs() -> [String] { requests.map(\.request_id) }
    func get<T: Decodable & Sendable>(_ path: String, as: T.Type) async throws -> T {
        let json = path == "v1/info" ? #"{"assistant":{"configured":true}}"# : snapshot
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
    func post<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, body: B, as: T.Type) async throws -> T {
        if path == "v1/pairings/claim" {
            if let error = nextError { nextError = nil; throw error }
            return try JSONDecoder().decode(T.self, from: Data(#"{"device_id":"phone","token":"credential"}"#.utf8))
        }
        let command = try JSONDecoder().decode(ChatCommand.self, from: JSONEncoder().encode(body))
        requests.append(command)
        if hold { hold = false; await withCheckedContinuation { held = $0 } }
        if let error = nextError { nextError = nil; throw error }
        let result = ChatTurnRecord(id: "turn-" + command.request_id, request_id: command.request_id,
            conversation_id: command.conversation_id ?? "conversation", prompt: command.prompt, output: "回答",
            status: "succeeded", error: nil, task_ids: [], created_at: "2026-11-13T00:00:00Z", version: 2)
        return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(result))
    }
    func events(after: Int) -> URLSessionWebSocketTask { URLSession.shared.webSocketTask(with: URL(string: "wss://localhost")!) }
    func close() { closed += 1 }
}

@MainActor
final class AssistantModelTests: XCTestCase {
    private let config = ConnectionConfig(address: "https://localhost:4318", fingerprint: String(repeating: "a", count: 64), token: "test-token")
    private func makeModel(_ transport: TestTransport, cache: URL? = nil) async throws -> (AssistantModel, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = cache ?? directory.appendingPathComponent("cache.json")
        let model = AssistantModel(cacheURL: file, makeAPI: { _ in transport }, saveCredentials: { _ in })
        addTeardownBlock { @MainActor in model.pause(); try? FileManager.default.removeItem(at: directory) }
        try await model.connect(config, startEvents: false)
        try await model.synchronize()
        return (model, file)
    }
    func testSuccessfulSendSavesAcceptanceAndClearsOutbox() async throws {
        let transport = TestTransport()
        let (model, file) = try await makeModel(transport)
        model.draft = "你好"
        XCTAssertTrue(model.canSend)
        await model.send()
        XCTAssertNil(model.pending)
        XCTAssertEqual(model.visibleChats.last?.output, "回答")
        XCTAssertEqual(model.draft, "")
        XCTAssertEqual(LocalSnapshot.load(from: file)?.chats.count, 1)
    }
    func testUnconfirmedSendKeepsSameRequestAfterRestart() async throws {
        let transport = TestTransport()
        let (model, file) = try await makeModel(transport)
        await transport.setError(.message("Network timeout"))
        model.draft = "不能重复执行"
        await model.send()
        let original = try XCTUnwrap(model.pending?.request_id)
        XCTAssertNil(model.pendingError)
        model.pause()
        let (restored, _) = try await makeModel(transport, cache: file)
        XCTAssertEqual(restored.pending?.prompt, "不能重复执行")
        await restored.retryPending()
        let ids = await transport.requestIDs()
        XCTAssertEqual(ids, [original, original])
        XCTAssertNil(restored.pending)
    }
    func testRejectedMessageCanBeEditedButUnknownSubmissionCannot() async throws {
        let transport = TestTransport()
        let (model, _) = try await makeModel(transport)
        await transport.setError(.http(409, "模型未配置"))
        model.draft = "保留我的输入"
        await model.send()
        XCTAssertNotNil(model.pendingError)
        model.editRejectedMessage()
        XCTAssertEqual(model.draft, "保留我的输入")
        XCTAssertNil(model.pending)
        await transport.setError(.message("网络断开"))
        await model.send()
        model.editRejectedMessage()
        XCTAssertNotNil(model.pending)
    }
    func testDiskFailureDoesNotSendOrLoseDraft() async throws {
        let transport = TestTransport()
        let (model, file) = try await makeModel(transport)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        model.draft = "原始草稿"
        await model.send()
        XCTAssertEqual(model.draft, "原始草稿")
        let ids = await transport.requestIDs()
        XCTAssertTrue(ids.isEmpty)
        model.pause()
    }
    func testRejectedRetryCannotEraseEarlierUncertainExecution() async throws {
        let transport = TestTransport()
        let (model, file) = try await makeModel(transport)
        await transport.setError(.message("Accepted response may have been lost"))
        model.draft = "可能已执行"
        await model.send()
        let id = model.pending?.request_id
        model.pause()
        let (restored, _) = try await makeModel(transport, cache: file)
        await transport.setError(.http(401, "Credential revoked after original submission"))
        await restored.retryPending()
        restored.editRejectedMessage()
        XCTAssertNil(restored.pendingError)
        XCTAssertEqual(restored.pending?.request_id, id)
        XCTAssertNotNil(restored.pending)
    }
    func testSnapshotCannotEraseAcceptanceOrRegressVersion() async throws {
        let transport = TestTransport()
        let (model, _) = try await makeModel(transport)
        model.draft = "消息"
        await model.send()
        try await model.refresh() // Earlier empty snapshot must not erase accepted record.
        XCTAssertEqual(model.chats.count, 1)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(model.chats[0])) as? [String: Any])
        object["version"] = 1; object["output"] = "过期内容"
        let data = try JSONSerialization.data(withJSONObject: ["tasks": [], "chats": [object], "cursor": 1])
        await transport.setSnapshot(String(decoding: data, as: UTF8.self))
        try await model.refresh()
        XCTAssertEqual(model.chats[0].output, "回答")
    }
    func testOldConnectionAcceptanceDoesNotContaminateNewConnection() async throws {
        let transport = TestTransport()
        let (model, _) = try await makeModel(transport)
        await transport.holdNext()
        model.draft = "旧电脑消息"
        let sending = Task { await model.send() }
        for _ in 0..<100 {
            if !(await transport.requestIDs()).isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let before = await transport.requestIDs()
        XCTAssertEqual(before.count, 1)
        let config2 = ConnectionConfig(address: "https://other:4318", fingerprint: config.fingerprint, token: "other")
        try await model.connect(config2, startEvents: false)
        await transport.release()
        await sending.value
        XCTAssertTrue(model.chats.isEmpty)
        model.pause()
    }
    func testPairingFailureClosesTemporaryTransportAndPreservesDraft() async throws {
        let transport = TestTransport()
        let model = AssistantModel(makeAPI: { _ in transport }, saveCredentials: { _ in })
        model.draft = "草稿"
        await transport.setError(.http(401, "配对码过期"))
        let paired = await model.pair(address: config.address, fingerprint: config.fingerprint, code: "expired")
        XCTAssertFalse(paired)
        XCTAssertFalse(model.isPairing)
        XCTAssertEqual(model.draft, "草稿")
        let closed = await transport.closed
        XCTAssertEqual(closed, 1)
    }
    func testPausePersistsDraftAndDisablesSending() async throws {
        let transport = TestTransport()
        let (model, file) = try await makeModel(transport)
        model.draft = "下次接着写"
        model.pause()
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(LocalSnapshot.load(from: file)?.draft, "下次接着写")
    }
    func testAcceptanceDoesNotNavigateAwayFromNewChatChosenWhileSending() async throws {
        let transport = TestTransport()
        let (model, _) = try await makeModel(transport)
        await transport.holdNext()
        model.draft = "等待接受的消息"
        let send = Task { await model.send() }
        for _ in 0..<100 {
            if !(await transport.requestIDs()).isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        model.selectConversation(nil)
        await transport.release()
        await send.value
        XCTAssertNil(model.conversation)
        XCTAssertEqual(model.chats.count, 1)
    }
    func testConnectionValidationRejectsInvalidAddressAndPin() throws {
        XCTAssertThrowsError(try CompanionAPI(config: ConnectionConfig(address: "http://localhost", fingerprint: config.fingerprint, token: "")))
        XCTAssertThrowsError(try CompanionAPI(config: ConnectionConfig(address: "https://localhost/path", fingerprint: config.fingerprint, token: "")))
        XCTAssertThrowsError(try CompanionAPI(config: ConnectionConfig(address: config.address, fingerprint: "bad", token: "")))
    }
}
