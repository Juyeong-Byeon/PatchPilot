# TypeScript 타입 안전성 강화 작업계획

> 작성: 2026-06-21 · 상태: 제안(실행 대기) · 범위: monorepo 전체(packages/\*, apps/\*)

## 1. 목표

런타임 신뢰성을 코드 레벨에서 한 단계 더 보장한다. 현재 코드베이스는 타입 안전성 위생이
**이미 양호**하다(아래 §2). 이 작업의 목적은 _새 기능_ 이 아니라, 컴파일러·린터·경계 검증을
조여서 **"잠복 가능한 undefined / 무검증 캐스트"를 CI에서 자동으로 막는 것**이다.

비목표: 동작 변경. 모든 단계는 **타입/검증 강화만** 하며 런타임 동작은 그대로 둔다(경계 검증
추가로 인한 _명시적 거부_ 는 예외 — §Phase 3).

## 2. 현재 상태 (감사 결과 요약)

**강점 (그대로 유지)**

- 전 워크스페이스 `strict: true` ([tsconfig.base.json](../tsconfig.base.json)).
- 프로덕션 소스 내 명시적 `any` 0개, `@ts-ignore`/`@ts-expect-error` 0개.
- 가장 중요한 경계인 **에이전트 결과는 Zod 런타임 검증**
  ([packages/core/src/result-schema.ts](../packages/core/src/result-schema.ts)의
  `parseAgentResult` + cross-field `superRefine`). `executor-gstack.ts`의 `... as unknown`은
  이 검증으로 들어가는 **올바른 패턴**이다.
- 에이전트 산출 JSON(qa.json/failure.json)은 `Partial<>` 캐스트 후 **필드별 `typeof` 가드**
  ([codex-agent-runner.ts `readStructuredFailure`](../apps/runner/src/codex-agent-runner.ts)).
- DB 숫자 집계는 `Number(row?.x ?? 0)` 강제변환, 대부분의 행 접근은 `if (!row) return null` 가드.
- GitHub 웹훅 핸들러는 optional-chaining + 가드로 방어적 파싱.

**갭 (이 문서의 작업 대상)**

| #   | 갭                                                                           | 위치                                                                 | 영향                                           |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| G1  | `noUncheckedIndexedAccess` 꺼짐 → 배열/레코드 인덱스 접근이 `T`로 좁혀짐     | `tsconfig.base.json`                                                 | 미가드 인덱스 접근이 컴파일을 통과(잠복)       |
| G2  | ESLint 비(非)type-aware + `no-explicit-any: warn`                            | `eslint.config.mjs`                                                  | 무검증 `any`/캐스트가 CI 통과                  |
| G3  | 어드민 fetch 응답 무검증 캐스트                                              | [api.ts:215,249,287,315](../apps/admin/src/api.ts)                   | 클라이언트가 서버 형태를 맹신                  |
| G4  | 외부 웹훅 바디가 type-only(런타임 스키마 검증 없음), `request.body as never` | [server.ts:84](../apps/api/src/server.ts)                            | HMAC 위 형태검증 부재; 타입 구멍               |
| G5  | `RunnerContext` 등 신뢰입력 무검증 캐스트                                    | [codex-agent-runner.ts:56](../apps/runner/src/codex-agent-runner.ts) | producer/consumer 드리프트 시 silent undefined |
| G6  | `exactOptionalPropertyTypes` 꺼짐(선택)                                      | `tsconfig.base.json`                                                 | `x?: T` vs `x?: T \| undefined` 혼동           |

## 3. 작업 단계

각 Phase = **독립 PR 1개**. 순서는 의존성·레버리지 기준(컴파일러 먼저 → 린터 → 경계 검증).
모든 PR은 `typecheck · lint(0 errors) · format · test · build · CI` green 이어야 머지.

### Phase 1 — `noUncheckedIndexedAccess` 활성화 (G1) · **실측 17개 수정**

- **변경:** `tsconfig.base.json`에 `"noUncheckedIndexedAccess": true` 추가.
- **폴아웃(실측):** 총 **17개** 컴파일 에러 — core 1, db 2, api 3, admin 11 (전체 목록 §부록 A).
  worker/runner/queue/runner-contract는 0.
