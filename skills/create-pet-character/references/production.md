# 자체 제작 도구와 데이터 계약

`node <skill>/scripts/creator.mjs info`가 출력하는 runtime을 제작 작업 폴더로 사용한다. 소스에서는 레포 루트, 독립 스킬 ZIP에서는 동봉한 `runtime/`이다. 그 폴더에서 `npm ci`를 실행한다. ComfyUI·See-through·모델 설치는 `external-dependencies.json`의 공식 출처와 호환 버전을 따른다. 제작 Python에는 numpy/Pillow, 영상 검수에는 ffmpeg가 필요하다. 이미지 생성 접근 권한도 별도다.

`creator.mjs`의 `decompose`, `build`, `finish`, `capture`, `verify`, `payload`, `export` 명령은 아래 스크립트를 해당 runtime에서 실행한다. 직접 실행할 때도 먼저 runtime으로 이동한다. `DAEMONLET_CREATOR_PYTHON`으로 자체 제작 Python을 선택할 수 있다.

## 입력과 분해

작업 루트는 **`outputs/characters/<new-run>`** 하위로 만든다. 출력 보호 검사는 이 위치를 요구한다. 동결된 기존 run은 수정하지 않는다.

```text
<run>/plan/poses.json                  {"poses":[{"id":"waiting","label":"대기"}, ...]}
<run>/poses/<id>/inputs/master.png     포즈 자체의 1280×1280 원화
<run>/poses/<id>/native/               원시 layers.json, 파츠 PNG, depth
<run>/poses/<id>/plan/geometry.json    자체 눈·입·손·입력 영역 좌표
<run>/poses/<id>/plan/own-expression-request.json
<run>/poses/<id>/raw/own-expression-G0.png
```

이 구조와 geometry/expression 시트 형식은 현재 `build-source-models.py`를 읽고 맞춘다. 원시 `run-seethrough` 출력은 `seed-<seed>/` 아래에 있으므로 채택 seed의 파츠와 metadata를 native에 보존하고 원본 크기→1280 변환을 기록한다. 예전 실험 스크립트의 원격 주소나 캐릭터 전용 geometry를 실행 입력으로 가져오지 않는다.

```sh
node scripts/run-seethrough.mjs "<pose.png>" "<새-output>" 42013 "<ComfyUI-URL>" waiting 1280 30
# VRAM 자동 감지가 불가능한 8GB 환경에서는 마지막 인자로 명시:
node scripts/run-seethrough.mjs "<pose.png>" "<새-output>" 42013 "<ComfyUI-URL>" waiting 1024 30 8
```

ComfyUI 큐가 비어 있을 때 포즈 하나씩 실행한다. 다른 작업을 취소하지 않는다. 두 로더의 group offload 실제 활성화를 로그로 확인하고, 모델은 미리 설치하며 auto_download=false를 유지한다. 실제 모델 snapshot/해시를 기록한다. RTX 3060 12GB + group offload/1280이 프로젝트의 최소 지원 목표다. 8GB 이하는 비권장이며 1024 이하로 낮춰도 OOM이 날 수 있다.

## 모델 조립과 마감

현재 조립 도구에는 원시 iris alpha를 사용해 특정 눈 색 의존을 줄였지만 피부/아이라인 추정은 원화별 검수가 필요하다. 마스크와 기하 좌표를 확인하고 필요한 경우 해당 원화에 맞게 조정한다. 이전 좌표를 그대로 복사하거나 색 조건이 범용이라고 가정하지 않는다.

눈마다 좌우/기울기를 독립적으로 지정한다. `sourceEyeApertures`, `neutralMouthBounds`, `frontHands`, `headFollowLayers`, `interactionAreas`는 해당 포즈를 보고 작성한다. 추가 클릭 variants는 기본 포즈 파일의 별명 대신 서로 다른 원화/PSD를 갖는 `head-tap-2`, `head-tap-3`, `torso-tap-2`, `torso-tap-3` 같은 ID로 만든다.

