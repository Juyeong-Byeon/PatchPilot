# PatchPilot PR Description Guidance

## Rules

- Base every concrete claim on the final diff or stage notes.
- Mention only files, modules, functions, and commands that actually changed or
  ran.
- Do not mix agent-authored claims with platform-verified evidence.
- Do not say verification passed unless the command actually succeeded.
- Keep secrets and raw credential values out of the description.
- Use Korean prose by default when drafting reviewer-facing descriptions.

## Required Six-Header Shape

When the runner prompt asks for the structured Korean body, keep exactly these
headers in this order:

```markdown
## 아키텍처 변경점
## 새로 추가된 컴포넌트
## 데이터 플로우
## 실패 시나리오
## 트레이드오프
## 테스트 전략
```

If a section does not apply, keep the header and write one concise sentence
explaining why it does not apply.

## Good Example

```markdown
## 아키텍처 변경점
- `apps/runner/src/gstack-staged-runner.ts`의 stage prompt에 PatchPilot skill
  reference 지시를 추가했습니다.

## 테스트 전략
- `npm test -- apps/runner/test/gstack-staged-runner.test.ts`를 실행했고
  통과했습니다.
```

## Bad Example

```markdown
## 아키텍처 변경점
- 전체 러너 아키텍처를 개선했습니다.

## 테스트 전략
- Tests passed.
```

The bad example is too broad, names no real changed surface, and claims tests
without the command.
