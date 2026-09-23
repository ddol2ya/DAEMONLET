# 대화 의미의 제작·내보내기

앱의 `electron/shared/character-chat-semantics.ts`가 공통 계약이다. 포즈 ID는 자유이며 앱이 이름에서 의미를 추측하지 않는다. 배포 팩은 `character.json`의 `chat` 참조와 `character-chat-v1` capability로 연결한다. 같은 규칙을 behavior에 다시 기록하지 않는다.

새 제작의 `models.json` 예:

```json
{
  "strategy": "whole-model-per-pose",
  "basePoseId": "pose_00",
  "models": [
    {"id":"pose_00","label":"기본","model":"pose_00/model.json"},
    {"id":"pose_07","label":"답변 준비","model":"pose_07/model.json",
     "intendedMeaning":{"when":{"phase":"generating"},"motionPolicy":"chat-safe"},
     "meaningReview":"confirmed"}
  ]
}
```

제작 의도는 이미지/리그 QA에서 확인한 뒤 `confirmed`로 바꾼다. `needs-review`나 의도 없는 항목은 내보내는 의미 규칙에서 빠지고 기본 모델을 사용한다. `payload`는 실제 산출 ID로 `chat.json`을 만들며 payload 밖에 `.chat-review.json`을 남긴다. `export`는 참조·capability·inventory·bytes·SHA를 자동 갱신한다. 이미 유효한 chat 규칙은 보존하고 재검증한다.

기존 payload에 리뷰 결과를 적용하거나, 기존 팩을 보완할 수 있다. plan은 `models`의 `id`, `intendedMeaning`, `meaningReview`, optional `profile`과 `defaultPoseId`를 받는다. 동일 rule ID의 기존 수동 규칙은 덮어쓰지 않는다. 미확정·미연결 상태와 보존 여부를 보고한다.

```sh
node skills/create-pet-character/scripts/creator.mjs export --character-root /ABS/payload --chat-plan /ABS/reviewed-plan.json --chat-report /ABS/new-review.json --version 1.1.0 --output /ABS/new.petchar
node skills/create-pet-character/scripts/creator.mjs upgrade-chat --input /ABS/original.petchar --chat-plan /ABS/reviewed-plan.json --persona /ABS/persona.json --version 1.1.0 --output /ABS/new.petchar --report /ABS/preservation.json
```

`--persona`는 선택 사항이다. 기존 팩의 ID와 원본은 유지하고 더 높은 정식 세 자리 버전의 새 QA 후보를 만든다. 원화·리그·기존 대사·작업 참조 바이트는 변경하지 않는다. 인물별 설정과 위키 원문을 앱 코드나 합성 테스트에 넣지 않는다. 같은 의미 plan 재실행의 결과는 멱등적이다. chat-safe는 포즈의 시각 자산만 사용하며 작업/터치 이벤트를 실행하지 않는다.

## 팩 이름과 대화 표시 이름

관리 목록의 이름은 `pack.json.name`과 `character.json.label`에 버전 구분을 포함해 유지한다. 대화창과 대화 프롬프트의 인물 이름은 `chat.json.profile.displayName`을 사용한다. 생략한 기존 팩은 팩 이름으로 표시한다. 이름에서 버전 문자열을 자동으로 제거하지 않는다.

제작 plan의 `profile.displayName`에 버전 없는 실제 인물 이름을 지정한다. payload/export/upgrade-chat 경로에서 이를 검증해 포함한다. 기존 팩의 이름만 갱신할 때는 `{"profile":{"displayName":"표시 이름"}}` plan으로 upgrade-chat을 실행한다. 나머지 프로필과 포즈 규칙은 보존한다. 이름은 공백이 아닌 80자 이하 문자열이어야 한다.

새 payload 제작에서는 `models.json.chatProfile.displayName`에 표시 이름을 기록한다. 제작자가 사용자에게 팩 구분용 이름과 실제 대화 이름을 구분해 확인한다.
