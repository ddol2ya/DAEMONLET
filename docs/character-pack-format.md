# 외부 캐릭터 팩 v1

외부 팩은 앱을 다시 빌드하지 않고 추가하는 캐릭터 데이터다. 설정 → 캐릭터·표시 →
캐릭터 추가에서 `.petchar` 또는 같은 형식의 `.zip`을 선택한다. 검증 후 이름·제작자
자기 기재·버전·포즈 수·설치 크기·호환성을 확인하고 설치한다. 새 설치는 선택을 바꾸지
않으며 **지금 적용**을 눌러 사용한다. 선택 중인 캐릭터의 업데이트는 준비 후 교체된다.

## 파일 구조와 계약

컨테이너는 ZIP이다. `pack.json`은 루트에 하나만 있어야 한다. 임의 PSD 자동 변환,
스크립트·플러그인·모델 가중치 실행을 제공하지 않는다. PSD는 현재 Anime2.5DRig가
소비하는 이름과 픽셀 레이어를 갖춘 모델이어야 한다.

```text
pack.json
character.json
behavior.json
dialogue.ko.json
thumbnail.png              (선택)
provenance.json             (선택)
LICENSE.txt                (선택)
poses/waiting/{source.png,model.psd,rig-overrides.json,pose.json}
poses/writing/...
poses/head-tap/...
```

| pack.json | 규칙 |
| --- | --- |
| `packFormatVersion` | `1` |
| `id` | 1–64자, 소문자 영문·숫자, 사이를 연결하는 하이픈. character.id와 동일 |
| `version` | v1은 `X.Y.Z` release SemVer만 허용. 각 성분 0–999999, 선행 0 금지. prerelease/build metadata 미지원 |
| `name` | character.label과 동일한 1–160자 일반 텍스트 |
| `author` | 선택적 1–160자 자기 기재. 인증·서명을 뜻하지 않음 |
| `entry` | `character.json` |
| `thumbnail` | 선택적 inventory 안 PNG/JPEG/WebP 경로 |
| `runtime` | 아래 앱 자체 계약 |
| `files` | manifest를 제외한 **모든** payload의 `{path, bytes, sha256}` 배열 |
| `profile` | 선택적 `trial` 또는 `full`. 생략하면 유효한 기본 모델과 존재하는 pose만 요구 |
| `unsupportedReactions` | 선택적 일반 텍스트 배열. 시험 팩의 미지원 반응 표시 |

```json
{
  "engine": "anime25d",
  "assetApiVersion": 1,
  "capabilities": [
    "independent-model", "semantic-layer-swap", "local-eye-blink",
    "mouth-morph", "head-follow"
  ]
}
```

사용하는 기능을 capabilities에 선언한다. 알 수 없는 engine/API/capability는 설치 전에
거부한다. 이는 앱이 정의한 계약이며 외부 표준이 아니다. 새 렌더링 기능에는 앱 업데이트가
필요하다. 현재 `minAppVersion` 필드는 없으며 버전 숫자로 기능 호환성을 추정하지 않는다.

앱 0.5.0부터 `pose-variants` capability를 지원한다. 같은 상태나 단발 반응에 기본
`poseId`와 추가 `poseVariants` 1–7개를 지정하면, 사용할 수 있는 포즈를 한 번씩 섞어서
선택한다. 같은 포즈를 연속 선택하지 않으며 클릭 중이나 포즈 로딩 중에는 다시 뽑지 않는다.
상태에 `poseVariantIntervalMs`를 5,000–300,000ms로 지정하면 완전히 표시된 뒤 그 시간만큼
유지하고 다음 포즈를 선택한다. 각 포즈는 자체 `pose.json`의 동작을 재생한다.

```json
{"poseId":"waiting","poseVariants":["waiting-clasp","waiting-wave"],"poseVariantIntervalMs":18000}
```

이 기능을 쓰거나 16개를 넘는 포즈를 담는 팩은 `pose-variants`를 선언해야 한다.
기능을 선언한 팩은 최대 32포즈를 담을 수 있다. 0.4.x 앱은 새 capability를 설치 전에
거부하므로 앱을 먼저 업데이트한다. export 명령은 필요한 팩에만 이 capability를 추가하여
기존 팩의 호환성을 유지한다. 모든 추가 pose ID도 실제 팩에 있어야 한다.

