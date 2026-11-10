import Foundation

struct TaskRecord: Codable, Identifiable, Sendable {
    let id: String
    let device_id: String
    let request_id: String
    let conversation_id: String
    let prompt: String
    let status: String
    let output: String
    let output_truncated: Bool
    let error: String?
    let progress: String?
    let approval: ApprovalRecord?
    let created_at: String
    let updated_at: String
    let version: Int

    var isTerminal: Bool { ["succeeded", "failed", "cancelled", "unknown"].contains(status) }
    var statusLabel: String {
        ["queued": "等待执行", "running": "正在执行", "waiting_approval": "等待确认",
         "cancel_requested": "正在停止", "succeeded": "已完成", "failed": "执行失败",
         "cancelled": "已停止", "unknown": "需要核对"].first(where: { $0.key == status })?.value ?? status
    }
}
struct ApprovalRecord: Codable, Sendable {
    let id: String
    let description: String
    let expires_at: String
}
struct AppSnapshot: Decodable, Sendable { let tasks: [TaskRecord]; let chats: [ChatTurnRecord]; let cursor: Int }
struct PairingResult: Codable, Sendable { let device_id: String; let token: String }
struct ConnectionConfig: Codable, Sendable {
    let address: String
    let fingerprint: String
    let token: String
}
struct ChatCommand: Codable, Sendable {
    let request_id: String
    let prompt: String
    let conversation_id: String?
}
struct EventMessage: Decodable, Sendable {
    let event_seq: Int
    let type: String
    let payload: EventPayload
}
struct EventPayload: Decodable, Sendable { let task_id: String?; let chat_id: String? }
struct Acceptance: Decodable, Sendable { let accepted: Bool }
struct ChatTurnRecord: Codable, Identifiable, Sendable {
    let id: String
    let request_id: String
    let conversation_id: String
    let prompt: String
    let output: String
    let status: String
    let error: String?
    let task_ids: [String]
    let created_at: String
    let version: Int
    var isRunning: Bool { status == "running" }
    var statusLabel: String {
        switch status {
        case "running": return "正在回答"
        case "succeeded": return "已回答"
        case "cancelled": return "已停止回答"
        default: return "回答失败"
        }
    }
}
struct ServiceInfo: Decodable, Sendable {
    let assistant: AssistantInfo
    struct AssistantInfo: Decodable, Sendable { let configured: Bool }
}
