# 개인정보와 로컬 데이터

이 문서는 현재 저장소 구현 기준입니다. Daemonlet은 Codex 작업 상태를 표시하고, 사용자가 선택한 작업에 후속 입력·중단·대화 열기를 요청하는 로컬 앱입니다. 작업 제목에는 질문 일부나 개인 정보가 포함될 수 있습니다. «대화 접근 없음»이나 «완전 오프라인»을 보장하지 않습니다.

## 읽는 정보와 메모리 처리

- 연결 준비는 선택한 Codex 실행 파일의 버전과 Codex Home의 `config.toml`, `hooks.json`, 접근 가능한 알려진 시스템 requirements를 확인합니다. 모든 프로젝트·플러그인·조직 정책을 조사하는 기능은 아닙니다. `config.toml`은 읽기 전용이며 Hook 변경은 앱의 미리보기·적용 절차를 거칩니다.
- macOS Hook forwarder는 Codex가 표준입력으로 보낸 JSON을 메모리에서 읽습니다. 원본에는 prompt, transcript 경로, 도구 입력·결과 등이 들어올 수 있습니다. 전송 전 허용 목록으로 좁혀 이벤트 이름, 세션·턴·도구·에이전트 식별자, 모델, 권한 모드, 종료 이유 등 상태 필드만 로컬 adapter로 보냅니다. 원본 prompt나 도구 결과를 그대로 전달·저장하는 경로는 아닙니다.
- 상태 관찰기는 Codex Home의 `sessions/` JSONL에서 제한된 생명주기 정보를 읽습니다. 파일을 읽는 동안 대화 데이터가 담긴 원본 바이트도 메모리를 통과할 수 있지만 생명주기·상태 필드만 추출합니다. 기존 파일 전체 대화를 복제하는 기능은 아닙니다. CLI 관찰은 같은 사용자의 실행 프로세스와 열린 rollout 파일도 확인합니다.
- 대화 목록은 `state_*.sqlite`의 제한된 스레드 메타데이터와 `session_index.jsonl`의 제목을 읽습니다. ID, 제목, 작업 폴더, rollout 경로, 상태·시각이 처리됩니다. 제목은 질문에서 유래할 수 있습니다. Desktop IPC(Windows named pipe, 지원되는 로컬 Unix socket) 및 app-server 제어 연결에서도 상태·요청 정보가 들어오며 필요한 필드로 축소합니다.
- 후속 질문·음성 인식 텍스트는 입력창과 제어 연결의 메모리에서 처리합니다. **보내기**를 누르면 선택한 Codex 작업으로 전달되어 Codex의 처리·보존·사용량 정책을 따릅니다. 실행 중인 작업 중단도 사용자 동작으로 요청합니다.

## 통신 주체

앱의 Hook HTTP 수신과 상태 WebSocket은 loopback에 바인딩되고, Desktop 제어는 로컬 IPC를 사용합니다. packaged macOS 기본 포트는 4474/4475이며 개발 실행은 별도 포트, Windows 자동 연결은 실행 시 확보한 포트를 사용합니다. 현재 앱 코드에 프로젝트 운영자에게 원격 분석·대화·오류를 자동 업로드하는 서비스나 자동 업데이트 클라이언트는 없습니다. 진단은 사용자가 파일로 내보냅니다. 이 설명은 Electron/OS 자체 동작이나 사용자가 실행하는 Codex까지 일괄 보증하지 않습니다.

Codex 자체는 설정한 모델 제공자·서버와 통신합니다. Daemonlet에서 보낸 후속 입력도 Codex 요청을 발생시킬 수 있으므로 추가 요청·사용량·비용이 없다고 보장하지 않습니다. 별도 캐릭터 제작 도구는 사용자가 지정한 ComfyUI URL, 선택한 이미지 생성 서비스 및 의존성 다운로드 서버를 사용할 수 있습니다. 일반 앱 실행에서 제작 모델을 다운로드·추론하지 않습니다.

## 선택적 macOS 음성 입력

한국어 `SFSpeechRecognizer`와 마이크를 사용합니다. OS가 기기 내 인식을 지원한다고 보고하면 `requiresOnDeviceRecognition`을 켭니다. 지원하지 않으면 Apple 음성 인식 서비스를 사용할 수 있으므로 음성이 외부로 전송될 수 있습니다. 마이크·음성 인식 권한이 필요하고 거부 시 `PERMISSION_DENIED`로 중단됩니다. 사용자가 원할 때 macOS 시스템 설정의 개인정보 보호 및 보안에서 해당 권한을 확인하세요.

