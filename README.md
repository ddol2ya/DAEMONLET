# Daemonlet for Codex

**한국어** · [English](README.en.md)

**Codex 작업에 반응하고, 말풍선으로 대화하는 데스크톱 캐릭터.**

작업 상태에 따라 포즈와 말풍선이 바뀌며, 로컬 AI 모델로 캐릭터와 직접 대화할 수 있는 앱입니다. 기본 캐릭터 **지피쨩**과 함께 시작하고, 외부 `.petchar` 팩으로 다른 캐릭터를 추가할 수 있습니다.

OpenAI의 공식 제품이나 제휴 제품이 아닙니다.

<img src="docs/images/gpichan.png" width="360" alt="Daemonlet for Codex에서 실행 중인 지피쨩">

## 다운로드 — v0.8.0

| 환경 | 다운로드 | 안내 |
|---|---|---|
| macOS · Apple Silicon | [Mac ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-macOS-arm64.zip) | Developer ID 서명·Apple 공증 완료 |
| Windows · x64 | [설치 프로그램](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-windows-x64-Setup.exe) | 미서명 |
| Windows · x64 | [압축판 ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-for-Codex-0.8.0-windows-x64.zip) | 설치 없이 압축 해제 후 실행 |

[릴리즈 안내](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.0) · [파일 확인용 SHA-256](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/SHA256SUMS.txt)

앱 실행에는 별도 Node.js, Python, ComfyUI 또는 수동 서버 설치가 필요하지 않습니다. **로컬 캐릭터챗은 앱에서 E4B 또는 12B 모델을 별도로 설치해야 합니다.** 작업 상태 표시와 기존 클릭 반응에는 모델이 필요하지 않습니다. Windows 배포 파일은 설치형·압축판 모두 미서명입니다.

## 빠르게 시작하기

1. 운영체제에 맞는 앱을 다운로드합니다.
   - **Mac:** ZIP을 풀고 `Daemonlet for Codex.app`을 응용 프로그램 폴더로 옮깁니다.
   - **Windows:** 설치 프로그램을 실행합니다. ZIP판은 폴더 전체를 압축 해제합니다.
2. **Daemonlet for Codex**를 실행합니다. 기본 캐릭터 지피쨩이 표시됩니다.
3. 원하는 기능을 선택합니다.
   - **로컬 대화:** 캐릭터 우클릭 또는 메뉴바·트레이에서 **캐릭터챗 · 로컬**을 열고 모델을 설치한 뒤 질문합니다. Codex 로그인이나 부모 대화 선택은 필요하지 않습니다.
   - **작업 상태 표시:** 같은 사용자 계정의 **Codex 데스크톱 앱**에서 작업을 시작합니다.

**데스크톱 연결에는 CLI Hook 설치가 필요하지 않습니다.**

자세한 설치·복구·제거 방법: [Mac 안내](docs/install-macos.md) · [Windows 안내](docs/install-windows.md)

## 주요 기능

- **로컬 캐릭터챗:** 캐릭터 옆 말풍선에서 대화하며 답변 스트리밍·중단·다시 답하기를 지원합니다.
- **대화 관리:** 캐릭터별 대화 저장·재개·삭제와 사용자가 명시적으로 저장한 기억 관리를 지원합니다.
- **대화 포즈·모션:** 팩의 감정·제스처 설정에 맞춰 반응하고 다음 대화 전까지 마지막 답변 자세를 유지합니다.
- **작업 상태 표시:** Codex 작업에 맞춰 포즈와 작업 말풍선이 바뀝니다.
- **캐릭터와 상호작용:** 머리·몸통 클릭과 쓰다듬기를 지원합니다.
- **표시 설정:** 캐릭터의 크기·위치와 말풍선 표시를 조절할 수 있습니다.
- **캐릭터 추가:** 외부 `.petchar` 팩을 가져와 사용할 수 있습니다.
- **로딩 안내:** 캐릭터 가져오기와 앱 시작 시 준비 상태를 표시합니다.
- **Mac 음성 입력:** 한국어·영어 받아쓰기로 Codex에 보낼 문장을 입력할 수 있습니다.

**v0.7.1부터** **설정 → 언어 / Language** 또는 트레이 메뉴에서 한국어·영어를 선택할 수 있습니다. 선택은 저장되며 모든 앱 창에 즉시 적용됩니다. Mac 받아쓰기는 다음 녹음부터 선택 언어를 사용하고, 작성 중인 문장은 보존합니다. 캐릭터 이름과 대사는 팩의 원문을 유지하며, macOS 권한 창은 시스템 언어 설정을 따릅니다. Windows 받아쓰기는 지원하지 않습니다.

## 로컬 캐릭터챗 — v0.8.0

