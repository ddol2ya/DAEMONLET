# Daemonlet for Codex

[한국어](README.md) · **English**

**A desktop character that reacts to Codex tasks and chats with you in a speech bubble.**

Daemonlet reflects your task status through poses and speech bubbles, and lets you talk to your character using a local AI model. Start with the built-in **Gpichan (지피쨩)**, or import other characters as external `.petchar` packs.

This is not an official OpenAI product and is not affiliated with OpenAI.

<img src="docs/images/gpichan.png" width="360" alt="Gpichan running in Daemonlet for Codex">

## Downloads — v0.8.0

| Platform | Download | Notes |
|---|---|---|
| macOS · Apple Silicon | [Mac ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-macOS-arm64.zip) | Developer ID signed and notarized by Apple |
| Windows · x64 | [Installer](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-windows-x64-Setup.exe) | Unsigned |
| Windows · x64 | [Portable ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-windows-x64.zip) | Extract and run without installation |

[Release notes](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.0) · [SHA-256 checksums](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/SHA256SUMS.txt)

The app needs no separate Node.js, Python, ComfyUI or manual server installation. **Local character chat requires installing an E4B or 12B model separately through the app.** Task status and authored click reactions do not need model weights. Both Windows packages are unsigned.

## Quick start

1. Download the app for your operating system.
   - **Mac:** Extract the ZIP and move `Daemonlet for Codex.app` to Applications.
   - **Windows:** Run the installer. For the portable ZIP, extract the entire folder.
2. Run **Daemonlet for Codex**. The built-in Gpichan appears.
3. Choose a feature:
   - **Local chat:** Open **Character Chat · Local (캐릭터챗 · 로컬)** from the character context menu or menu bar/tray, install a model and send a message. No Codex login or parent conversation is required.
   - **Task status:** Start a task in the **Codex desktop app** under the same OS user account.

**The desktop connection does not require CLI Hooks.**

For installation, recovery and removal details, see the [Mac guide](docs/install-macos.md) and [Windows guide](docs/install-windows.md).

**v0.7.1** adds Korean/English selection under **Settings → 언어 / Language**, also available from the tray menu. The choice is saved and applies immediately to app windows; Mac dictation uses the selected language from the next recording. Existing drafts are preserved. Character names and authored dialogue stay in the pack’s original language. macOS permission dialogs follow the system’s language settings. Windows dictation is not supported. Some linked guides remain in Korean; both language labels are included below.

## Features

- **Local character chat:** Talk in a speech bubble with streamed replies, cancellation and retry.
- **Conversation management:** Save, resume and delete conversations per character; manage explicitly saved memories.
- **Chat poses and motion:** Follow the pack's emotion/gesture declarations and retain the last reply pose until the next request.
- **Task status:** Poses and task bubbles change as Codex works.
- **Character interactions:** Click the head or torso, or stroke the head.
- **Display settings:** Adjust the character's size, position and bubble visibility.
- **Additional characters:** Import external `.petchar` packs.
- **Loading feedback:** See progress while importing characters and preparing the app at startup.
- **Mac voice input:** Use Korean or English dictation to compose a message to send to Codex.

## Local character chat — v0.8.0

Choose **Character Chat · Local (캐릭터챗 · 로컬)** from the character context menu or menu bar/tray to open a messenger-style speech bubble beside the character.

1. Install **Gemma 4 E4B or 12B**. Downloads support resume, cancellation and file verification; an exact matching official GGUF can also be imported. Model downloads start only when requested.
2. Send a message to receive a streamed reply. Stop generation with the cancel button, then send another question.
3. Use the **···** menu for new/saved conversations, retry, deletion, model selection and explicit memories. Empty new conversations are saved only after the first message.
4. Drag the header to move the bubble and the bottom-right handle to resize it. Placement and size persist across restarts.

After model installation, **reply generation runs locally**. It uses no paid external chat/evaluation API and provides no file-editing, shell or MCP tool permissions. This is text chat; TTS is not included.

| Environment | Local chat runtime |
|---|---|
| Mac · Apple Silicon | Metal |
| Windows · x64 + NVIDIA GPU | CUDA |

