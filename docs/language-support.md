# App language

Version 0.7.1 supports Korean (`ko`) and English (`en`) on macOS and Windows. Version 0.7.0 predates this feature.

Choose **Settings → 언어 / Language** or the same submenu in the tray/character menu. The choice is saved in `desktop-settings.json`. Existing settings default to Korean and retain the selected character and display preferences. All open app windows update without reloading the character. Imported names, conversation titles, authored character dialogue and technical diagnostic values remain unchanged.

Mac dictation captures the selected language at the start of each recording: `ko-KR` or `en-US`. Switching language during dictation applies to the next recording, preserving the current recording and editable draft. Existing speech-recognition and microphone permissions still apply. When on-device recognition is unavailable, the existing Apple recognition service fallback remains in use. macOS permission dialogs use the system’s preferred language. Windows dictation remains unavailable.

## Validation

- `npm run typecheck` and `npm test` cover setting migration, persistence, IPC scope, translations and dictation locale/lifecycle behavior.
- After `npm run build:renderer` and `npm run build:electron`, run `npm run language:smoke` on a desktop host. It opens hidden test windows with an isolated temporary profile, uses the real renderer/preload bundles and fixture IPC, and writes screenshots/results to ignored `outputs/evidence/app-language`. It checks live language changes, persistence/reload, narrow layouts, character loading progress and draft retention through simulated dictation. It does not use live Codex or the microphone.
- A new signed Mac candidate still needs real Korean/English dictation verification and its own notarization. An older candidate’s native validation does not cover this change.
