import Foundation
import Security
import CryptoKit

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

final class PinnedTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let fingerprint: String
    private let host: String
    init(fingerprint: String, host: String) {
        self.fingerprint = fingerprint
        self.host = host
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let der = SecCertificateCopyData(leaf) as Data
        let actual = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        // Trust only the exact certificate manually paired from the desktop.
        guard actual == fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

actor CompanionAPI {
    private let base: URL
    private let token: String
    private let session: URLSession
    init(config: ConnectionConfig) throws {
        guard let components = URLComponents(string: config.address),
              components.scheme == "https", let host = components.host,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url else {
            throw ClientError.message("请输入 https://电脑地址:4318，不能包含路径或账号。")
        }
        let fingerprint = config.fingerprint.lowercased().replacingOccurrences(of: ":", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard fingerprint.count == 64, fingerprint.allSatisfy({ $0.isHexDigit && $0.isASCII }) else {
            throw ClientError.message("证书指纹必须是电脑显示的 64 位 SHA-256。")
        }
        base = url
        token = config.token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        session = URLSession(configuration: configuration, delegate: PinnedTrust(fingerprint: fingerprint, host: host), delegateQueue: nil)
    }
    private func request(_ path: String) -> URLRequest {
        var request = URLRequest(url: base.appendingPathComponent(path))
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        return request
    }
    private func decode<T: Decodable & Sendable>(_ request: URLRequest, as: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            throw ClientError.message(error?["error"] ?? "电脑服务返回错误。")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func get<T: Decodable & Sendable>(_ path: String, as: T.Type) async throws -> T {
        try await decode(request(path), as: T.self)
    }
    func post<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, body: B, as: T.Type) async throws -> T {
        var request = request(path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await decode(request, as: T.self)
    }
    func events(after: Int) -> URLSessionWebSocketTask {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"
        components.path = "/v1/events"
        components.queryItems = [URLQueryItem(name: "after", value: String(after))]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        socket.resume()
        return socket
    }
    func close() { session.invalidateAndCancel() }
}

enum CredentialStore {
    private static let service = "com.phoneassistant.connection"
    static func load() -> ConnectionConfig? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "primary",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(ConnectionConfig.self, from: data)
    }
    static func save(_ config: ConnectionConfig) throws {
        let data = try JSONEncoder().encode(config)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "primary"]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query
            entry[kSecValueData as String] = data
            entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else {
                throw ClientError.message("无法保存设备凭证。")
            }
        } else if status != errSecSuccess { throw ClientError.message("无法更新设备凭证。") }
    }
}