- **수정 방침:** 인덱스 접근 결과를 `T | undefined`로 받아 **가드 추가**(`if (!x) ...`),
  또는 의미상 항상 존재하면 명시적 단언 대신 **불변식 확인 후 early-return**. `INSERT ... RETURNING`
  처럼 1행 보장되는 곳([repositories.ts:248,646](../packages/db/src/repositories.ts))은
  `const row = result.rows[0]; if (!row) throw new Error("insert returned no row");` 패턴으로
  통일(런타임 불변식을 코드로 명문화).
- **effort:** 0.5d. 동작 변경 없음(전부 방어 코드 추가).
- **검증:** 전 워크스페이스 typecheck green + 기존 테스트 통과(동작 불변).

### Phase 2 — ESLint type-aware 전환 + `no-explicit-any: error` (G2)

- **변경:**
  1. `eslint.config.mjs`에 `parserOptions.project`(또는 `projectService: true`) 추가 →
     타입 인식 린팅 활성.
  2. `@typescript-eslint`의 `no-unsafe-assignment / no-unsafe-member-access / no-unsafe-call /
no-unsafe-return / no-unsafe-argument`, `no-floating-promises`, `await-thenable` 활성.
  3. `no-explicit-any`를 `warn` → `error`(소스에 explicit any 0개라 비용 0).
- **선행 스파이크(필수):** type-aware 룰은 폴아웃 규모가 미측정. PR 전 **로컬 스파이크**로
  `no-unsafe-*` + `no-floating-promises` 위반 수를 측정해 이 Phase를 1개 PR로 갈지 분할할지 결정한다.
  (async 무거운 워커/러너에서 `no-floating-promises`가 가장 클 것으로 예상.)
- **수정 방침:** floating promise는 `void`/`await` 명시, 무검증 흐름은 Phase 3의 경계 검증으로
  대체하거나 좁은 가드 추가. 테스트 파일은 완화 룰 유지(기존 override와 동일 정책).
- **effort:** 스파이크 결과에 따라 0.5~2d.
- **검증:** `npm run lint` 0 errors가 CI 게이트가 됨(현재도 0 errors지만 룰 강화 후 유지).

### Phase 3 — 경계 런타임 검증 (G3·G4·G5)

타입 캐스트를 **Zod/스키마 검증**으로 승격. core가 이미 Zod를 쓰므로 의존성 추가 없음.

- **G3 어드민 fetch 응답:** `JobMetrics`/`SettingsView`/제네릭 `T` 응답을 Zod 스키마로 파싱.
  파싱 실패 시 패널을 "데이터 없음/에러"로 안전 폴백(현재 `api.ts`의 try/catch 폴백과 동일 톤).
  → [apps/admin/src/api.ts](../apps/admin/src/api.ts).
- **G4 웹훅 바디:** GitHub/Lark 웹훅 라우트에 **Fastify JSON schema** 부착(런타임 형태 검증) 또는
  핸들러 진입부 Zod parse. `request.body as never` 제거하고 제대로 타입된 `Body` 제네릭 사용.
  → [apps/api/src/server.ts](../apps/api/src/server.ts), 핸들러들. HMAC 인증 위의 **심층 방어**.
- **G5 RunnerContext:** context.json 읽기를 작은 Zod 스키마로 검증(`parseAgentResult`와 대칭).
  → [apps/runner/src/codex-agent-runner.ts](../apps/runner/src/codex-agent-runner.ts) 외 4곳 공용화.
- **effort:** 1~1.5d. 각 항목은 **검증 실패 경로 테스트**(잘못된 형태 입력 → 거부/폴백)를 추가.
- **검증:** 신규 단위 테스트(스키마 거부 케이스) + 기존 통합 테스트 통과.

### Phase 4 (선택) — `exactOptionalPropertyTypes` (G6) · **실측 35개**

- **폴아웃(실측):** 총 **35개** — api 5, worker 14, runner 9, admin 7.
- **성격:** `{ x?: T }`와 `{ x?: T | undefined }`를 구분하는 엄격 옵션. 17개(Phase 1)보다 크고,
  객체 리터럴/`exactOptional` 의미가 미묘해 **논쟁적**. 실익 대비 비용을 Phase 1~3 완료 후 재평가.
