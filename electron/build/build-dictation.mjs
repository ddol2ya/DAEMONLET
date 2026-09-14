import { BUNDLE_ID } from "../shared/app-identity.mjs"
import { execFile } from "node:child_process"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
const root = resolve(import.meta.dirname, "../..")
const native = resolve(root, "dist-electron/native")
await mkdir(native, { recursive: true })
const targetPlatform = process.env.PET_BUILD_PLATFORM ?? process.platform
if (targetPlatform === "darwin" && process.platform !== "darwin") throw new Error("Build the macOS speech helper on macOS")
if (targetPlatform === "darwin") {
  const bundle = resolve(native, "DaemonletDictation.app/Contents")
  await mkdir(resolve(bundle, "MacOS"), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}.dictation</string>
<key>CFBundleExecutable</key><string>DaemonletDictation</string>
<key>CFBundleName</key><string>Daemonlet Dictation</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>ko</string><string>en</string></array>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>말한 내용을 후속 질문 입력창에 받아쓰려면 마이크 접근이 필요합니다.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>말한 내용을 받아씁니다. 기기 내 인식을 사용할 수 없으면 음성이 Apple 음성 인식 서비스로 전송됩니다.</string>
</dict></plist>`
  await writeFile(resolve(bundle, "Info.plist"), plist)
  await cp(resolve(root, "electron/assets/locales"), resolve(bundle, "Resources"), { recursive: true })
  const cache = resolve(root, ".generated/swift-module-cache")
  await mkdir(cache, { recursive: true })
  await promisify(execFile)("/usr/bin/xcrun", ["swiftc", "-O", "-module-cache-path", cache,
    resolve(root, "electron/native/Dictation.swift"), "-o", resolve(bundle, "MacOS/DaemonletDictation"),
    "-framework", "AVFoundation", "-framework", "Speech"], { timeout: 120_000, maxBuffer: 1024 * 1024 })
}
