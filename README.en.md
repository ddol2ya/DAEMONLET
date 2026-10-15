# Daemonlet for Codex

[한국어](README.md) · **English**

**A desktop character that reacts to Codex tasks and chats with you in a speech bubble.**

Daemonlet reflects your task status through poses and speech bubbles, and lets you talk to your character using a local AI model and listen to its replies. A separately configured **Dots connection** also displays text, expressions and status sent through tools. Start with the built-in **Gpichan (지피쨩)**, or import other characters as external `.petchar` packs.

This is not an official OpenAI product and is not affiliated with OpenAI.

<img src="docs/images/gpichan.png" width="360" alt="Gpichan running in Daemonlet for Codex">

## Downloads — v0.8.5

| Platform | Download | Notes |
|---|---|---|
| macOS · Apple Silicon | [Mac ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/Daemonlet-for-Codex-0.8.5-macOS-arm64.zip) | macOS 13+ · Developer ID signed and notarized by Apple |
| Windows · x64 | [Installer](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/Daemonlet-for-Codex-0.8.5-windows-x64-Setup.exe) | Windows 10 build 19045+ · Per-user installation · Unsigned |
| Windows · x64 | [Portable ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/Daemonlet-for-Codex-0.8.5-windows-x64.zip) | Extract the entire folder and run · Unsigned |

[Release notes and verification limits](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.5) · [SHA-256 checksums](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/SHA256SUMS.txt) · [Build provenance](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/SOURCE-PROVENANCE.json)

The core app needs no separate Node.js, Python, ComfyUI or manual server installation. **Local chat and voice TTS each need a model installed separately through the app.** Windows GGUF runtimes are bundled with the release; their models download separately. Mac Qwen and legacy Windows PyTorch installers also prepare dedicated Python environments. Task status and authored click reactions do not need model weights. **Dots connection separately requires Node.js, the official tunnel-client and account setup.** Both Windows packages are unsigned: their publisher signature cannot be verified. SHA-256 checks that a file matches the published download.

## What's new in v0.8.5

- **Windows CUDA and Vulkan chat:** One app includes both runtimes, with Automatic, CUDA and Vulkan choices. Automatic prefers CUDA and uses Vulkan when needed.
- **Automatic voice GPU selection:** Qwen and Vox GGUF select their backend independently of chat. Automatic file preparation sets up both runtimes with shared models.
- **GPU generation gate removed:** GGUF CUDA voice no longer requires an exact compute capability of 8.9. Driver, file-integrity and actual GPU-loading checks remain.
- Existing conversations, voices, manual backend choices and external model connections are preserved. Windows hardware validation uses RTX 4090; other GPUs are not established as working.

[Release details and verification limits](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.5)

## Quick start

1. Download the app for your operating system.
   - **Mac:** Extract the ZIP and move `Daemonlet for Codex.app` to Applications.
   - **Windows:** Run the installer. For the portable ZIP, extract the entire folder.