앱 0.6.0부터 `pose-dialogue` capability로 포즈별 대사 후보를 지정할 수 있다.
`dialogue.ko.json`의 기존 `poseTriggers`는 표시가 완료된 포즈를 대사 이벤트에 연결하고,
선택적 `poseLines`는 같은 이벤트를 공유하는 포즈들의 문구를 구분한다. 각 키는
`poseTriggers`에 있어야 하며 최대 32개, 각 후보는 1–20줄, 한 줄은 최대 36 Unicode
코드 포인트의 일반 텍스트다. 지정하지 않은 포즈와 이벤트 미리보기는 기존 `triggers.lines`를
사용한다. 쓰다듬기는 수락된 해당 제스처의 포즈 대사를 사용하고, 얼굴 누르기는 자체
이벤트 문구를 유지한다. 포즈 전환 전에 대사를 내거나 지난 포즈의 대사를 재생하지 않는다.

```json
{
  "poseTriggers": {"happy":"run.completed.observed","happy-double-v":"run.completed.observed"},
  "poseLines": {"happy":["수고하셨습니다."],"happy-double-v":["피스, 피스."]}
}
```

`poseLines`를 사용하는 팩만 `pose-dialogue`를 선언한다. export 명령이 필요 여부를
검사하며, 이전 앱은 새 capability를 설치 전에 거부한다.

revision = `SHA256(pack.json 원본 UTF-8 바이트 + LF + JSON.stringify(경로 오름차순 files))`.
files 정렬은 코드 포인트 비교를 사용한다. `pack.json` 자체를 files에 넣지 않는다.
따라서 manifest 공백 변경도 revision 변경이며, 같은 version으로 다른 revision을 배포하면
충돌이다. 수정 시 version을 높인다. 낮은 버전 import와 설치된 이전 정상 revision 복원은
별도 동작이다. 내장 ID는 실제 내장 catalog에서 가져오며 덮어쓰기·제거할 수 없다.

## 경로·자원 제한

ZIP 이름은 정규화된 NFC 상대 경로만 허용한다. 절대 경로·`.`·`..`·역슬래시·콜론·퍼센트·
query/fragment·제어문자·Windows 예약명·말단 점/공백·이름 중복·대소문자/NFKC 충돌을 거부한다.
상위 디렉터리 이름의 충돌도 검사한다. Unix 링크/특수 파일/실행 권한, 링크 extra field,
암호화와 store/deflate 이외의 압축은 거부한다. local header와 central directory 및 실제
해제 길이·CRC를 대조한다. 실제 payload는 SHA-256으로 다시 검사한다.

manifest의 상대 참조는 **참조하는 파일 기준**이다. `../`는 해당 revision 안에서 inventory의
파일로 해석되는 경우에만 허용한다. HTTP(S), file, data, protocol-relative URL, 다른 팩,
앱 코드, 설정 파일로의 참조는 거부한다. exporter는 단순한 내부 상대 경로를 쓴다.

| 항목 | 상한 |
| --- | --- |
| 압축 파일 / 해제 payload | 256 MiB / 384 MiB |
| 개별 파일 / JSON | 32 MiB / 2 MiB |
| payload 파일 / ZIP entry (디렉터리 포함) | 256 / 512 |
| 경로 UTF-8 길이 / 깊이 | 180바이트 / 8 |
| JSON 깊이 / 방문 노드 / 배열 길이 | 16 / 60,000 / 2,048 |
| canvas 및 이미지 한 변 | 2,048px |
| PSD layer 수 / 레이어 직사각형 픽셀 합 | 96 / 8,000,000 |
| 파생 rig 레이어 픽셀 합 | 12,000,000 |
| 포즈 / 설치 캐릭터 / 캐릭터별 보존 revision | 기본 16, `pose-variants` 32 / 32 / 32 |
| 메시 정점 / 한 rig의 합계 정점 | 65,535 / 300,000 |
| 사용자 팩 저장 공간 | 2 GiB (보존 revision 포함) |
| Worker JS heap / 검증 시간 / 확인 유효 시간 | 384 MiB / 120초 / 10분 |

