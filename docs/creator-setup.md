# 캐릭터 제작 환경

앱 설치만 할 사용자는 이 절차가 필요하지 않습니다. 이 스킬은 실험 기능이며 포즈·표정·마스크에 대한 사람 또는 Codex의 검토가 필요합니다.

## 제공하는 것

제작 스킬에는 레퍼런스 질문·제작 절차와 자체 정규화·ComfyUI 요청·PSD 조립·리깅·렌더러 검수·팩 출력 스크립트를 제공합니다. ComfyUI, See-through 코드와 모델 가중치는 포함하지 않습니다.

## 사용자 준비

1. 이미지 생성 도구를 사용할 수 있는 Codex 환경을 준비합니다. 레퍼런스가 있어도 새 포즈 원화를 만드는 이미지 생성 접근 권한이 필요합니다.
2. [ComfyUI 공식 설치 안내](https://github.com/Comfy-Org/ComfyUI#installing)에 따라 설치합니다.
3. ComfyUI의 `custom_nodes`에 [ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through)를 설치합니다. 이 프로젝트의 호환 기준은 `98d754bf04f668647919ab750eccb0e0640faa81`이며 최신으로 자동 갱신하지 않습니다. 해당 ComfyUI의 Python으로 의존성을 설치하세요.
4. [외부 의존성 목록](../skills/create-pet-character/external-dependencies.json)의 모델을 직접 준비합니다. 모델 저장소의 조건과 검증 revision을 확인합니다. 제작 요청은 `auto_download=false`이며 없는 모델을 몰래 내려받지 않습니다. 후처리는 추가 LaMA 가중치 로딩 없이 OpenCV를 사용하며, 숨은 면은 원화별 마감 단계에서 검수·보완합니다.
5. 자체 제작 도구용 Node.js 22.13 이상, Python 3.10 이상과 `numpy`, `Pillow`를 준비합니다. 영상 검수에는 ffmpeg가 필요합니다. 이 Python은 ComfyUI Python과 다를 수 있습니다.

RTX 3060 12GB + group offload가 최소 지원 목표입니다. 기본 1280px, 8GB 이하는 비권장/시도 시 1024px 이하입니다. 속도·메모리는 실행 환경에 따라 달라집니다. 현재 제작 GPU 기준은 NVIDIA CUDA이며 Mac 앱 지원과 별개입니다.

## 스킬 설치와 자체 실행 도구

소스에서 사용할 때는 이 레포에서 `npm ci`를 실행하고 `skills/create-pet-character`를 Codex skills 폴더에 복사하거나 이 경로를 지정합니다. 복사본이 소스와 떨어져 있으면 `DAEMONLET_CREATOR_RUNTIME`을 이 레포 절대 경로로 지정합니다.

독립 배포 스킬 ZIP에는 `create-pet-character/runtime/`이 포함됩니다. 폴더 전체를 Codex skills 폴더에 복사한 뒤 해당 `runtime/`에서 `npm ci`를 실행합니다. 필요한 자체 도구·공용 렌더러 소스가 함께 들어 있어 예전 비공개 레포는 필요하지 않습니다. 외부 엔진과 모델 설치는 여전히 별도입니다.

```sh
node <skill>/scripts/creator.mjs info
node <skill>/scripts/creator.mjs check
# GPU PC의 ComfyUI Python으로 실행
<comfy-python> <skill>/scripts/check-environment.py --comfy-root <ComfyUI-folder>
```

`$create-pet-character`와 레퍼런스 이미지를 전달하면 ComfyUI 절대 경로·Python·접속 URL·GPU, 출력 ID와 클릭 반응 수를 확인합니다. 기본 10포즈이며 머리/몸통 클릭을 각 3종으로 선택하면 14포즈입니다. 팩은 `.petchar`로 내보내 앱에서 가져옵니다.

Node가 쓰는 Python이 다르면 `DAEMONLET_CREATOR_PYTHON`을 해당 Python 실행 파일로 지정하세요. 스킬의 `creator.mjs`는 확인된 제작 runtime에서만 정해진 CLI를 실행합니다. 작업은 그 runtime의 `outputs/characters/<new-run>/`에서 진행하며 기존 선정 결과를 덮어쓰지 않습니다.