```sh
python3 scripts/characters/build-source-models.py "<run>" --pose waiting --round N0
python3 scripts/characters/finish-source-models.py prepare "<run>" --pose waiting --source-round N0 --round N1
# raw/finish-N1-edit-target.png를 보고 기록된 프롬프트와 같은 포즈 원화를
# 내장 ImageGen에 참조 입력으로 제공. 결과를 raw/finish-N1-G0.png에 보존.
python3 scripts/characters/finish-source-models.py adopt "<run>" --pose waiting --round N1
```

조립 후 포즈별 모션과 대사를 작성하고 선택 모델을 `<run>/models.json`에 기록한다. 예:

```json
{"strategy":"whole-model-per-pose","models":[{"id":"waiting","label":"대기","model":"poses/waiting/N1/model.json"}]}
```

각 `model.json`에는 `psd`, `bodySource`, `overrides`, `pose`를 그 파일 기준 상대 경로로 쓴다. 모델 목록은 실제 선택한 모든 포즈를 포함해야 한다. 단발/반복 모션, `EyeBlink`, `MouthMorph`, `HeadFollow`와 입력 영역을 검토한다.

## 클릭 3종과 팩

사용자가 선택한 반응만 behavior의 `poseId` + 추가 두 개 `poseVariants`로 연결한다. 예: `"poseId":"head-tap","poseVariants":["head-tap-2","head-tap-3"]`. 런타임은 중복 없이 섞어 선택한다. 클릭 중/로딩 중에 다시 선택하거나 세 모델을 같은 순간 표시하지 않는다. exporter가 `pose-variants` capability를 자동 선언한다. 포즈별 대사는 `poseTriggers`와 `poseLines`로 연결하며 `pose-dialogue`가 자동 선언된다.

```sh
node scripts/characters/capture-source-models.mjs --source "<run>" --output "<새-QA>" --motion
node scripts/characters/capture-source-models.mjs --source "<run>" --output "<새-contact-QA>" --contacts
node scripts/characters/build-independent-payload.mjs \
  --source "<run>" --id "<new-id>" --label "<표시명>" --profile full \
  --behavior "<behavior.json>" --dialogue "<dialogue.ko.json>" \
  --output "outputs/character-packs/<new-id>/payload"
node scripts/characters/verify-independent.mjs --source "<run>" --id "<new-id>" \
  --payload "outputs/character-packs/<new-id>/payload" --output "<새-비교-QA>" --mode renderer
node scripts/characters/export-pack.mjs \
  --character-root "outputs/character-packs/<new-id>/payload" --version 0.1.0 \
  --output "outputs/character-packs/<new-id>-0.1.0.petchar"
```

초기 3포즈 검토에는 `--profile trial`을 쓰며 미제작 상태는 중립/기본 동작으로 돌아가게 한다. full은 표준 10포즈에 선택된 추가 variants까지 포함한다. 보정은 `--runtime-patches <pose→JSON-map>`로 명시하고 선정 원본을 보존한다. 내장 catalog 변경은 새 캐릭터 배포에 쓰지 않는다.

팩은 ZIP 컨테이너이며 루트 `pack.json`, `character.json`, behavior/dialogue, 포즈별 PNG/PSD/JSON, 선택 `provenance.json`, `LICENSE.txt`만 넣는다. 스크립트/가중치/개인 경로/미채택 결과는 넣지 않는다. 버전은 `X.Y.Z`, 수정 시 높인다. 기존 출력 경로를 덮어쓰지 않는다. 최종 앱 UI에서 import → 지금 적용 → 모든 포즈 반응 → 재시작을 확인한다. 업데이트가 있으면 잘못된 팩 거부·이전 정상본 복구도 확인한다.

## 완료 기록

원화/시트/파츠 해시, 요청과 실제 분해 설정, 선택/재생성 이력, 상태별 모션, 11단계 표정과 크기별 이미지/영상 검토, 앱 설치 결과, 권리 미확인 사항을 남긴다. 모델·원작·입력 이미지 라이선스는 서로 별개다. AI 생성 결과의 소유 조건만으로 원작 캐릭터 재배포 권한을 추정하지 않는다. 가중치는 사용자 환경에만 설치하고 앱이나 팩에 포함하지 않는다.
