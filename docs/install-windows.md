# Windows

1. Releases에서 받은 `Daemonlet-for-Codex-<version>-windows-x64-Setup.exe`를 실행합니다.
2. 현재 사용자 계정에 설치한 후 시작 메뉴의 **Daemonlet for Codex**를 실행합니다.
3. 같은 Windows 계정에서 Codex Desktop을 실행합니다. **Hook 설치는 필요 없습니다.** 앱 설정의 Codex 연결에서 상태를 확인합니다.

ZIP판은 폴더 전체를 압축 해제하고 `Daemonlet for Codex/Daemonlet for Codex.exe`를 실행합니다. EXE만 옮기지 마세요. Windows 서명 여부는 해당 릴리스 설명을 확인합니다. 미서명 빌드는 알 수 없는 게시자로 표시될 수 있습니다.

기본 캐릭터는 지피쨩 하나입니다. 추가 팩은 설정 → 캐릭터·표시 → 캐릭터 추가에서 `.petchar`를 가져옵니다.
사용자 데이터는 `%APPDATA%/Daemonlet for Codex`에 저장합니다. 삭제 시 추가 캐릭터·설정은 보존하며, Windows 설정의 설치된 앱에서 제거할 수 있습니다.


## 연결 복구와 제거

- 연결이 끊기면 같은 Windows 계정의 Codex Desktop 실행을 확인하고 **Settings → Codex 연결 → 새로 확인**을 누릅니다. 연결 서비스가 준비되지 않았고 앱이 소유한 서비스라면 **연결 다시 시작**을 사용합니다. Codex 업데이트 후에는 두 앱을 종료·재실행하고 상태를 확인하세요.
- 캐릭터가 안 보이면 트레이의 **Show Pet**, **Reset Position**을 사용하고 **Click-through → Disabled**를 선택합니다. 설정에서 기본 지피쨩 선택과 크기도 확인합니다.
- 설치 EXE판의 일반 제거: 트레이 **Quit** 후 Windows 설정 → 설치된 앱에서 제거합니다. 설치 프로그램은 `deleteAppDataOnUninstall: false`로 생성되므로 추가 팩과 설정을 보존하도록 구성됩니다. 후보별 실제 제거 검증 결과는 별도 검증 기록을 확인하세요.
- ZIP판은 종료 후 압축 해제한 앱 폴더를 삭제합니다. 설정·추가 팩은 별도 사용자 데이터 폴더에 남습니다.
- **선택적 완전 초기화:** 추가 팩을 백업하고 앱·관련 프로세스가 종료된 상태에서 `%APPDATA%/Daemonlet for Codex`만 직접 삭제합니다. 다시 실행하면 새 프로필이 만들어집니다. Codex의 데이터 폴더나 다른 앱의 Hook·설정은 삭제하지 않습니다.

[개인정보·로컬 데이터·진단 가림 안내](../PRIVACY.md)