입력 한도는 큰 파일 하나에 맞춰 자동 완화하지 않는다.
PSD v1은 8-bit RGB raster layer 모델만 받으며 live layer mask는 먼저 픽셀에 적용해야 한다.
canvas·채널·레이어 직사각형을 **디코딩 전에** 검사하고 실제 PSD loader, rig, pose registration,
선택 레이어, motion selector까지 Worker에서 확인한다. GPU 경로는 공유 mesh 계산으로
Uint16 범위를 검사하고 실제 기기의 MAX_TEXTURE_SIZE도 확인한다. 픽셀 제한은 Worker heap
외부의 RGBA buffer에도 적용된다. 디코딩·합성·rig 생성 중 여러 사본이 필요하므로 단순한
ZIP 크기보다 많은 메모리를 사용한다. 이를 시각 품질 인증으로 표시하지 않는다.

JSON은 prototype 오염 키, 비유한 값, 과도한 크기, 잘못된 중첩 RigOverrides, 잘못된 behavior
pose 참조를 거부한다. 허용되는 데이터는 PSD·PNG/JPEG/WebP·규격 JSON이며 `LICENSE.txt`는
텍스트로 보존한다. HTML/JS/CSS/SVG/WASM/스크립트·모델 가중치는 포함할 수 없다.

## 저장과 복구

실제 루트는 `app.getPath('userData')/characters`다. 앱 이름·사용자 데이터 위치는 바꾸지
않는다. 설치 bundle/ASAR/resources/dist/원본 저장소에 팩을 복사하지 않는다.

```text
characters/registry.json
characters/registry.json.previous
characters/staging/<Main UUID>/{archive.zip,payload/,journal.json}
characters/packs/<id>/revisions/<digest>/...
```

Main의 registry가 설정·트레이·Pet·Electron Motion Lab의 단일 목록 원천이다. 일반
renderer DTO에는 절대 파일 경로를 넣지 않는다. Main이 선택 파일을 staging에 복사한 뒤
Worker가 그 바이트를 검증한다. 확인 token은 설정 창의 frame owner·generation·유효 시간에
묶인다. 검증 완료를 renderer가 주장하거나 임의 파일 경로를 넘기는 API는 없다.

작업은 직렬화한다. revision rename 전 journal을 쓰고, index는 fsync한 임시 파일과 같은
파일시스템 rename으로 commit한다. 직전 정상 index를 별도 보존한다. 시작 시 index를 먼저
복구하며 폴더 스캔으로 미완료 설치를 발견·등록하지 않는다. journal이 가리키는 미등록
revision은 inventory 소유 파일만 정리한다. staging은 앱 소유 transaction 폴더만 정리한다.

손상 팩은 개별 비활성화한다. 저장소를 읽지 못하면 내장 캐릭터를 쓰되 저장된 외부 선택은
보존한다. 앱을 실행할 때 registry 복구가 설정의 가용 ID 판정보다 먼저다. 이전 revision은
보존하여 로딩 중인 모델과 복원 경로가 갑자기 사라지지 않게 한다. v1은 자동 revision GC를
제공하지 않으며 저장 한도가 적용된다. 팩 제거 시 정확히 inventory와 일치하는 파일만 지운다.
사용자가 별도로 추가·수정한 파일이 남으면 저장량에 계속 포함될 수 있다.

## 프로토콜과 교체

- `pet://app/characters/catalog.json`: registry 생성 목록, `no-store`.
- 내장 `pet://app/characters/<id>/...`: 기존 자산.
- 외부 `pet://app/character-packs/<id>/<revision>/...`: 등록된 inventory 데이터만 제공.

외부 응답은 정확한 MIME, `nosniff`, `default-src 'none'; sandbox` CSP를 사용하며
document/script/worker 로딩을 거부한다. GET/HEAD만 허용한다. 파일 realpath를 다시 확인한다.
staging/index/설정/Hook/로그를 제공하지 않는다. revision URL에서만 immutable cache를 쓴다.

캐릭터 로딩 키는 ID+revision이다. 관련 없는 팩 추가는 현재 모델·작업·대사를 재시작하지
않는다. 새 자산·리그·주요 포즈와 GPU 자원을 준비한 후 교체하며 오래된 요청은 epoch/abort로
무효화한다. 실패하면 이전 정상 모델을 유지하고 Main에서 선택/revision을 복원한다. Adapter는
재시작하지 않는다. 선택 중인 팩 제거는 Pet의 내장 fallback ready를 확인한 뒤 수행한다.

