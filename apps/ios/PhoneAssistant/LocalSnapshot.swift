import Foundation
import CryptoKit

struct LocalSnapshot: Codable {
    let tasks: [TaskRecord]
    let chats: [ChatTurnRecord]
    let pending: ChatCommand?
    let cursor: Int
    var draft: String? = nil
    var pendingError: String? = nil

    static func fileURL(config: ConnectionConfig) throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let key = SHA256.hash(data: Data((config.address + config.token).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("chat-v2-" + key + ".json")
    }
    static func load(from url: URL) -> LocalSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(LocalSnapshot.self, from: data)
    }
    func save(to url: URL) throws {
        try JSONEncoder().encode(self).write(to: url, options: [.atomic, .completeFileProtection])
        var resourceURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try resourceURL.setResourceValues(values)
    }
}