E4B/12B multi-turn generation, cancellation and recovery were checked on both platforms, with representative UI verification on Mac and the Windows portable app. Windows installer execution was user-confirmed. **Minimum RAM/VRAM requirements have not been established.** Intel Mac and Windows AMD/Intel GPU paths are not presented as verified. See the [0.8.0 release notes](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.0) for verification limits.

Chat names, persona and emotional poses come from the pack. Legacy packs without chat metadata can still chat in their default pose. Fast replies skip the preparation pose, and the final reply pose remains until the next request. New conversations, cancellation, errors and character/model changes clear that state.

[Usage, models and storage](docs/local-character-chat.md) · [Windows runtime guide](docs/windows-character-chat.md)

## Desktop controls

Task bubbles and local chat bubbles have separate placement controls.

- **Move:** Option-drag on Mac or Alt-drag on Windows from a painted part of the character. Release to save; Esc restores the starting position. Ordinary clicks, petting and the existing move/resize menu remain available.
- **Bubble position:** Use the menu or Settings → Character & Display → Bubble position. Choose Auto, Adjust position or Reset position. Drag the local preview handle and Apply; Cancel/Esc keeps the previous setting. Reset affects only bubble placement.
- **Resident app:** Use the menu bar/tray for Show Character, Conversation, Settings and Quit. Closing a normal window leaves the app running. Tray creation failure restores an accessible Settings window and Dock/taskbar route. You may need to check the OS hidden-icon area.
- **Conversation** restores a hidden/offscreen character. An explicit saved chat OFF stays OFF with a visible enable control. Opening the menu does not send a model request.

## Add a character

The default app includes **Gpichan only**.

1. Open **Settings (설정) → Character & Display (캐릭터·표시) → Add Character (캐릭터 추가)**.
2. Select your `.petchar` file.
3. Once the file and behavior checks finish, select the imported character.

Additional characters and settings are stored separately from the app installation folder.

| Platform | User data location |
|---|---|
| Mac | `~/Library/Application Support/Daemonlet for Codex` |
| Windows | `%APPDATA%\Daemonlet for Codex` |

Large packs or characters with many poses may take time to prepare. See [Privacy and local data](PRIVACY.md) for backup, deletion and reset instructions.

## Codex CLI connection — optional

Set up Hooks if you also want to receive task events from Codex CLI in your terminal.

1. In Daemonlet, open **Settings (설정) → Codex Connection (Codex 연결) → CLI Hook Setup (CLI Hook 설정)**. If Hooks are already installed, the button reads **Check Hooks (Hook 확인)**.
2. Review and apply the installation or repair preview.
3. Open `/hooks` in Codex CLI, review the Daemonlet Hooks and mark them as trusted.
4. Run a new task and confirm that Daemonlet receives the events.

Windows supports **CMD and PowerShell**. Running the Hooks does not require a separate Node.js installation.

> **CLI-only use has limitations.**
> If you close the Codex desktop app and use only the CLI, some pose transitions or task indicators may not work correctly. Keep the Codex desktop app running alongside the CLI.

Daemonlet does not approve Hook trust on your behalf. If you move the app, review the repair preview in Settings.

## Troubleshooting and bug reports

For connection or character display issues, start with the connection recovery and removal sections in the platform guides.

- [Mac installation, permissions and connection](docs/install-macos.md)
- [Windows installation, Hooks and connection](docs/install-windows.md)
- [Privacy, storage locations and deletion](PRIVACY.md)

