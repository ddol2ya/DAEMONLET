# 로컬 캐릭터챗

메뉴바/캐릭터 우클릭 메뉴의 **캐릭터챗 · 로컬**을 선택하면 데스크톱 캐릭터 옆에 입력 가능한 말풍선이 열린다. 별도의 캐릭터 미리보기 창은 사용하지 않는다. Codex 부모 대화·로그인·작업 권한 없이 로컬 모델로 생성한다. 기본 화면 상단에는 캐릭터 이름만 표시하고, 본문은 좌우 메시지와 입력칸으로 구성한다. 영문 라벨·대화 제목 접미사·반복 안내는 표시하지 않는다. 말풍선의 `···` 메뉴에서 다시 답하기·캐릭터팩·모델·저장된 대화·명시적 기억을 관리한다. 생성 중에는 점 표시와 중단 아이콘으로 상태를 알린다.

말풍선 상단을 끌어서 위치를 옮기고 오른쪽 아래 손잡이를 끌어 크기를 조절한다. 조절한 크기와 캐릭터 기준 상대 위치를 로컬에 저장하여 재실행 시 복원한다. 캐릭터 이동 시 정해 둔 간격을 따라가고 화면 밖으로 나가면 표시 위치만 화면 안으로 조정한다. `···` 메뉴의 **말풍선 위치·크기 초기화**로 자동 배치와 기본 크기(410×500)로 돌아간다. 최소 크기는 350×360, 최대 크기는 1200×1200이다.

Gemma 4 E4B 또는 12B의 고정 공식 QAT Q4_0 GGUF를 하나씩 선택한다. 다운로드는 버튼을 눌렀을 때만 시작하며, 이어받기/중단/파일 검증을 지원한다. 이미 보유한 정확한 GGUF도 가져올 수 있다. 모델 최초 설치 이후 생성은 오프라인이다. 중단은 앱 소유 서버를 종료하여 실제 작업까지 끊고, 다음 요청에서 다시 준비한다. 다른 서버나 Codex 작업을 종료하지 않는다.

대화는 앱 데이터의 `character-chat`에 캐릭터별로 저장된다. 대화창 미사용 종료는 기존 대화·기억·위치를 덮어쓰지 않는다. 캐릭터 전환과 저장 실패 시 이전 소유권·저장 상태를 보존하며, 저장 한도 뒤에도 대화 삭제가 가능하다. 새 대화·재시도·삭제를 지원한다. 삭제한 대화의 요약도 제거하고, 별도로 사용자가 저장한 기억은 유지된다고 메뉴에 표시한다. 명시적 기억은 확인·수정·삭제할 수 있다. 원작 설정과 예문은 사용자와 실제로 나눈 기억이 아니다. 오래된 대화는 제한된 사용자 발언 발췌와 최근 완결 턴으로 구성하고 실제 tokenizer로 8192 context 안에 512 출력 + 256 예약이 들어가는지 검사한다. 의미 분석용 추가 모델 요청은 없다.

## 공통 팩 의미

`character.json.chat`가 가리키는 `chat.json.presentation`이 포즈 의미의 유일한 기준이다. 앱과 모델은 특정 캐릭터/포즈 이름을 모르며, 모델은 text/emotion/intent/gesture/intensity만 출력한다. phase는 앱이 결정한다. JSON text만 스트리밍하고 검증된 metadata만 연출한다. 완결 JSON의 대사가 유효하고 감정 정보만 잘못된 경우 대사는 이력에 보존하고 낮은 강도의 중립 연출과 진단을 사용한다. 태그/추론이 유출되면 오류로 중단한다.

replying에서 emotion+intent → emotion → neutral의 intent → phase 기본 → 팩 기본/정상 기본 모델 순으로 고른다. 조건은 AND, 강도는 양 끝 포함이며 동률 priority/weight와 즉시 반복 억제를 적용한다. 비중립 감정이 무관한 설명/축하 포즈로 떨어지지 않는다. 임의 pose ID와 여러 변형이 가능하다. 없음/무효 optional 의미는 기본 자세로 저하하되 core ZIP/path/hash/필수 자산 검증은 우회하지 않는다. 구버전 앱은 새 capability를 거부하여 업데이트가 필요함을 알린다.

