# 캐릭터 제작 환경

앱 설치만 할 사용자는 이 절차가 필요하지 않습니다. 이 스킬은 실험 기능이며 포즈·표정·마스크에 대한 사람 또는 Codex의 검토가 필요합니다.

## 제공하는 것

제작 스킬에는 레퍼런스 질문·제작 절차와 자체 정규화·ComfyUI 요청·PSD 조립·리깅·렌더러 검수·팩 출력 스크립트를 제공합니다. ComfyUI, See-through 코드와 모델 가중치는 포함하지 않습니다.

## 사용자 준비

아래 환경은 직접 준비하거나 Codex에 승인 후 설치를 맡길 수 있습니다. 캐릭터 제작 요청만으로 설치가 승인되는 것은 아닙니다. 준비 중 누락·호환성 문제가 발견되면 Codex가 구체적인 설치 계획을 제시하고 진행 여부를 묻습니다.

1. 이미지 생성 도구를 사용할 수 있는 Codex 환경을 준비합니다. 레퍼런스가 있어도 새 포즈 원화를 만드는 이미지 생성 접근 권한이 필요합니다.
2. [ComfyUI 공식 설치 안내](https://github.com/Comfy-Org/ComfyUI#installing)에 따라 설치합니다.
3. ComfyUI Manager의 확장 검색에서 **ComfyUI-See-through**를 찾아 설치하고 ComfyUI를 재시작합니다. [공식 노드팩](https://github.com/jtydhr88/ComfyUI-See-through)인지 확인하세요. 수동 설치도 가능하며 해당 ComfyUI의 `custom_nodes`에 설치하고 그 ComfyUI의 Python으로 의존성을 설치합니다. 이 프로젝트의 호환 기준은 `98d754bf04f668647919ab750eccb0e0640faa81`입니다. Manager가 설치한 revision과 필수 노드가 맞는지 확인하고 기존 설치를 자동 갱신하지 않습니다. 이미 설치돼 있으면 먼저 재사용 가능 여부를 검사합니다.
4. [외부 의존성 목록](../skills/create-pet-character/external-dependencies.json)의 모델 조건을 먼저 확인합니다. **2026-09-13 확인: LayerDiff3D는 지정 revision의 모델 카드에 Apache-2.0이 선언돼 있으나 별도 전문 파일은 없고, Marigold는 README·라이선스 파일·라이선스 메타데이터가 없어 조건 미확인(pending)입니다.** 플러그인 MIT 선언이나 다른 Marigold 저장소의 조건을 해당 가중치의 허락으로 대신하지 않습니다. 미확인 조건과 실제 설치 revision을 확인한 뒤 사용자가 직접 설치 여부를 판단합니다. 제작 요청은 `auto_download=false`이며 없는 모델을 몰래 내려받지 않습니다. 후처리는 추가 LaMA 가중치 로딩 없이 OpenCV를 사용하며, 숨은 면은 원화별 마감 단계에서 검수·보완합니다.
5. 자체 제작 도구용 Node.js 22.13 이상, Python 3.10 이상과 `numpy`, `Pillow`를 준비합니다. 영상 검수에는 ffmpeg가 필요합니다. 이 Python은 ComfyUI Python과 다를 수 있습니다.

RTX 3060 12GB + group offload가 최소 지원 목표입니다. **선택한 GPU의 전체 VRAM이 12GiB 이하일 때만** 두 로더의 group offload를 켜고, 12GiB를 초과하면 끕니다. 사용 가능한 여유 메모리와는 별개입니다. 제작 명령은 ComfyUI 서버에서 용량을 감지하며, 감지 실패나 복수 GPU로 불명확한 경우 작업 전에 실제 용량을 명시해야 합니다. 기본 1280px, 8GB 이하는 비권장/시도 시 1024px 이하입니다. 속도·메모리는 실행 환경에 따라 달라집니다. 현재 제작 GPU 기준은 NVIDIA CUDA이며 Mac 앱 지원과 별개입니다.

## See-through와 모델을 처음 준비할 때

Codex에 “캐릭터 생성에 See-through를 사용하고, 지정한 ComfyUI에 해당 노드팩이 없으면 설치해줘”라고 요청할 수 있습니다. `.comfyui`라는 폴더 이름만으로 설치 위치나 Python을 단정하지 않고, 실제 ComfyUI 루트·Python·URL·GPU를 확인합니다. 미설치 환경에서도 안내만 하고 끝내지 않고, [제작 스킬의 승인 후 설치 절차](../skills/create-pet-character/SKILL.md#dependency-setup-with-approval)에 따라 설치 대상·공식 출처·버전·예상 다운로드/디스크 용량·모델 조건을 제시하고 승인받으면 설치와 검증까지 진행합니다. 용량 등 확인되지 않은 항목은 추정 사실과 구분합니다.

새 설치와 기존 환경 변경은 구분합니다. Python 패키지 변경, 설정 수정, 캐시 복구, 재시작이 필요하면 승인 전에 범위를 설명하고 기존 상태를 기록합니다. 승인한 모델의 필수 메타데이터·문서도 준비 범위에 포함하여 파일마다 재승인을 요구하지 않습니다. 추가 모델이나 승인하지 않은 환경 변경이 필요하면 변경된 계획을 확인받습니다. Manager 설치 절차는 [공식 안내](https://docs.comfy.org/installation/install_custom_node)를 따르며, 실행 중인 GPU 작업을 취소하지 않습니다. 승인한 재시작은 서버가 유휴 상태일 때 진행합니다.

준비 후 환경 검사, import 로그와 `/object_info`의 필수 노드, `auto_download=false` 모델 로딩을 확인합니다. 합의한 첫 포즈로 실제 분해를 실행해 두 로더의 VRAM별 offload 설정과 파츠·depth 출력을 검증한 뒤 제작을 이어갑니다. 설치 실패 시 부분 변경과 막힌 단계를 보고하며, 무차별 업데이트나 공유 캐시 삭제로 재시도하지 않습니다. 환경 검사 명령 자체는 계속 읽기 전용이며 설치를 수행하지 않습니다.

노드팩 코드 설치와 모델 다운로드는 단계가 다릅니다. 공식 노드는 `auto_download=true`로 **처음 모델을 불러올 때** LayerDiff3D와 깊이 추정용 Marigold를 내려받을 수 있습니다. 따라서 See-through를 처음 설정하면서 Marigold도 함께 준비되는 것은 예상되는 동작입니다. 사용자가 모델 준비를 요청한 경우 이 공식 첫 다운로드 절차를 사용할 수 있습니다. 이미 있는 모델은 먼저 확인하여 재사용하고, 프로젝트 앱이나 제작 ZIP에 가중치를 넣지 않습니다. 준비 뒤 이 레포의 제작 요청은 `auto_download=false`로 실행하므로 제작 중 빠진 모델을 자동으로 받지 않습니다.

공식 문서의 `24yearsold/seethroughv0.0.1_marigold` 주소는 확인일 현재 `layerdifforg/seethroughv0.0.1_marigold`로 연결되는 별칭이며 동일 revision과 가중치 해시를 제공합니다. 다른 모델을 요구하는 것은 아닙니다. Manager 검색·설치 가능 여부와 모델의 이용 조건 명시는 별개이며, 조건 미확인은 사용 불가 판정이나 앱 공개 차단 판정이 아닙니다. [검토 기록](external-license-review.md)에 설치 경로와 미확인 조건을 구분했습니다.

## 스킬 설치와 자체 실행 도구

소스에서 사용할 때는 이 레포에서 `npm ci`를 실행하고 `skills/create-pet-character`를 Codex skills 폴더에 복사하거나 이 경로를 지정합니다. 복사본이 소스와 떨어져 있으면 `DAEMONLET_CREATOR_RUNTIME`을 이 레포 절대 경로로 지정합니다.

독립 배포 스킬 ZIP에는 `create-pet-character/runtime/`이 포함됩니다. 폴더 전체를 Codex skills 폴더에 복사한 뒤 해당 `runtime/`에서 `npm ci`를 실행합니다. Electron으로 렌더러를 실행·캡처하려면 같은 폴더에서 `node node_modules/electron/install.js`도 실행합니다(Electron 43의 명시적 런타임 설치). 필요한 자체 도구·공용 렌더러 소스가 함께 들어 있어 예전 비공개 레포는 필요하지 않습니다. 외부 엔진과 모델 설치는 여전히 별도입니다.

```sh
node <skill>/scripts/creator.mjs info
node <skill>/scripts/creator.mjs check
# GPU PC의 ComfyUI Python으로 실행
<comfy-python> <skill>/scripts/check-environment.py --comfy-root <ComfyUI-folder>
# 복수 GPU 등으로 자동 감지가 불명확하면 ComfyUI가 사용하는 GPU의 전체 용량을 명시
<comfy-python> <skill>/scripts/check-environment.py --comfy-root <ComfyUI-folder> --vram-gib 24
```

`$create-pet-character`와 레퍼런스 이미지를 전달하면 ComfyUI 절대 경로·Python·접속 URL·GPU, 출력 ID와 클릭 반응 수를 확인합니다. 기본 10포즈이며 머리/몸통 클릭을 각 3종으로 선택하면 14포즈입니다. 팩은 `.petchar`로 내보내 앱에서 가져옵니다.

Node가 쓰는 Python이 다르면 `DAEMONLET_CREATOR_PYTHON`을 해당 Python 실행 파일로 지정하세요. 스킬의 `creator.mjs`는 확인된 제작 runtime에서만 정해진 CLI를 실행합니다. 작업은 그 runtime의 `outputs/characters/<new-run>/`에서 진행하며 기존 선정 결과를 덮어쓰지 않습니다.

`creator.mjs check`의 `technicalReadiness`는 자체 실행 코드 준비만 뜻합니다.
`check-environment.py`도 GPU/패키지 준비와 `licenseReview`를 분리합니다.
라이선스 경고 확인은 허락 취득이 아니며, 실제 설치 revision은 이 소스 검토로 검증되지
않습니다. 미확인 상태 때문에 모델이 필요 없는 앱 실행·소스 빌드를 막지는 않습니다.
[확인 근거와 범위](external-license-review.md)를 함께 확인하세요.

## Persona-only updates

For an existing pack, personality updates need Node and the creator runtime's npm dependencies; they do not need images, ComfyUI, Python, model weights or a GPU. `creator.mjs validate-persona` and `creator.mjs upgrade-persona` work from the complete extracted skill ZIP. Reuse the supplied, consistent character sources; see the skill's `references/persona.md`. `info` and `check` retain their read-only behavior. For new characters, pass `--persona <json>` to the payload command using the same confirmed profile as fixed dialogue.

The source HTML and full extracts remain in private production outputs. Updated packs require an app recognizing `side-chat-persona-v1`. Chat support is independently gated by the Codex runtime; a successfully migrated persona pack is not proof of real-model chat support.