- **결정 필요:** 진행/보류 — §6 참고. 진행 시 별도 PR.

## 4. 시퀀싱 & PR 분할

```
Phase 1 (tsconfig noUncheckedIndexedAccess, 17개)   ─┐ 컴파일러 토대 먼저
Phase 2 (ESLint type-aware + no-explicit-any:error) ─┤ CI 게이트 강화
Phase 3 (경계 Zod/스키마 검증: G3·G4·G5)            ─┘ Phase 1~2와 독립, 병행 가능
Phase 4 (exactOptionalPropertyTypes, 35개) — 선택, 1~3 후 결정
```

- Phase 1·2는 **순서대로**(컴파일러 강화 후 린터 강화). Phase 3는 1·2와 독립이라 병행 가능하나,
  리뷰 부하를 줄이려면 1 → 2 → 3 순으로 직렬 권장.
- 각 Phase는 **순수 강화**라 리뷰가 기계적: diff가 전부 "가드 추가/스키마 추가"여야 하고,
  로직 변경이 섞이면 분리한다.

## 5. 검증 전략 (공통)

- 모든 PR: `typecheck`, `lint`(0 errors), `format:check`, `test`, `build`, CI 전부 green.
- Phase 1·2: **동작 불변** — 기존 테스트가 그대로 통과해야 함(회귀 시 가드 위치 오류 신호).
- Phase 3: **검증 실패 경로 테스트 추가** — 잘못된 형태 입력이 거부/폴백되는지 단위 테스트.
- 신규 strictness는 머지와 동시에 CI 게이트가 되어 **재발 방지**(설정이 곧 강제).

## 6. 리스크 & 결정 필요

- **R1 (Phase 2 미측정):** type-aware 룰 폴아웃이 큰 경우 1 PR이 비대해질 수 있음 → 스파이크 후
  필요시 룰별/디렉터리별로 분할. `no-floating-promises`가 핵심 변수.
- **R2 (Phase 4 논쟁):** `exactOptionalPropertyTypes`는 35개 + 미묘한 의미. **진행 여부 결정 필요.**
  (권장: Phase 1~3 후 재평가, 기본은 보류.)
- **R3 (CI 시간):** type-aware ESLint는 린트 시간이 늘 수 있음(프로젝트 타입 정보 로드). 측정 후
  필요시 `projectService` 캐싱/범위 조정.
- **결정 요청:** (1) Phase 2 스파이크 결과에 따른 분할 허용 여부, (2) Phase 4 진행 여부.

## 부록 A — Phase 1 수정 대상 (noUncheckedIndexedAccess, 실측 17)

```
packages/core/src/gstack-stages.ts:24            string | undefined → string (banner key)
packages/db/src/repositories.ts:248              RunRow | undefined → mapRun (INSERT RETURNING)
packages/db/src/repositories.ts:646              RunRow | undefined → mapRun (retry attempt)
apps/api/src/routes-admin.ts:76 (x2)             path possibly undefined
apps/api/src/routes-settings.ts:105              path possibly undefined
apps/admin/src/App.tsx:552                        string | undefined arg
apps/admin/src/components/RunStepGraph.tsx:189-190  event / RunEvent possibly undefined
apps/admin/src/components/RunTimeline.tsx:309-310   event / RunEvent possibly undefined
apps/admin/src/components/StageNotesPanel.tsx:49,66,108  meta / string possibly undefined
apps/admin/src/lib/evidence.ts:136,162            string / object possibly undefined
apps/admin/src/lib/status.ts:225                  object possibly undefined (deriveStageStates)
```

## 부록 B — 측정 메모

- 측정 방법: 각 옵션을 `tsconfig.base.json`에 임시 추가 후 워크스페이스별 `tsc --noEmit` 에러 수 집계, 즉시 revert.
- `noUncheckedIndexedAccess`: 17 (core 1 / db 2 / api 3 / admin 11).
- `exactOptionalPropertyTypes`: 35 (api 5 / worker 14 / runner 9 / admin 7).
- ESLint type-aware: 미측정(Phase 2 스파이크에서 측정).