When [reporting a bug](https://github.com/ddol2ya/DAEMONLET/issues), include the app version, operating system, steps to reproduce and screenshots with personal information removed. Do not post account tokens, original conversations or your full Codex configuration.

## Ask about Codex tasks — Side Chat

Separate from local character chat, choose **Ask the character** in the existing task card to ask and read replies in that same window. **Chat with character** in the character's context menu or tray opens the same task surface. New installations default to ON; an existing OFF choice is preserved. Check official CLI/login readiness, explicitly select a parent conversation, and ask a question. The first send asks for consent to context/file transmission and usage. No model generation occurs before sending. The persona follows the character that successfully appeared on screen.

The **official CLI 0.154.0 / macOS Apple Silicon / gpt-5.6-luna** path creates a separate temporary child in the parent's Codex Home. It explains successfully completed context and user-selected project excerpts and proposes changes for copying. File changes, commands, builds/tests, external services and parent controls are blocked. Expand, copy and hide reuse the original response without another model request.

This feature is included starting with v0.7.2. See [setup, recovery and platform compatibility](docs/side-chat.md). App chat/drafts stay in memory; normal Codex storage, logs and authentication processing can occur.

## App updates

Use the menu or Settings → Updates. Automatic checks default to OFF; downloading and restarting require user actions. Existing public 0.7.1 installations need one manual upgrade first. See [supported installations, signing requirements and verification](docs/app-updates.md).

## Character pack updates

Import a `.petchar` file from the [public character packs](https://huggingface.co/datasets/ddol2/daemonlet-character-packs) to check, download, validate and manually apply updates in Settings, or restore the previous version. Asuma Toki v3, v4 and v5 are independent appearances with separate updates. Older packs without an update source require a one-time import of a source-enabled pack. See [updates, cancellation and rollback](docs/character-pack-updates.md).

## Character creation and development

[**Download the character creation skill 0.8.0 ZIP**](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-creator-skill-0.8.0.zip) — includes authoring instructions and standalone runtime source.

Export includes confirmed emotion/gesture meaning metadata. Use `upgrade-chat` to prepare a chat metadata update while preserving an existing pack's visual assets. See the [character chat authoring guide](skills/create-pet-character/references/character-chat.md).

The character creation tools are **experimental** and are not included in the regular app downloads. ComfyUI, See-through and models must be prepared separately by the user.

- [Character creation skill](skills/create-pet-character/SKILL.md)
- [Creator environment setup](docs/creator-setup.md)
- [Character production workflow](docs/character-production-workflow.md)
- [Character pack format](docs/character-pack-format.md)
- [Source builds and releases](docs/releasing.md)

<details>
<summary>Run from source</summary>

Build from a Git checkout. **Node 24** is the validated baseline; the declared minimum version is 22.13.0.

On macOS, compiling the voice input helper requires Xcode Command Line Tools. Windows source builds require Visual Studio C++ Build Tools.

```sh
npm ci
npm run electron:install
npm run electron:dev
```

Checks and production builds:

```sh
npm run typecheck
npm test
npm run build:renderer
npm run build:electron:production
npm run electron:package
```

To run local chat or package the app, prepare the platform-specific pinned runtime and stage it with `scripts/stage-chat-runtime.mjs` as described in the [runtime/build guide](docs/local-character-chat.md#런타임과-빌드). The commands above do not automatically install models or that runtime.

Electron setup uses the local installation script from the lockfile-pinned dependency. Apps built from source do not automatically inherit the release binaries' signing or notarization.

</details>

## Licenses and attribution

The project code is licensed under [MIT](LICENSE).

[CC BY 4.0](distribution/ARTWORK-LICENSE.md) applies to **project-specific contributions to the designated Gpichan visual files that the provider has authority to license**, and to the separately approved icon. Within that scope, modification, redistribution and commercial use are permitted subject to attribution, license notice and indication of changes.

The terms for the referenced community character designs, images and sheets are **unverified** and are not included in that permission. This does not mean permission has been secured for the images as a whole. See the [file and rights scope](distribution/ARTWORK-SCOPE.json), [source collection and attribution correction](distribution/ARTWORK-NOTICE.md), and [full CC BY license](distribution/licenses/CC-BY-4.0.txt).

External code, upstream assets, models and other character packs remain subject to [their own terms](THIRD_PARTY_NOTICES.md). Packaging files as `.petchar` does not place the entire pack under a single artwork license.

The links above point to files in the source repository. In an installed app, notices are available in `resources/licenses/` on Windows/Linux and `Contents/Resources/licenses/` inside the macOS app bundle; you do not need to open the ASAR archive to read them. The existing MIT credit to `Momo Motion Lab contributors` is retained because there is no basis for changing the copyright holder.

Task bubbles show account-wide Codex five-hour/weekly **used** percentages. Missing
windows show `—`; outdated values and usage restrictions are labeled separately.
Refresh from the bubble menu or disable **Show Codex usage** in settings. While
visible, metadata is normally read every 60 seconds without model calls or creating
conversations. See [behavior, privacy and verification](docs/codex-usage-display.md).
