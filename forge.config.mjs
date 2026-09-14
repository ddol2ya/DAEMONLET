import { MakerZIP } from "@electron-forge/maker-zip"
import { resolve } from "node:path"

import { APP_NAME, BUNDLE_ID } from "./electron/shared/app-identity.mjs"

export default {
  packagerConfig: {
    name: APP_NAME,
    executableName: APP_NAME,
    appBundleId: BUNDLE_ID,
    ...((process.env.PET_BUILD_PLATFORM ?? process.platform) === "darwin" ? { icon: resolve(import.meta.dirname, "electron/assets/appIcon.icns") } : (process.env.PET_BUILD_PLATFORM ?? process.platform) === "win32" ? { icon: resolve(import.meta.dirname, "electron/assets/appIcon.ico") } : {}),
    asar: true,
    extendInfo: { CFBundleDevelopmentRegion: "en", CFBundleLocalizations: ["ko", "en"], LSUIElement: true, NSMicrophoneUsageDescription: "말한 내용을 후속 질문 입력창에 받아쓰려면 마이크 접근이 필요합니다.", NSSpeechRecognitionUsageDescription: "말한 내용을 받아씁니다. 기기 내 인식을 사용할 수 없으면 음성이 Apple 음성 인식 서비스로 전송됩니다." },
    extraResource: ["dist-electron/codex", "dist-electron/native", "dist-notices/licenses", ...((process.env.PET_BUILD_PLATFORM ?? process.platform) === "darwin" ? ["electron/assets/locales/en.lproj", "electron/assets/locales/ko.lproj"] : [])],
    ignore: (path) => path !== "" && !/^\/(package\.json|dist(?:\/|$)|dist-electron(?:\/|$))/.test(path),
  },
  makers: [new MakerZIP({}, ["darwin", "win32"])],
}