2. Run **Daemonlet for Codex**. The built-in Gpichan appears.
3. Choose a feature:
   - **Local chat:** Open **Local character chat (로컬 캐릭터 대화)** from the character context menu or menu bar/tray, install a model in **Daemonlet Settings → Chat & voice**, and send a message. No Codex login or parent conversation is required.
   - **Listen to replies:** In **Settings → Chat & voice → Character voice**, choose an engine and **Get and connect the required files**. Select a voice, open character chat, enable voice and choose **Test voice**. Qwen requires an authorized WAV reference.
   - **Task status:** Start a task in the **Codex desktop app** under the same OS user account.
   - **Dots output:** Open **Settings → Dots connection → Open Dots connection wizard**. Follow the installation, permissions and output test in [Dots connection](#dots-connection--optional) below.

**The desktop connection does not require CLI Hooks.**

For installation, recovery and removal details, see the [Mac guide](docs/install-macos.md) and [Windows guide](docs/install-windows.md).

| Feature | Connection/model | Purpose |
|---|---|---|
| Codex task integration | Codex desktop app under the same OS user | Task status, usage display and selected-task controls |
| Local character chat | Separately installed local chat model | Talk directly to the character · No file, shell or MCP tool execution |
| Codex task chat · Side Chat | Official CLI, login and selected parent conversation | Explain completed task context · May consume Codex usage |
| Dots connection | Separate tunnel and personal plugin | Display explicitly sent text, expressions and status, with optional local voice |

**v0.7.1** adds Korean/English selection under **Settings → 언어 / Language**, also available from the tray menu. The choice is saved and applies immediately to app windows; Mac dictation uses the selected language from the next recording. Existing drafts are preserved. Character names and authored dialogue stay in the pack’s original language. macOS permission dialogs follow the system’s language settings. Windows dictation is not supported. Some linked guides remain in Korean; both language labels are included below.

## Features

- **Local character chat:** Talk in a speech bubble with streamed replies, cancellation and retry.
- **Voice TTS · experimental:** Automatically read replies, reread saved answers, stop speech, and choose chunk or complete playback.
- **Vox, Qwen and WAV:** Windows GGUF CUDA/Vulkan and Mac Metal/MLX paths support authorized WAV references and compatible Vox trained packs.
- **Dots connection:** Prepare a personal tunnel with the wizard and send/cancel output with `present` and `cancel` tools.
- **Audio lip-sync:** Compatible packs move the mouth to actual playback amplitude. Belle 1.2.3 supports 37 poses.
- **Chat & voice settings:** Manage local models, voice installation/connections, playback mode and volume in Settings.
- **Conversation management:** Save, resume and delete conversations per character; manage explicitly saved memories.
- **Chat poses and motion:** Follow the pack's emotion/gesture declarations and retain the last reply pose until the next request.
- **Task status:** Poses and task bubbles change as Codex works.
- **Character interactions:** Click the head or torso, or stroke the head.
- **Display settings:** Adjust character size, position, opacity, click-through and bubble visibility.
- **Additional characters:** Import external `.petchar` packs.
- **Loading feedback:** See progress while importing characters and preparing the app at startup.
- **Mac voice input:** Use Korean or English dictation to compose a message to send to Codex.

## Local character chat

Choose **Local character chat (로컬 캐릭터 대화)** from the character context menu or menu bar/tray to open a messenger-style speech bubble beside the character.

1. Install **Gemma 4 E4B or 12B** under **Settings → Chat & voice → Local chat model**. Downloads support resume, cancellation and file verification; an exact matching official GGUF can also be imported. Model downloads start only when requested.
2. Send a message to receive a streamed reply. Stop generation with the cancel button, then send another question.
3. The bubble’s **···** menu contains only **character selection and saved conversations**. Use **Settings → Chat & voice** for new conversations, retry, deletion, models, voice and explicit memories. Empty new conversations are saved only after the first message.
4. Drag the header to move the bubble and the bottom-right handle to resize it. Placement and size persist across restarts.

After model installation, **reply generation runs locally**. It uses no paid external chat/evaluation API and provides no file-editing, shell or MCP tool permissions. When enabled, TTS reads completed replies using a separate local voice engine.

| Environment | Local chat runtime |
|---|---|
| Mac · Apple Silicon | Metal |
| Windows · x64 | CUDA / Vulkan · automatic or explicit selection |

E4B/12B multi-turn generation, cancellation and recovery were checked on both platforms. The earlier [0.8.2 verification](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.2) included actual upgrades with the notarized Mac app and official Windows installer, settings/conversation preservation and voice behavior. **Minimum RAM/VRAM requirements have not been established.** Intel Mac and Windows AMD/Intel GPU paths are not presented as verified. See the [0.8.5 release notes](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.5) for the latest verification scope and remaining limitations.

Chat names, persona and emotional poses come from the pack. Legacy packs without chat metadata can still chat in their default pose. Fast replies skip the preparation pose, and the final reply pose remains until the next request. New conversations, cancellation, errors and character/model changes clear that state.

[Usage, models and storage](docs/local-character-chat.md) · [Windows runtime guide](docs/windows-character-chat.md)

## Voice TTS — experimental in v0.8.5

Under **Settings → Chat & voice → Character voice**, follow **① Choose a voice engine → ② Get and connect the required files → ③ Choose or add a voice → ④ Test and enable voice**. New Windows x64 installations use **Qwen GGUF** as the recommended default; Apple Silicon uses **VoxCPM2 Metal**. Existing engine, model and voice choices are preserved.

1. Choose an engine: Qwen/Vox GGUF on Windows, or Vox Metal/Qwen MLX on Mac. Existing Windows PyTorch paths remain under **Legacy engines and models**.
2. Choose **Get and connect the required files** to prepare the selected model and app-local runtime. Previously downloaded files are verified and reused. Managed Windows GGUF runtimes require reviewing and explicitly accepting the original terms for the included Microsoft components. **Acceptance alone starts neither installation nor speech.**
3. Under **Choose or add a voice → Character voice**, select the Vox default, an authorized WAV reference or a compatible trained pack. **Qwen requires a WAV reference.**
4. Enable voice, open local character chat and choose **Test voice**. Set automatic reading and volume; select chunk or complete playback under **Advanced settings and existing files → Voice execution mode**.

| Platform/engine | Models and runtime | Playback |
|---|---|---|
| Mac · VoxCPM2 Metal | Bundled Metal engine + about 5.1GB of separately downloaded GGUF models | Chunk / complete |
| Mac · Qwen MLX | mlx-community MLX 4-bit conversion + dedicated Python/MLX runtime · About 1.86GB total · 8GiB free space | Chunk / complete |
| Windows · Qwen GGUF | Community-converted 0.6B Base Q8 + codec Q8 models, about 1.28GB · Separately prepare the bundled app-local runtime | CUDA / Vulkan · chunk / complete |
| Windows · VoxCPM2 GGUF | Community-converted BaseLM F16 + Acoustic F16 models, about 5.07GB · Separately prepare the bundled app-local runtime | CUDA / Vulkan · chunk / complete |

**Windows GGUF CUDA execution requires an R580 or newer NVIDIA driver.** The app does not block execution by GPU model name or compute capability. The current binaries were built targeting 8.9, so passing preflight does not establish successful model loading or speech on other GPUs. GPU validation of CUDA and Vulkan is limited to the RTX 4090 development environment. AMD/Intel GPUs and other NVIDIA GPUs are not established as working. Adding GGUF voice paths does not broaden the verified GPU support of local character chat. The app does not install a CUDA SDK or GPU driver.

Model downloads start only from an explicit button and support progress, cancellation, resume and SHA-256 verification. The Windows GGUF models are **community conversions**, not official GGUF releases from Qwen or OpenBMB. Downloading a model alone does not change the engine or voice. Runtime-file verification, model connection and actual GPU loading are separate stages; initial loading and reference conditioning still take time.

Chunk mode plays generated audio in order. Complete playback waits for **each utterance group** to finish and can leave gaps between groups. Short expressions stay together; longer replies split at conversational transitions. New synthesis uses a random seed per reply by default, with an optional fixed seed. Use **Play / Replay saved audio** and **Voice options** on an answer to replay or regenerate with another seed, the same conditions or current settings. **Stop voice** cancels speech; hiding or closing character chat also stops it. See [seeds and replay](docs/character-chat-voice-seeds.md).

### WAV references and trained packs

Under **Choose or add a voice → Add a voice from WAV**, enter a name, confirm permission and import one clear speaker's **2–20 second WAV, at most 20MiB**. PCM16, PCM24 and float32 mono/stereo are supported. Select the imported profile under **Character voice** afterward. Importing alone neither changes the current voice nor downloads a model.

- **Qwen:** Reference cloning does not apply VoxCPM2 LoRA weights. **X-vector** uses the speaker embedding; **ICL** also needs the exact words spoken in the WAV. Choose the reference mode in advanced settings.
- **Vox default/WAV:** Uses the public base model without a personal LoRA. WAV reference conditioning requires no separate training.
- **Vox trained packs:** Require a compatible F16 GGUF containing that pack's LoRA, or a validated legacy runtime. Switching to Qwen does not apply Vox training weights to Qwen. Original packs and reference WAVs are preserved.

Output is AI-generated speech and does not guarantee an identical voice. Speed and quality vary with the reference, hardware and other running models. See [WAV formats, storage and deletion](docs/character-chat-wav-cloning.md).

### Prepared engines and model management

**Prepare voice engine** loads the installed engine and selected voice without opening chat, creating a conversation or playing audio. Voice must be enabled; Dots mute and zero volume do not block preparation. After normal Dots speech, the prepared worker is retained for reuse. Disabling all voice, changing engines and quitting unload the prepared worker. Dots mute releases a Dots-only worker while preserving one used by local chat. Initial readiness time and speedup factors are not guaranteed.

Use **Manage app-downloaded voice models** or **Legacy engines and models → Keep or remove legacy models** to review removal targets. Only app-managed models and model download caches move to the trash; external models, personal trained GGUF files, trained packs and reference WAVs are excluded. Removing a currently used model requires preparing it again. Disk space remains occupied until the trash is emptied.

Legacy Windows PyTorch installers remain available: Vox downloads about 8.6GB and Qwen about 6.21GB, each requiring 30GiB free space and a BF16-capable NVIDIA GPU. Existing connections are preserved without automatic migration or deletion. See [legacy Vox installation](docs/character-chat-voice-base-install.md) and [legacy Qwen install, apply and recovery](docs/character-chat-voice-qwen-managed-install.md).

### Trained voice packs and distribution policy

A trained voice pack is a folder separate from a `.petchar` character pack. It needs `voice.json`, complete checksums, LoRA configuration/weights, reference/preview audio, provenance and license notes. Use **Advanced settings and existing files → Import voice package** to select the entire folder and bind it to a character. A standalone LoRA file is insufficient.

Trained packs also need a compatible independent runtime and the pinned original VoxCPM2 model. Preparing public models/runtimes does not automatically convert arbitrary trained packs. On Mac, first preparation creates and caches a separate GGUF with the selected LoRA applied, requiring 30GB of temporary free space. Windows admission is limited to validated pack/derivative contracts; compatible Mac F16 derivatives can be reused after verification. **Arbitrary models and LoRAs are not universally compatible.** See the [required files, platform setup and import guide (Korean)](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.2/VOICE-PACK-GUIDE.md).

Because trained voice packs can reproduce a specific person's voice, **the project has no plans to distribute them separately.** Import is intended for compatible packs users prepare themselves and have permission to use. Releases do not include voice model weights, trained LoRAs, the Belle voice pack, external character packs or personal conversations/settings.

## Desktop controls

Task bubbles and local chat bubbles have separate placement controls.

- **Move:** Option-drag on Mac or Alt-drag on Windows from a painted part of the character. Release to save; Esc restores the starting position. Ordinary clicks, petting and the existing move/resize menu remain available.
- **Size and opacity:** Settings → Character & Display saves size from 20–400% and opacity from 0–100%. At **50% opacity or lower, the entire character passes clicks through**. Above that threshold, the existing transparent-pixel click-through setting applies. Bubbles and task cards are separate windows. Option-wheel (Mac) or left Alt-wheel (Windows) over the character adjusts opacity.
- **Recover from click-through:** If you cannot click or see the character, use **Restore 100% opacity** in the tray or Settings. Opacity and visibility are separate settings; lowering opacity does not stop voice or the Dots connection.
- **Bubble position:** Use the menu or Settings → Character & Display → Bubble position. Choose Auto, Adjust position or Reset position. Drag the local preview handle and Apply; Cancel/Esc keeps the previous setting. Reset affects only bubble placement.
- **Resident app:** Use the menu bar/tray for Show Character, Conversation, Settings and Quit. Closing a normal window leaves the app running. Tray creation failure restores an accessible Settings window and Dock/taskbar route. You may need to check the OS hidden-icon area.
- Opening chat restores a hidden/offscreen character. An explicit saved chat OFF stays OFF with a visible enable control. Opening the menu does not send a model request.

## Dots connection — optional

Display text, expressions and status that Dots **explicitly sends with `present`**, and stop it with `cancel`. **Connecting does not automatically forward every reply.** These output tools provide no file access, command execution, conversation history or two-way realtime voice chat.

1. Separately install **Node.js 22.13+** and the [official OpenAI tunnel-client](https://github.com/openai/tunnel-client). Follow its Homebrew instructions on Mac or the official release's Windows distribution/setup guidance. The app does not install these tools. It checks at least version 0.0.14 and required health/MCP options. The official latest release is [0.0.15](https://github.com/openai/tunnel-client/releases/tag/v0.0.15), while this app's live verification used 0.0.14; that does not establish verification of the newer version.
2. Open **Settings → Dots connection → Open Dots connection wizard** and check prerequisites. Prepare a tunnel in your own Platform organization and associate the intended ChatGPT workspace. Enter **Tunnel ID** and **Platform organization ID** in the app. The organization ID differs from the ChatGPT workspace ID.
3. Tunnel creation/management needs **Read + Manage**; the dedicated Restricted runtime key needs only **Tunnels Read + Use**. Do not enter an All-permissions or Admin key. The app cannot verify remote key scopes. Enter the key yourself in the app, confirm storage/target, then separately choose **Connect**. Saving alone does not connect.
4. In the intended ChatGPT workspace's developer mode/personal plugin setup, choose a **Tunnel** connection, review the discovered `present` and `cancel` tools and install the plugin. Access depends on account/workspace policy. The app does not create accounts, tunnels, keys or plugins for you. See the [official connection procedure](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
5. First ask the plugin to send a short sentence with `present` and `speak:false`, then check the actual display. **Tunnel ready** and wizard acknowledgements do not prove a tool call, display or audio playback.

Keys are stored in **Mac Keychain / Windows Credential Manager**, with no plaintext fallback. Windows requires a normal interactive login session; unavailable storage in SSH/network logins blocks saving/connecting. Removing the local key does not revoke the Platform key. **Connect automatically when the app starts** defaults OFF and requires an explicit choice. No public inbound port is needed; quitting stops the app-owned connection.

**Dots voice starts muted on connection/reconnection.** To hear it, prepare the existing engine/model/selected voice, enable voice and set volume above zero, then locally uncheck **dot presentation · this session → Mute** in the tray. Remote tools cannot unmute. Test `speak:true` and check the actual sound; `voice:requested` does not guarantee playback completion. Close local/task chat and lab windows using the character surface before testing Dots. Output blocked by a hidden character or another chat is not queued for later playback.

[Wizard and status details](docs/belle-connection-wizard.md) · [Output tools and limits](docs/dot-presentation-bridge.md) · [v0.8.5 public verification scope](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.5)

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

## Codex usage display

Task bubbles show account-wide Codex five-hour/weekly **used** percentages. Missing
windows show `—`; outdated values and usage restrictions are labeled separately.
Refresh from the bubble menu or disable **Show Codex usage** in settings. While
visible, metadata is normally read every 60 seconds without model calls or creating
conversations. See [behavior, privacy and verification](docs/codex-usage-display.md).

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

Separate from local character chat, choose **Ask the character** in the existing task card to ask and read replies in that same window. **Codex task chat** in the character's context menu or tray opens the same task surface. New installations default to ON; an existing OFF choice is preserved. Check official CLI/login readiness, explicitly select a parent conversation, and ask a question. The first send asks for consent to context/file transmission and usage. No model generation occurs before sending. The persona follows the character that successfully appeared on screen.

The **official CLI 0.154.0 / macOS Apple Silicon / gpt-5.6-luna** path creates a separate temporary child in the parent's Codex Home. It explains successfully completed context and user-selected project excerpts and proposes changes for copying. File changes, commands, builds/tests, external services and parent controls are blocked. Expand, copy and hide reuse the original response without another model request.

This feature is included starting with v0.7.2. See [setup, recovery and platform compatibility](docs/side-chat.md). App chat/drafts stay in memory; normal Codex storage, logs and authentication processing can occur.

## App updates

Use the menu or Settings → Updates. Automatic checks default to OFF; downloading and restarting require user actions. Existing public 0.7.1 installations need one manual upgrade first. See [supported installations, signing requirements and verification](docs/app-updates.md).

## Character pack updates

Import a `.petchar` file from the [public character packs](https://huggingface.co/datasets/ddol2/daemonlet-character-packs) to check, download, validate and manually apply updates in Settings, or restore the previous version. Asuma Toki v3, v4 and v5 are independent appearances with separate updates. Older packs without an update source require a one-time import of a source-enabled pack. See [updates, cancellation and rollback](docs/character-pack-updates.md).

**Belle 1.2.3 stable** adds mouth-only lip-sync to its existing 37 poses. **Update the app to 0.8.3 or later first**, then check, download, verify and apply the pack update in its character card. New users can import the `.petchar` from the [Belle pack guide](https://huggingface.co/datasets/ddol2/daemonlet-character-packs/blob/main/packs/belle/1.2.3.README.md). Actual playback amplitude moves only the mouth, with restoration on mute, stop and output completion. This is not phoneme recognition or whole-face/jaw deformation. The pack includes no voice, models or app; its own provenance/license applies separately from the app's MIT license. Downloads and application are manual.

## Character creation and development

[**Download the character creation skill 0.8.5 ZIP**](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/Daemonlet-creator-skill-0.8.5.zip) — includes authoring instructions and standalone runtime source. ComfyUI, See-through and models are not included.

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

To run local chat or package the app, prepare the platform-specific pinned runtime and stage it with `scripts/stage-chat-runtime.mjs` as described in the [runtime/build guide](docs/local-character-chat.md#런타임과-빌드). To package the Mac default TTS engine, also follow the [voice engine build/staging guide](docs/character-chat-voice-base-install.md#packaging). The commands above do not automatically install models or runtimes.

Electron setup uses the local installation script from the lockfile-pinned dependency. Apps built from source do not automatically inherit the release binaries' signing or notarization.

</details>

Distribution builds that include Windows GGUF runtimes also require separately staged, pinned runtime archives. CI source-only verification does not replace actual installer validation. See [build provenance](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/SOURCE-PROVENANCE.json) for v0.8.5 app/runtime identities, and the [runtime rebuild source ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.5/daemonlet-0.8.5-runtime-rebuild-source.zip) for rebuild and LGPL replacement guidance.

## Licenses and attribution

The project code is licensed under [MIT](LICENSE).

[CC BY 4.0](distribution/ARTWORK-LICENSE.md) applies to **project-specific contributions to the designated Gpichan visual files that the provider has authority to license**, and to the separately approved icon. Within that scope, modification, redistribution and commercial use are permitted subject to attribution, license notice and indication of changes.

The terms for the referenced community character designs, images and sheets are **unverified** and are not included in that permission. This does not mean permission has been secured for the images as a whole. See the [file and rights scope](distribution/ARTWORK-SCOPE.json), [source collection and attribution correction](distribution/ARTWORK-NOTICE.md), and [full CC BY license](distribution/licenses/CC-BY-4.0.txt).

External code, upstream assets, models and other character packs remain subject to [their own terms](THIRD_PARTY_NOTICES.md). Packaging files as `.petchar` does not place the entire pack under a single artwork license.

The links above point to files in the source repository. In an installed app, notices are available in `resources/licenses/` on Windows/Linux and `Contents/Resources/licenses/` inside the macOS app bundle; you do not need to open the ASAR archive to read them. The existing MIT credit to `Momo Motion Lab contributors` is retained because there is no basis for changing the copyright holder.
