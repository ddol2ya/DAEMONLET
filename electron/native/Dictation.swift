import Foundation
import AVFoundation
import Speech

// One foreground-requested, bounded dictation. Audio is not written to disk.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}
let arguments = CommandLine.arguments
let localeIndex = arguments.firstIndex(of: "--locale")
let localeId: String
if let index = localeIndex {
    guard index + 1 < arguments.count, ["ko-KR", "en-US"].contains(arguments[index + 1]) else { exit(2) }
    localeId = arguments[index + 1]
} else { localeId = "ko-KR" }
let locale = Locale(identifier: localeId)
let recognizer = SFSpeechRecognizer(locale: locale)
if CommandLine.arguments.contains("--check") {
    emit(["type": "capability", "locale": localeId, "supported": recognizer != nil, "onDevice": recognizer?.supportsOnDeviceRecognition ?? false, "available": recognizer?.isAvailable ?? false,
          "speechAuthorized": SFSpeechRecognizer.authorizationStatus() == .authorized,
          "microphoneAuthorized": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized])
    exit(0)
}
if !CommandLine.arguments.contains("--dictate") { exit(2) }
let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var tapInstalled = false
var finishing = false
var finished = false
var lastText = ""
func finish(_ error: String? = nil) {
    if finished { return }; finished = true
    engine.stop()
    if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    request?.endAudio(); task?.cancel()
    if let error { emit(["type": "error", "code": error]) }
    else { emit(["type": "final", "text": lastText]) }
    exit(0)
}
func stop() {
    if finished || finishing { return }; finishing = true
    engine.stop()
    if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    request?.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish() }
}
func start() {
    guard let recognizer else { finish("UNAVAILABLE"); return }
    guard recognizer.isAvailable else { finish("RECOGNITION_FAILED"); return }
    let audio = SFSpeechAudioBufferRecognitionRequest()
    audio.shouldReportPartialResults = true
    audio.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    audio.taskHint = .dictation
    request = audio
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { finish("AUDIO_UNAVAILABLE"); return }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in audio.append(buffer) }
    tapInstalled = true
    task = recognizer.recognitionTask(with: audio) { result, error in
        DispatchQueue.main.async {
            if finished { return }
            if let result {
                lastText = String(result.bestTranscription.formattedString.prefix(4000))
                emit(["type": "partial", "text": lastText])
                if result.isFinal { finish(); return }
            }
            if error != nil { finish(finishing ? nil : "RECOGNITION_FAILED") }
        }
    }
    do { engine.prepare(); try engine.start(); emit(["type": "listening"]) }
    catch { finish("AUDIO_UNAVAILABLE") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 55) { stop() }
}
// A closed parent pipe cancels recording, even if the Electron process crashes.
DispatchQueue.global().async {
    while let line = readLine() {
        if line == "stop" { DispatchQueue.main.async { stop() }; return }
        if line == "cancel" { DispatchQueue.main.async { finish() }; return }
    }
    DispatchQueue.main.async { finish() }
}
SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { DispatchQueue.main.async { finish("PERMISSION_DENIED") }; return }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async { if granted { start() } else { finish("PERMISSION_DENIED") } }
    }
}
// Also bound the permission prompt / startup path; never record indefinitely.
DispatchQueue.main.asyncAfter(deadline: .now() + 65) { finish() }
RunLoop.main.run()
