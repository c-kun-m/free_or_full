import Foundation
import Combine
@preconcurrency import AVFoundation
@preconcurrency import Speech

// Audio callbacks never access MainActor state. Serialize request append/end explicitly.
private final class RecognitionSink: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        request?.append(buffer)
    }
    func end() {
        lock.lock(); defer { lock.unlock() }
        request?.endAudio(); request = nil
    }
}

@MainActor
final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var isStarting = false
    @Published var isSpeaking = false
    @Published var error: String?
    private let engine = AVAudioEngine()
    private let synthesizer = AVSpeechSynthesizer()
    private var recognition: SFSpeechRecognitionTask?
    private var sink: RecognitionSink?
    private var hasTap = false
    private var generation = 0
    private var limit: Task<Void, Never>?
    private var utteranceID: ObjectIdentifier?

    override init() { super.init(); synthesizer.delegate = self }
    func start() async {
        stop()
        let expected = generation
        isStarting = true
        let microphone = await AVAudioApplication.requestRecordPermission()
        let authorized: Bool = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status == .authorized) }
        }
        guard generation == expected else { return }
        isStarting = false
        guard microphone && authorized else {
            error = "请在系统设置中允许麦克风和语音识别；你仍可以直接输入文字。"; return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")), recognizer.isAvailable else {
            error = "语音识别暂不可用，请稍后重试或输入文字。"; return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
            let sink = RecognitionSink(request)
            self.sink = sink
            transcript = ""
            recognition = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, failure in
                let text = result?.bestTranscription.formattedString
                let finished = result?.isFinal == true
                let failed = failure != nil
                Task { @MainActor [weak self] in
                    guard let self, self.generation == expected else { return }
                    if let text { self.transcript = text }
                    if finished || failed {
                        self.stopRecording()
                        if failed && self.transcript.isEmpty { self.error = "未能识别语音，请重试或输入文字。" }
                    }
                }
            }
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw ClientError.message("麦克风不可用。") }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable buffer, _ in sink.append(buffer) }
            hasTap = true
            engine.prepare()
            try engine.start()
            isRecording = true
            limit = Task { [weak self] in
                try? await Task.sleep(for: .seconds(45))
                guard !Task.isCancelled else { return }
                self?.stopRecording()
            }
        } catch { stopRecording(); self.error = error.localizedDescription }
    }
    func stopRecording() {
        generation += 1
        isStarting = false
        limit?.cancel(); limit = nil
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        sink?.end(); sink = nil
        recognition?.cancel(); recognition = nil
        isRecording = false
        if !isSpeaking { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    func speak(_ text: String) {
        stop()
        guard !text.isEmpty else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try session.setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
            utteranceID = ObjectIdentifier(utterance)
            isSpeaking = true
            synthesizer.speak(utterance)
        } catch { self.error = error.localizedDescription }
    }
    func stopSpeaking() {
        utteranceID = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        if !isRecording { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    func stop() { stopRecording(); stopSpeaking() }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in
            guard self?.utteranceID == id else { return }
            self?.stopSpeaking()
        }
    }
}