캐릭터 우클릭 또는 메뉴바·트레이의 **캐릭터챗 · 로컬**을 선택하세요. 캐릭터 옆에 메신저 형태의 말풍선이 열립니다.

1. 처음 사용할 때 **Gemma 4 E4B / 12B** 중 하나를 선택해 설치합니다. 다운로드·이어받기·중단·파일 검증을 지원하며, 정확히 일치하는 공식 GGUF 파일을 직접 가져올 수도 있습니다. 모델은 자동으로 다운로드하지 않습니다.
2. 메시지를 보내면 대사가 스트리밍으로 표시됩니다. 생성 중 중단 버튼으로 멈추고 다음 질문을 보낼 수 있습니다.
3. 상단 **···** 메뉴에서 새 대화, 저장된 대화, 다시 답하기, 대화 삭제, 모델과 기억을 관리합니다. 빈 새 대화는 첫 메시지를 보낼 때 저장됩니다.
4. 말풍선 상단을 끌어 위치를 옮기고 오른쪽 아래 손잡이로 크기를 조절합니다. 위치와 크기는 재실행 후에도 유지됩니다.

모델 설치 후 **대사 생성은 로컬에서 실행**됩니다. 유료 외부 평가·채팅 API를 사용하지 않으며, 파일 수정·셸·MCP 도구 실행 권한을 제공하지 않습니다. 현재는 텍스트 대화이며 TTS는 포함하지 않습니다.

| 실행 환경 | 로컬 캐릭터챗 경로 |
|---|---|
| Mac · Apple Silicon | Metal |
| Windows · x64 + NVIDIA GPU | CUDA |

두 플랫폼에서 E4B·12B 런타임의 연속 대화·중단·복구를 확인했고, Mac 앱과 Windows 포터블 앱에서 대표 UI 검증을 수행했습니다. Windows 설치형 실행은 사용자 확인을 받았습니다. **최소 메모리·VRAM 사양은 확정하지 않았으며**, Intel Mac이나 Windows AMD/Intel GPU를 검증된 경로로 안내하지 않습니다. 자세한 검증 범위는 [0.8.0 릴리스 안내](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.8.0)를 확인하세요.

캐릭터의 대화 이름·말투·감정 포즈는 팩의 선언을 사용합니다. 대화 설정이 없는 기존 팩도 기본 자세로 대화할 수 있습니다. 빠른 응답에서는 준비 포즈를 생략하고, 답변 후 자세는 다음 요청 전까지 유지합니다. 새 대화·중단·오류·캐릭터 또는 모델 변경 시에는 해당 상태를 해제합니다.

[상세 사용법·모델·저장 방식](docs/local-character-chat.md) · [Windows 런타임 안내](docs/windows-character-chat.md)

## 데스크톱 조작

작업 말풍선과 로컬 캐릭터챗 말풍선은 각각 위치를 조절합니다.

- **캐릭터 이동:** Mac은 Option, Windows는 Alt를 누른 채 캐릭터의 불투명 부분을 왼쪽 드래그합니다. 놓으면 저장하고 Esc는 시작 위치로 돌아갑니다. 일반 클릭·쓰다듬기와 기존 이동·크기 조절 메뉴는 그대로입니다.
- **말풍선 위치:** 메뉴 또는 설정 → 캐릭터·표시 → 말풍선 위치에서 자동·위치 조절·위치 초기화를 선택합니다. 고정 문구 미리보기의 손잡이를 옮긴 뒤 적용합니다. 취소/Esc는 저장하지 않습니다. 위치 초기화는 말풍선만 자동 배치로 돌립니다.
- **상주:** 메뉴바·트레이에서 캐릭터 표시, 대화, 설정, 종료에 접근합니다. 일반 창을 닫아도 앱은 상주합니다. 아이콘을 만들지 못하면 설정 창과 Dock/작업표시줄 경로를 복구합니다. OS의 숨김 아이콘 영역은 직접 확인해야 할 수 있습니다.
- 숨긴 캐릭터에서 **캐릭터와 대화**를 선택하면 표시·위치를 복원합니다. 저장된 대화 OFF는 유지하며 켜기 안내를 표시합니다. 메뉴를 여는 것만으로 질문을 전송하지 않습니다.

## 캐릭터 추가하기

기본 앱에는 **지피쨩 하나**가 포함됩니다.

1. **설정 → 캐릭터·표시 → 캐릭터 추가**를 엽니다.
2. 준비한 `.petchar` 파일을 선택합니다.
3. 파일·동작 검사가 끝나면 추가된 캐릭터를 선택합니다.

추가 캐릭터와 설정은 앱 설치 폴더와 별도로 저장됩니다.

