# Daemonlet for Codex

**한국어** · [English](README.en.md)

**Codex가 작업하는 동안, 데스크톱 캐릭터가 함께 반응합니다.**

작업 상태에 따라 포즈와 말풍선이 바뀌는 데스크톱 캐릭터 앱입니다. 기본 캐릭터 **지피쨩**과 함께 시작하고, 외부 `.petchar` 팩으로 다른 캐릭터를 추가할 수 있습니다.

OpenAI의 공식 제품이나 제휴 제품이 아닙니다.

<img src="docs/images/gpichan.png" width="360" alt="Daemonlet for Codex에서 실행 중인 지피쨩">

## 다운로드 — v0.7.1

| 환경 | 다운로드 | 안내 |
|---|---|---|
| macOS · Apple Silicon | [Mac ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.7.1/Daemonlet-for-Codex-0.7.1-macOS-arm64.zip) | Developer ID 서명·Apple 공증 완료 |
| Windows · x64 | [설치 프로그램](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.7.1/Daemonlet-for-Codex-0.7.1-windows-x64-Setup.exe) | 미서명 |
| Windows · x64 | [압축판 ZIP](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.7.1/Daemonlet-for-Codex-0.7.1-windows-x64.zip) | 설치 없이 압축 해제 후 실행 |

[릴리즈 안내](https://github.com/ddol2ya/DAEMONLET/releases/tag/v0.7.1) · [파일 확인용 SHA-256](https://github.com/ddol2ya/DAEMONLET/releases/download/v0.7.1/SHA256SUMS.txt)

앱 사용에는 별도 Node.js, Python, ComfyUI, 모델 가중치 또는 제작용 GPU가 필요하지 않습니다.

## 빠르게 시작하기

1. 운영체제에 맞는 앱을 다운로드합니다.
   - **Mac:** ZIP을 풀고 `Daemonlet for Codex.app`을 응용 프로그램 폴더로 옮깁니다.
   - **Windows:** 설치 프로그램을 실행합니다. ZIP판은 폴더 전체를 압축 해제합니다.
2. 같은 사용자 계정에서 **Codex 데스크톱 앱**과 **Daemonlet for Codex**를 실행합니다.
3. Codex에서 작업을 시작하고 캐릭터의 포즈와 작업 말풍선을 확인합니다.

**데스크톱 연결에는 CLI Hook 설치가 필요하지 않습니다.**

자세한 설치·복구·제거 방법: [Mac 안내](docs/install-macos.md) · [Windows 안내](docs/install-windows.md)

## 주요 기능

- **작업 상태 표시:** Codex 작업에 맞춰 포즈와 작업 말풍선이 바뀝니다.
- **캐릭터와 상호작용:** 머리·몸통 클릭과 쓰다듬기를 지원합니다.
- **표시 설정:** 캐릭터의 크기·위치와 말풍선 표시를 조절할 수 있습니다.
- **캐릭터 추가:** 외부 `.petchar` 팩을 가져와 사용할 수 있습니다.
- **로딩 안내:** 캐릭터 가져오기와 앱 시작 시 준비 상태를 표시합니다.
- **Mac 음성 입력:** 한국어·영어 받아쓰기로 Codex에 보낼 문장을 입력할 수 있습니다.

**v0.7.1부터** **설정 → 언어 / Language** 또는 트레이 메뉴에서 한국어·영어를 선택할 수 있습니다. 선택은 저장되며 모든 앱 창에 즉시 적용됩니다. Mac 받아쓰기는 다음 녹음부터 선택 언어를 사용하고, 작성 중인 문장은 보존합니다. 캐릭터 이름과 대사는 팩의 원문을 유지하며, macOS 권한 창은 시스템 언어 설정을 따릅니다. Windows 받아쓰기는 지원하지 않습니다.

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

## 캐릭터 제작과 개발

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

Electron 준비에는 lockfile에 고정된 로컬 설치 스크립트를 사용합니다. 소스에서 직접 빌드한 앱에는 배포본의 서명·공증이 자동 적용되지 않습니다.

</details>

## 라이선스와 출처

프로젝트 코드는 [MIT](LICENSE)입니다. 지정된 지피쨩 시각 파일에 대한 **제공자가 허락할 권한이 있는 프로젝트 추가 기여**와 별도로 승인된 아이콘에는 [CC BY 4.0](distribution/ARTWORK-LICENSE.md)을 적용하며, 그 권리 범위에서 출처·라이선스·변경 표시 조건으로 수정·재배포·상업적 이용을 허용합니다. 참고한 커뮤니티 캐릭터 디자인·이미지·시트의 이용 조건은 **미확인**이며 이 허락에 포함되지 않습니다. 이미지 전체의 이용 허락이 확보됐다는 뜻은 아닙니다. [파일 및 권리 범위](distribution/ARTWORK-SCOPE.json) · [모음글과 출처 정정](distribution/ARTWORK-NOTICE.md) · [CC BY 전문](distribution/licenses/CC-BY-4.0.txt)을 확인하세요. 외부 코드·upstream 자산·모델·다른 캐릭터 팩은 [각자의 조건](THIRD_PARTY_NOTICES.md)을 따릅니다. `.petchar` 전체가 하나의 자산 라이선스로 바뀌는 것은 아닙니다.

위 링크는 소스 저장소 경로입니다. 설치된 앱의 고지는 Windows/Linux `resources/licenses/`, macOS 앱 패키지의 `Contents/Resources/licenses/`에 있으며 ASAR를 열지 않고 읽을 수 있습니다. 기존 MIT의 `Momo Motion Lab contributors` 표기는 권리자 변경 근거가 없어 보존합니다.

### 캐릭터 사이드 대화 (실험, 기본 OFF)

설정 → 캐릭터·표시에서 실험 옵션을 켜면 우클릭·트레이의 **캐릭터와 대화**로 전용 창을 열 수 있습니다. 선택한 로컬 Codex 대화를 맥락으로 사용하고, 실제 화면 적용에 성공한 캐릭터팩의 페르소나를 자동 적용합니다. 프로젝트별 캐릭터 지정은 없습니다. 소형 창에서 긴 답변을 펼쳐도 같은 원문과 임시 분기를 사용합니다.

**검증된 공식 CLI 0.154.0 · macOS arm64 · gpt-5.6-luna의 same-home 경로**를 사용합니다. 부모와 같은 Codex Home에서 별도 임시 자식을 만들며, 부모의 성공 완료 맥락과 사용자가 선택한 프로젝트 파일을 읽어 설명·수정안을 제시할 수 있습니다. 파일 변경·명령·빌드·테스트·외부 서비스·부모 제어는 차단합니다. 자동 파일 검색은 제공하지 않습니다. [새 지원·검증 기록](docs/side-chat-official-readonly.md)에서 합성 시험, 실제 부모 준비와 실계정 결과를 구분해 확인하세요.

설정은 기본 OFF입니다. 부모 맥락과 선택 파일은 모델 제공자로 전송될 수 있고 사용량이 발생합니다. 앱의 대화·초안은 메모리에 보관하지만 Codex의 정상 저장소·로그·인증 처리는 발생할 수 있습니다. 숨기기는 대화를 유지하고, 새 대화·캐릭터 적용·언어 전환은 새 자식을 사용합니다. 기존 custom 선택은 공식 CLI를 다시 선택해야 하며 자동 대체하지 않습니다. 다른 OS·CLI 버전, 관리 정책 및 Keychain 전용 인증은 별도 검증이 필요합니다.