대화 중에는 같은 데스크톱 renderer의 작업/터치 연출 소유권을 분리한다. chat-safe는 기존 이미지/리그를 사용하며 기존 pose motion·작업 완료·고정 대사를 실행하지 않는다. pose-approved도 시각 모션만 허용한다. 작은 고개/시선 제스처는 제한된 preset이고 지원 리그가 없으면 생략한다. 답변 준비 포즈는 800ms 뒤에도 첫 대사가 없을 때만 표시한다. 표시를 시작한 준비 포즈는 실제 진입 완료 후 최소 900ms 유지하고, 검증된 답변 포즈로 직접 전환한다. 이 유지시간은 대사 스트리밍을 지연하지 않는다. 마지막 답변의 의미와 포즈는 다음 요청 전까지 유지하며, 입력칸 focus/blur와 시간 경과로 초기화하지 않는다. 중단·오류·새 대화·캐릭터/모델/모드 변경 시에는 유지 상태와 지연 전환을 즉시 폐기한다. 캐릭터/모델/대화 변경과 취소는 epoch와 pack revision으로 옛 대사·모션을 무효화한다.

제작 경로는 [제작 도구의 대화 의미 지침](../skills/create-pet-character/references/character-chat.md)을 따른다. payload/export가 확인된 제작 의도를 자동 포함하고 기존 검수 규칙을 보존한다. legacy 팩은 chat/persona가 없어도 기본 모델과 중립 persona로 대화한다.

## 런타임과 빌드

현재 실측 대상은 Apple Silicon/Metal이다. Windows NVIDIA/CUDA의 배포 runtime과 실기 검증은 아직 제공하지 않는다. macOS 최소 OS/최소 메모리도 이 개발 호스트만으로 확정하지 않는다.

llama.cpp commit과 binary hash는 제품용 runtime catalog에 고정한다. 정적 Release/Metal 빌드로 Homebrew 동적 라이브러리 의존성을 제거한다. native runtime은 앱 resource에 포함하고 GGUF는 포함하지 않는다. 빌드하는 개발자는 고정 catalog와 일치하는 native binary 디렉터리를 한 번 stage한다:

```sh
node scripts/stage-chat-runtime.mjs /ABS/pinned-runtime-bin
npm run typecheck
npm test
npm run electron:package
```

이 stage 명령은 다운로드/기존 환경 갱신을 하지 않는다. 소스만 검사하는 CI 빌드는 native runtime 없이 가능하다. 실제 Forge 패키징은 지원 플랫폼과 catalog·파일 SHA를 확인하며, 일치하지 않거나 runtime이 없으면 거부한다. 사용자 앱에는 Python·Ollama·터미널·수동 서버 설치가 필요 없다. runtime은 loopback/auth token/slot 1/context 8192/output 512/thinking off/reasoning budget 0/checkpoint 1로 시작하고 실제 준비 로그를 확인한다. 파일/셸/MCP/agent 도구 권한을 제공하지 않는다.

모델 카탈로그에는 공식 revision·파일 크기·SHA-256만 둔다. 자료/이미지/개인 대화/모델 파일은 공개 Git에 두지 않는다. native/runtime 및 모델 고지는 `distribution/licenses/character-chat`에 있고 패키지의 runtime에도 포함된다. 특정 캐릭터 자산의 공개 배포 권리는 별도이며 이 기능 변경은 해당 권리를 부여하지 않는다.

대화창 이름은 팩의 `chat.json.profile.displayName`을 우선 사용하며, 없는 기존 팩은 관리용 팩 이름을 표시한다. 캐릭터 선택 목록은 버전을 구분할 수 있도록 팩 이름을 유지한다. 작업 말풍선과 Side Chat 입력 안내도 같은 대화 표시 이름을 사용한다.