| 환경 | 사용자 데이터 위치 |
|---|---|
| Mac | `~/Library/Application Support/Daemonlet for Codex` |
| Windows | `%APPDATA%\Daemonlet for Codex` |

큰 팩이나 포즈가 많은 캐릭터는 준비에 시간이 걸릴 수 있습니다. 백업·삭제·초기화 방법은 [개인정보 및 로컬 데이터 안내](PRIVACY.md)를 확인하세요.

## Codex CLI 연결 — 선택 사항

터미널에서 사용하는 Codex CLI의 작업 이벤트도 받으려면 Hook을 설정합니다.

1. Daemonlet의 **설정 → Codex 연결 → CLI Hook 설정**을 엽니다. 이미 설치했다면 버튼은 **Hook 확인**으로 표시됩니다.
2. 설치 또는 수리 미리보기를 확인하고 적용합니다.
3. Codex CLI에서 `/hooks`를 열어 Daemonlet Hook을 검토하고 신뢰합니다.
4. 새 작업을 실행해 Daemonlet의 이벤트 수신을 확인합니다.

Windows는 **CMD와 PowerShell**을 지원합니다. Hook 실행에 별도 Node.js 설치는 필요하지 않습니다.

> **CLI 단독 사용에는 제한이 있습니다.**
> Codex 데스크톱 앱을 종료하고 CLI만 사용하면 일부 포즈 전환이나 작업 표시가 정상 동작하지 않을 수 있습니다. Codex 데스크톱 앱을 함께 실행해 주세요.

앱은 Hook 신뢰를 대신 승인하지 않습니다. 앱 위치를 변경했다면 설정에서 수리 미리보기를 확인하세요.

## 문제 해결과 제보

연결이나 캐릭터 표시 문제가 있다면 먼저 운영체제별 안내의 **연결 복구와 제거** 항목을 확인하세요.

- [Mac 설치·권한·연결 안내](docs/install-macos.md)
- [Windows 설치·Hook·연결 안내](docs/install-windows.md)
- [개인정보·저장 위치·삭제 안내](PRIVACY.md)