helper는 음성을 자체 파일로 녹음하지 않습니다. 부분·최종 텍스트를 부모 앱에 전달하며 녹음은 약 55초, 권한 대기·시작을 포함한 프로세스는 약 65초로 제한됩니다. 인식 결과가 자동으로 Codex에 전송되는 것은 아니며 입력창에서 확인 후 보냅니다. Apple 서비스의 보존 조건을 이 앱이 통제하지는 않습니다.

## 저장 위치와 보존

기본 사용자 데이터 폴더는 macOS `~/Library/Application Support/Daemonlet for Codex`, Windows `%APPDATA%/Daemonlet for Codex`입니다. 개발 실행은 `Daemonlet for Codex Dev`, 테스트는 별도 지정 프로필을 사용합니다. 사용자 지정 데이터·Codex Home 경로를 선택했다면 해당 위치도 확인하세요.

| 위치/종류 | 내용과 보존 |
| --- | --- |
| 앱 설정·창 위치 JSON | 선택 캐릭터, 크기, 표시·클릭 통과, 창 위치 등. 설정 변경 또는 직접 삭제까지 보존 |
| `codex-integration.json` 및 Hook 설치 기록·백업 | 선택 실행 파일·Codex Home 경로, 준비·검토 상태, 설치 영수증·복구 정보. 백업에는 다른 Hook의 원래 설정이 포함될 수 있으므로 공유 금지 |
| `characters/` | 가져온 `.petchar`의 로컬 자산·등록 정보. 앱에서 해당 추가 캐릭터 제거 또는 데이터 폴더 삭제까지 보존 |
| `adapter/` | 로컬 Hook 인증용 `adapter-token`, 상태 복구용 `adapter-state.json`(세션·턴·작업 ID, 분류·상태 등). 손상 상태의 격리 백업이 남을 수 있음. Codex 로그인 토큰과는 별개 |
| `activity/history.json` | 해시된 상관 키, 상태·분류, 시각, 확인 여부. 제목·원문을 저장하지 않는 제한된 스키마. 종료 이력은 최대 100개·7일, 활성 항목 최대 64개. 앱이 실행 중이거나 다시 읽을 때 정리하므로 종료 상태에서 즉시 만료 삭제되지는 않음 |
| Electron 프로필 파일 | Chromium 캐시·로컬 저장소 등 런타임 데이터. 완전 초기화 시 함께 삭제 |
| 사용자가 내보낸 진단·개발 `outputs/` | 사용자가 지정한 파일과 테스트 로그. 자동 전송되지 않으며 직접 삭제 필요 |

앱 제거만으로 Codex Home의 Hook 설정이나 별도로 내보낸 진단이 지워지지는 않습니다. 활동 기록의 확인 표시는 전체 사용자 데이터 삭제와 다릅니다. 전체 초기화는 먼저 앱을 종료하고 필요한 추가 팩을 백업한 뒤 **이 앱의 사용자 데이터 폴더만** 삭제합니다. Codex Home 전체나 다른 앱 폴더는 삭제하지 마세요. Mac Hook 제거 순서와 Windows 일반 제거/완전 초기화는 [Mac 안내](docs/install-macos.md) · [Windows 안내](docs/install-windows.md)를 따릅니다.

## 진단 공유

설정의 진단 내보내기는 경로를 대체하고 이벤트 이름·횟수·시각, 단계별 상태를 중심으로 저장합니다. 사용자 보고한 Hook 검토·중단 여부는 자동 검증 증거가 아닙니다. 공유 전 화면의 대화 제목·질문, 사용자명, 홈·프로젝트 경로, IP/호스트명, 세션·턴 ID, Hook command, token, 인증 파일, 원본 transcript와 Hook 백업을 가리세요. 원본 Codex 설정·전체 로그를 공개 이슈에 올리지 마세요.

구현 근거: `adapter/codex/hooks/hook-forwarder.mjs`, `adapter/codex/lifecycle/CodexLifecycleObserver.ts`, `electron/main/control/DesktopThreadCatalog.ts`, `electron/main/control/TaskControlService.ts`, `electron/main/activity/ActivityHistoryStore.ts`, `electron/main/SetupDiagnostics.ts`, `electron/native/Dictation.swift`.
