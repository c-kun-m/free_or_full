import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var model: AssistantModel
    @Environment(\.dismiss) private var dismiss
    @State private var address = "https://"
    @State private var fingerprint = ""
    @State private var code = ""
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("电脑连接信息") {
                    TextField("HTTPS 地址", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("pairingAddress")
                    TextField("证书 SHA-256 指纹", text: $fingerprint, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("一次性配对码", text: $code)
                    Text("让手机和电脑连接同一局域网，填入电脑服务显示的地址、指纹和配对码。配对码 5 分钟内有效。")
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(model.isPairing)
                if let failure { Section { Text(failure).foregroundStyle(.red).textSelection(.enabled) } }
                Button {
                    failure = nil
                    Task {
                        if await model.pair(address: address, fingerprint: fingerprint, code: code) { dismiss() }
                        else { failure = model.error; model.error = nil }
                    }
                } label: {
                    if model.isPairing { ProgressView("正在配对…") } else { Text("连接电脑") }
                }
                .disabled(model.isPairing || model.sending || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || fingerprint.isEmpty)
                .accessibilityIdentifier("pairComputer")
            }
            .navigationTitle("配对电脑")
            .toolbar { Button("关闭") { dismiss() }.disabled(model.isPairing) }
            .interactiveDismissDisabled(model.isPairing)
        }
    }
}