[버그 제보](https://github.com/ddol2ya/DAEMONLET/issues)에는 앱 버전, 운영체제, 재현 순서와 개인정보를 가린 화면을 첨부해 주세요. 계정 토큰, 원본 대화 또는 전체 Codex 설정은 올리지 마세요.

## Codex 작업에 질문하기 — Side Chat

로컬 캐릭터챗과 별도로, 기존 작업창의 **캐릭터에게 물어보기**로 같은 창에서 질문하고 답변을 확인합니다. 우클릭·트레이의 **캐릭터와 대화**도 이 작업창을 엽니다. 새 설치는 기본 ON이며 기존 사용자의 OFF 선택은 보존합니다. 공식 CLI·로그인 준비를 확인하고 부모 대화를 직접 선택한 뒤 질문합니다. 첫 보내기에서 맥락·선택 파일 전달과 사용량에 동의하며, 보내기 전 모델 생성은 없습니다. 화면 적용에 성공한 기존 캐릭터팩의 페르소나를 사용합니다.

**공식 CLI 0.154.0 · macOS Apple Silicon · gpt-5.6-luna** 경로를 검증합니다. 같은 Codex Home의 별도 임시 자식이 부모의 성공 완료 맥락과 선택한 프로젝트 파일을 설명하고 수정안을 제시합니다. 파일 변경·명령·빌드·테스트·외부 서비스·부모 제어는 차단합니다. 펼치기·복사·숨기기는 추가 모델 호출 없이 같은 원문을 사용합니다.

이 기능은 v0.7.2부터 포함됩니다. [사용법·준비·복구·플랫폼별 호환성](docs/side-chat.md)을 확인하세요. 앱의 대화·초안은 메모리에 보관하며 Codex의 정상 내부 저장·로그·인증 처리는 발생할 수 있습니다.

## 앱 업데이트

메뉴 또는 설정 → 업데이트에서 새 버전을 확인합니다. 자동 확인은 기본 OFF이며 다운로드·재시작은 사용자 선택입니다. 기존 공개 0.7.1에서는 최초 한 번 수동 설치가 필요합니다. [지원 설치 형태·서명 조건·검증 절차](docs/app-updates.md)를 확인해 주세요.

## 캐릭터팩 업데이트

[공개 캐릭터팩](https://huggingface.co/datasets/ddol2/daemonlet-character-packs)의 `.petchar` 파일을 가져오면 설정에서 새 팩을 확인·다운로드·검증하고 직접 적용하거나 이전 버전으로 복원할 수 있습니다. 아스마 토키 v3·v4·v5는 서로 다른 외형이며 각각 독립적으로 갱신합니다. 업데이트 출처가 없는 기존 팩은 출처를 포함한 팩을 한 번 가져와야 합니다. [업데이트·취소·복원 안내](docs/character-pack-updates.md)를 확인하세요.

## 캐릭터 제작과 개발

[**캐릭터 제작 스킬 0.8.0 ZIP 다운로드**](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.8.0/Daemonlet-creator-skill-0.8.0.zip) — 제작 지침과 독립 실행용 런타임 소스를 함께 포함합니다.

확인된 감정·제스처 의미 정보를 팩 내보내기에 자동 포함하고, `upgrade-chat`으로 기존 팩의 시각 자산을 유지한 대화 설정 후보를 만들 수 있습니다. [캐릭터챗 제작 지침](skills/create-pet-character/references/character-chat.md)을 참고하세요.

캐릭터 제작 도구는 **실험 기능**이며 일반 앱 배포 파일에 포함되지 않습니다. ComfyUI·See-through·모델은 사용자가 별도로 준비합니다.

- [캐릭터 제작 스킬](skills/create-pet-character/SKILL.md)
- [제작 환경 설치](docs/creator-setup.md)
- [캐릭터 제작 과정](docs/character-production-workflow.md)
- [캐릭터 팩 규격](docs/character-pack-format.md)
- [소스 빌드·배포 안내](docs/releasing.md)

<details>
<summary>소스에서 실행하기</summary>

소스 빌드는 Git checkout에서 실행하며 **Node 24**를 검증 기준으로 사용합니다. 선언된 최소 버전은 22.13.0입니다.

macOS에서는 음성 입력 helper 컴파일에 Xcode Command Line Tools가 필요합니다. Windows 소스 빌드에는 Visual Studio C++ 빌드 도구가 필요합니다.

```sh
npm ci
npm run electron:install
npm run electron:dev
```

검사와 프로덕션 빌드:

```sh
npm run typecheck
npm test
npm run build:renderer
npm run build:electron:production
npm run electron:package
```

캐릭터챗까지 실행하거나 앱을 패키징하려면 [런타임과 빌드](docs/local-character-chat.md#런타임과-빌드)에 따라 해당 플랫폼의 고정 런타임을 준비하고 `scripts/stage-chat-runtime.mjs`로 배치해야 합니다. 위 명령은 모델이나 런타임을 자동 설치하지 않습니다.

Electron 준비에는 lockfile에 고정된 로컬 설치 스크립트를 사용합니다. 소스에서 직접 빌드한 앱에는 배포본의 서명·공증이 자동 적용되지 않습니다.

</details>

## 라이선스와 출처

프로젝트 코드는 [MIT](LICENSE)입니다. 지정된 지피쨩 시각 파일에 대한 **제공자가 허락할 권한이 있는 프로젝트 추가 기여**와 별도로 승인된 아이콘에는 [CC BY 4.0](distribution/ARTWORK-LICENSE.md)을 적용하며, 그 권리 범위에서 출처·라이선스·변경 표시 조건으로 수정·재배포·상업적 이용을 허용합니다. 참고한 커뮤니티 캐릭터 디자인·이미지·시트의 이용 조건은 **미확인**이며 이 허락에 포함되지 않습니다. 이미지 전체의 이용 허락이 확보됐다는 뜻은 아닙니다. [파일 및 권리 범위](distribution/ARTWORK-SCOPE.json) · [모음글과 출처 정정](distribution/ARTWORK-NOTICE.md) · [CC BY 전문](distribution/licenses/CC-BY-4.0.txt)을 확인하세요. 외부 코드·upstream 자산·모델·다른 캐릭터 팩은 [각자의 조건](THIRD_PARTY_NOTICES.md)을 따릅니다. `.petchar` 전체가 하나의 자산 라이선스로 바뀌는 것은 아닙니다.

위 링크는 소스 저장소 경로입니다. 설치된 앱의 고지는 Windows/Linux `resources/licenses/`, macOS 앱 패키지의 `Contents/Resources/licenses/`에 있으며 ASAR를 열지 않고 읽을 수 있습니다. 기존 MIT의 `Momo Motion Lab contributors` 표기는 권리자 변경 근거가 없어 보존합니다.

작업 말풍선은 연결된 Codex 계정의 5시간·주간 **사용률**을 표시합니다. 미제공 구간은 `—`로,
오래된 값과 사용 제한은 별도로 표시하며, 메뉴에서 새로고침할 수 있습니다. 표시 중 기본 60초
간격으로 공식 계정 메타데이터를 조회하며 모델 호출·대화 생성은 하지 않습니다. 설정의
**Codex 사용량 표시**에서 끌 수 있습니다. [동작·개인정보·검증 범위](docs/codex-usage-display.md).
