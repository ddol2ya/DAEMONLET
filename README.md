# Daemonlet for Codex

Codex 작업 상태에 반응하는 데스크톱 캐릭터 앱입니다. 저장소 이름은 **DAEMONLET**, 앱 이름은 **Daemonlet for Codex**입니다. OpenAI의 공식 제품이나 제휴 제품이 아닙니다.

기본 캐릭터는 OpenAI 이미지 생성으로 제작한 가상 캐릭터 **지피쨩 하나**입니다. 다른 캐릭터는 `.petchar` 팩으로 추가할 수 있습니다. 작업 상태별 포즈·말풍선, 머리/몸통 클릭, 쓰다듬기, 크기·위치 조절을 지원합니다.

<img src="docs/images/gpichan.png" width="360" alt="Gpichan running in Daemonlet for Codex">

## 앱 사용

- **Windows x64:** 설치 EXE 또는 압축판. 같은 Windows 계정에서 Codex Desktop을 실행하면 Hook 설치 없이 연결됩니다. [설치 안내](docs/install-windows.md)
- **Apple Silicon Mac:** 앱을 응용 프로그램 폴더로 옮긴 뒤 Codex 연결 메뉴에서 Hook 설치와 Codex의 실행 허용을 진행합니다. [설치 안내](docs/install-macos.md)
- 사용 가능한 실행 파일은 [Releases](https://github.com/ddol2ya/DAEMONLET/releases)에 게시합니다. 서명·공증 여부는 각 릴리스 설명을 확인하세요. 소스를 빌드했다는 것만으로 서명이나 공증이 적용되지는 않습니다.

앱 사용에는 ComfyUI, 모델 가중치 또는 제작용 NVIDIA GPU가 필요하지 않습니다. 앱은 기존 2D Live/Test 설치와 별도 이름·앱 ID·사용자 데이터 경로를 사용합니다.

## 캐릭터 제작 — 실험 기능

[create-pet-character 스킬](skills/create-pet-character/SKILL.md)은 레퍼런스 확인, 포즈 제작, See-through 분해, 리깅·표정 검수와 `.petchar` 출력을 안내하고 자체 제작 도구를 실행합니다. 레퍼런스가 없으면 사용 가능한 이미지 생성 도구로 기준 이미지를 만드는 단계부터 진행합니다.

**ComfyUI·See-through·모델은 사용자가 별도로 설치합니다.** 스킬에는 이를 실행·검수하는 자체 도구를 제공합니다. [제작 환경 설치](docs/creator-setup.md)를 먼저 읽어주세요. 이미지 생성 이용 권한과 Node/Python 제작 환경도 필요합니다. 일반 앱 설치에 제작 도구가 포함되지는 않습니다.

원화별 기하 좌표와 마스크, 표정·접촉 검수에는 판단과 수정이 필요합니다. 모든 그림을 무인으로 완성하는 기능으로 보장하지 않습니다. 제작 최소 지원 목표는 RTX 3060 12GB + group offload, 기본 분해 1280px입니다. 8GB 이하는 비권장이며 시도할 경우 1024px 이하로 낮춥니다. 3060의 실측 성능 보증이나 Mac 로컬 See-through 지원 선언은 아닙니다.

## 소스에서 실행

Node.js 22.13 이상이 필요하며 Node 24에서 검증합니다.

```sh
npm ci
npm run electron:dev
```

```sh
npm run typecheck
npm test
npm run build:renderer
npm run build:electron:production
npm run electron:package
```

ComfyUI 없이 앱을 빌드할 수 있습니다. macOS 음성 입력 helper 빌드에는 Xcode Command Line Tools가 필요합니다. [배포 빌드](docs/releasing.md) · [캐릭터 팩 규격](docs/character-pack-format.md)

## 구성

`src/`, `electron/`, `adapter/`는 앱, `public/characters/gpichan/`은 기본 자산, `skills/`와 `scripts/characters/`는 제작 스킬과 자체 도구입니다. 스킬 배포 ZIP에는 필요한 제작 실행 코드를 함께 묶습니다. 외부 제작 엔진·가중치·개발 실험 기록은 포함하지 않습니다.

## 라이선스와 제보

프로젝트 코드는 [MIT](LICENSE)입니다. 지정된 지피쨩 시각 파일에 대한 **제공자가 허락할 권한이 있는 프로젝트 추가 기여**와 별도로 승인된 아이콘에는 [CC BY 4.0](distribution/ARTWORK-LICENSE.md)을 적용하며, 그 권리 범위에서 출처·라이선스·변경 표시 조건으로 수정·재배포·상업적 이용을 허용합니다. 참고한 커뮤니티 캐릭터 디자인·이미지·시트의 이용 조건은 **미확인**이며 이 허락에 포함되지 않습니다. 이미지 전체의 이용 허락이 확보됐다는 뜻은 아닙니다. [파일 및 권리 범위](distribution/ARTWORK-SCOPE.json) · [모음글과 출처 정정](distribution/ARTWORK-NOTICE.md) · [CC BY 전문](distribution/licenses/CC-BY-4.0.txt)을 확인하세요. 외부 코드·upstream 자산·모델·다른 캐릭터 팩은 [각자의 조건](THIRD_PARTY_NOTICES.md)을 따릅니다. `.petchar` 전체가 하나의 자산 라이선스로 바뀌는 것은 아닙니다.

위 링크는 소스 저장소 경로입니다. 설치된 앱의 고지는 Windows/Linux `resources/licenses/`, macOS 앱 패키지의 `Contents/Resources/licenses/`에 있으며 ASAR를 열지 않고 읽을 수 있습니다. 기존 MIT의 `Momo Motion Lab contributors` 표기는 권리자 변경 근거가 없어 보존합니다.

버그 제보에는 앱 버전, OS, 재현 순서와 개인 정보를 가린 화면을 첨부해 주세요. 계정 토큰, 원본 대화 또는 전체 Codex 설정을 올리지 마세요.
