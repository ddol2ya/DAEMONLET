# Daemonlet 캐릭터 제작 스킬

`create-pet-character` 폴더 전체를 Codex의 skills 폴더에 복사합니다. 독립 스킬 배포물은 `runtime/`에 자체 제작 스크립트와 공용 렌더러·팩 검증 코드를 포함합니다. `runtime/`에서 `npm ci`를 실행하세요.

ComfyUI, 검증 버전의 See-through 플러그인과 모델은 직접 설치해야 합니다. `references/production.md`와 `external-dependencies.json`을 확인하세요. 이 스킬은 ComfyUI 설치나 모델 다운로드를 자동 수행하지 않습니다.

자체 제작 Python에는 numpy/Pillow, 영상 검수에는 ffmpeg가 필요합니다. 이미지 생성 접근 권한도 별도입니다. `node scripts/creator.mjs info`와 `check`로 설치를 점검하고 `$create-pet-character`로 요청하세요. 원화별 마스크·좌표와 표정·접촉을 검토하는 실험 기능이며 모든 그림의 무인 완성을 보장하지 않습니다.