Electron 개발 모드는 같은 좁은 `pet` resolver를 쓰며 Vite의 정확한 origin만 데이터 fetch에
허용한다. standalone 브라우저 Motion Lab의 OS 팩 설치 기능은 제공하지 않는다. 최종 인수는
dev server가 없는 packaged 앱에서 수행한다.

## 제작자 명령

```sh
node scripts/characters/build-independent-payload.mjs \
  --source <selected-run> --id <id> --label '<이름>' --profile trial \
  --behavior <behavior.json> --dialogue <dialogue.ko.json> \
  --output outputs/character-packs/<id>/payload

node scripts/characters/export-pack.mjs \
  --character-root outputs/character-packs/<id>/payload \
  --version 0.1.0 --output outputs/character-packs/<id>-0.1.0.petchar
```

trial은 `waiting`, `writing`, `head-tap` 3개의 독립 원화/모델이다. 미제작 상태는 neutral/
기본 parameter motion에 매핑하고 존재하지 않는 poseId를 참조하지 않는다. full은 표준
10포즈를 요구한다. 같은 그림을 복사한 파일 수를 제작 완료 포즈 수로 계산하지 않는다.

behavior/dialogue는 캐릭터별 명시 입력이다. 기존 캐릭터 그림·좌표·대사를 기본값으로 복사하지
않는다. `--runtime-patches <pose-id → 상대 JSON 경로 map>`으로 앱에서 검증한 입력 영역 등
보정을 보존할 수 있다. selected 원본 hash와 runtime hash는 provenance에서 구분한다.


두 CLI는 기존 출력 경로를 암묵적으로 덮어쓰지 않는다. exporter는 입력 payload를 수정하지
않고 임시 사본을 검증해 ZIP으로 내보낸다. 내장 catalog·UI enum·앱 빌드·서명·추론을 호출하지
않는다. 새 팩 설치에는 앱의 가져오기 UI를 사용한다.

## 오류와 검증 범위

오류 코드는 `electron/shared/character-pack-contract.ts`의 `PACK_ERRORS`가 원천이다.
`PACK_PATH`는 경로, `PACK_LIMIT`는 자원, `PACK_INTEGRITY`는 누락/해시/ZIP 불일치,
`PACK_SCHEMA`는 데이터/리그, `PACK_INCOMPATIBLE`은 앱 호환성, `PACK_CONFLICT`는 같은
version의 다른 내용, `PACK_DOWNGRADE`는 낮은 버전, `PACK_TRANSACTION`은 만료/변경된 확인,
`PACK_SPACE`는 저장량/여유 공간, `PACK_LOAD`는 표시 실패다. 파일 선택 취소는 오류가 아니다.

단위 테스트는 경로·권한·rollback·복구·자원 한도를 작은 fixture로 재현한다. 실제 패키지에서
신규 ID import → 시각 변화가 있는 update → 잘못된 update 거부 → rollback → 재시작 →
원본 archive 제거 후 실행 → 선택 중 remove를 검증하고 후보 bundle hash를 전후 대조한다.
캐릭터의 눈/입 중간값, 접촉, 모션, 사용 크기의 시각 검토는 별도로 기록한다.

## 라이선스 보존

기존 v1의 선택 파일 `LICENSE.txt`를 그대로 사용합니다. 지피쨩 payload에는 정확한
상대 시각 파일 목록, 커뮤니티 참고 자료와 미확인 원출처, 제공자가 허락할 수 있는 추가
기여에만 적용되는 권리 범위, CC BY 4.0 전문 및 비시각 파일의 프로젝트 MIT 전문이
들어 있습니다. export/import의 기존 inventory 해시와 크기·경로 검증 대상이며 새로운
확장자나 제한 완화는 없습니다. 다른 팩의 LICENSE.txt는 바이트 그대로 보존하고
출처 미상 팩에 자동 라이선스를 붙이지 않습니다. 팩 컨테이너 전체를 CC BY로 선언하지 않습니다.
