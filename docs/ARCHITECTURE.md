# 구조 문서

이 프로젝트가 어떻게 짜여 있는지 설명합니다. 코드를 고치기 전에 읽으면
"왜 이렇게 되어 있지?" 하는 의문 대부분이 여기서 풀립니다.

- 처음이라면 [`../CLAUDE.md`](../CLAUDE.md) 를 먼저 보세요 (요약 + 필수 주의사항)
- 지켜야 할 규칙과 그 이유는 [`CONVENTIONS.md`](CONVENTIONS.md)

---

## 1. 조직 모델

3단 계층입니다. 이름은 설정으로 바뀌지만 구조는 고정입니다.

```
divisions (상위 조직 — 기본 호칭 "본부")
   └── teams (팀/유닛)
          └── members (구성원)
```

| 테이블 | 핵심 컬럼 | 설명 |
|---|---|---|
| `divisions` | `head_name` | 상위 조직장 이름. 결재 권한 판정에 사용 |
| `teams` | `leader_name` | 팀장 이름. **결재권자 판정의 기준** |
| | `admin_pw_hash` | **팀마다 다른** 관리자 비밀번호 |
| | `report_admin_primary/secondary` | 주간보고 담당자 정/부 |
| `members` | `team_id` + `name` | 이 조합이 사실상의 식별자 |
| | `position` / `title` | 직급(과장·차장) / 직책(팀장·본부장) — **다른 개념** |
| | `is_active` | 퇴사 = soft delete. 보고 이력은 보존 |
| | `is_visible` / `is_report_target` | 로그인 목록 노출 / 집계 대상 — 별개 플래그 |

### 겸직은 행을 2개 만듭니다

한 사람이 두 팀에 속하면 `members` 에 행이 2개 생깁니다. `(team_id, name)` 이 유일 키라
같은 이름이 팀별로 존재할 수 있습니다. PIN·보고 이력도 소속별로 분리됩니다.

**주의**: 이 때문에 "이름으로 사람 찾기"는 틀린 접근입니다. 항상 `team_id` 와 함께 조회하세요.

### 상위 조직 직속 구성원

팀에 속하지 않고 상위 조직에 직접 속한 사람(조직장 등)을 위해, `divhq-<slug>` 형태의
**컨테이너 팀**을 자동 생성합니다. 이 팀은 팀 목록·집계·보고 대상에서 제외되며,
로그인 화면에서는 팀 카드가 아니라 **사람 카드**로 보입니다.

## 2. 인증 — 3개 계층

| 계층 | 인증 수단 | 권한 |
|---|---|---|
| 시스템 관리자 | `SYSTEM_ADMIN_PW` (환경변수) | 전 조직 관리 |
| 팀 관리자 | `teams.admin_pw_hash` (**팀별로 다름**) | 그 팀의 운영 기능 |
| 구성원 | PIN 4자리 (`pins` 테이블) | 본인 보고 작성 |

세션은 `sessions` 테이블에 토큰으로 저장되고 `X-Auth-Token` 헤더로 전달됩니다. 7일 만료.

### 결재 권한은 플래그가 아닙니다

"이 사람이 결재권자인가?"는 별도 컬럼이 아니라 **이름 비교**로 판정합니다.

```
PIN 로그인한 사람의 이름 == teams.leader_name        → 팀 결재권자
PIN 로그인한 사람의 이름 == divisions.head_name      → 상위 조직장
```

`routers/auth.py` 의 `is_report_approver()` 를 보세요.
**팀장을 바꾸려면 `teams.leader_name` 을 바꾸면 됩니다.** 권한 테이블이 따로 없습니다.

## 3. 멀티 조직 (한 인스턴스, 여러 팀)

모든 데이터 테이블에 `team_id` 가 있습니다. 요청이 어느 팀인지는 **URL 과 헤더**로 정해집니다.

```
브라우저 URL:  /?team=<slug>
API 요청 헤더: X-Team-Slug: <slug>
       ↓
routers/team_deps.py 의 get_team_id() 가 slug → team_id 변환
       ↓
각 라우터가 tid 를 받아 WHERE team_id = :tid 로 격리
```

`settings` 테이블에서 `team_id = 0` 은 **전역 설정**을 의미합니다
(조직 호칭, 브랜드, 멀티팀 활성화 여부 등).

## 4. 주요 흐름

### 4-1. 첫 진입 (성능이 중요한 경로)

```
GET /api/settings/bootstrap   ← 단 1회
   → { landing, settings, members } 를 한 번에 반환
```

예전에는 `landing-config` + `settings` + `members` 를 3번 왕복했습니다. 서버리스 DB는
왕복 1회에 1초 가까이 걸려서 진입이 느렸고, 이를 1회로 합쳤습니다.

**폴백이 있습니다.** 부트스트랩이 실패하면 프론트가 기존 3개 API를 개별 호출합니다.
`static/js/app.js` 의 `_bootPromise` 를 보세요.

### 4-2. 보고 → 결재

```
1. 구성원         POST /api/reports/{name}          보고 저장
2. 팀장           POST /api/ai/summarize            팀 전체 AI 요약
3. 팀장           (최종 취합 모달에서 병합·편집)
4. 팀장           POST /api/ai/final-report/submit  상위 조직장에게 보고
5. 상위 조직장     POST /api/ai/final-report/review  승인 또는 보완요청
                        ↓
                  WebSocket + Web Push 로 팀장에게 즉시 통지
```

`final_reports` 테이블의 `status` 는 `submitted`(대기) / `approved`(승인) /
`needs_revision`(보완요청) 셋 중 하나입니다. 팀장이 다시 보고하면 `submitted` 로 리셋됩니다.

### 4-3. 실시간 알림

```
서버:  manager.broadcast({ type, team_slug, ... })   ← ws_manager.py
         ↓ 모든 연결에 전송 (라우팅 없음)
클라이언트: socket.onmessage 에서 type 별 분기 + team_slug 로 본인 팀인지 필터
```

**전역 브로드캐스트라 페이로드에 `team_slug` 를 반드시 넣어야 합니다.**
없으면 다른 팀 사용자에게도 알림이 갑니다(동명이인이면 오작동까지).

WebSocket 신뢰성 장치:
- 로그인 성공 직후 연결 (부팅 시점엔 토큰이 없어 연결이 생략됨)
- 25초 heartbeat — 프록시의 유휴 연결 종료 방지. **소켓 전용이라 DB를 안 거칩니다**
- 탭 복귀·네트워크 복구 시 죽은 소켓 재연결
- 재연결 성공 시 화면 1회 재동기화 (끊긴 동안 놓친 알림 따라잡기)
- 지수 백오프 (1s → 30s)

**설계 원칙**: WebSocket은 UX 보조입니다. 끊겨도 화면을 다시 그리면 DB 기준으로 정확한
상태가 나오고, 알림 자체는 Web Push가 백업합니다.

## 5. 데이터베이스

### 엔진 전환

`DATABASE_URL` 유무로 PostgreSQL / SQLite 가 결정됩니다(`database.py` 상단).
**두 엔진의 스키마는 동일합니다.** 테이블 정의는 한 곳에서 공유하고 타입만 분기합니다.

```python
id  {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"}
```

### 마이그레이션

ORM 마이그레이션 도구(Alembic 등)를 쓰지 않습니다. `database.py` 의 `init_db()` 가
앱 시작 때마다 실행되며:

1. `CREATE TABLE IF NOT EXISTS` — 신규 설치용
2. 컬럼 추가 목록을 순회하며 `ALTER TABLE ADD COLUMN` — 기존 DB 업그레이드용

⚠️ **2번 목록이 PostgreSQL용·SQLite용으로 나뉘어 있습니다.** 한쪽만 고치면
신규 설치에서는 1번이 덮어서 증상이 안 보이고, **구버전 DB를 업그레이드할 때만** 터집니다.
컬럼을 추가할 때는 반드시 양쪽 목록에 모두 넣으세요.

### 스키마 요약

```
divisions            상위 조직
teams                팀 (+ 팀장, 팀별 관리자 비번, 주보 담당자)
members              구성원 (+ 직급/직책, 재직여부, 노출·집계 플래그)
pins                 PIN 해시 (team_id + member_name)
sessions             인증 토큰
reports              주간보고 본문 (+ 상태, 커스텀 필드 JSON)
summaries            AI 요약 결과 (주차 + 유형별)
final_reports        최종 취합 보고본 + 결재 상태·코멘트
settings             설정 (team_id=0 은 전역)
late_permissions     마감 후 수정 권한
push_subscriptions   Web Push 구독 (환경별 분리)
```

## 6. 프론트엔드

**빌드 도구가 없습니다.** `static/js/*.js` 를 `<script>` 로 순서대로 로드하며
모든 함수가 전역 스코프를 공유합니다. `import`/`export` 가 없습니다.

- 화면은 `static/index.html` 하나에 전부 들어 있고, `showPage(id)` 로 전환합니다
- 파일 간 의존은 암묵적입니다 — `utils.js` 의 함수를 다른 파일이 그냥 호출합니다
- 새 파일을 추가하면 `index.html` 의 `<script>` 목록에 **로드 순서를 고려해** 넣으세요

### 조직 호칭 시스템

회사마다 "팀장/팀원"을 다르게 부르므로 런타임에 치환합니다.

```
설정(DB) → landing-config → setOrgLabels() → ORG_LABELS 갱신 → applyOrgLabels()
                                                                    ↓
                                            data-ol / data-ol-attr 요소 텍스트 주입
```

한국어 조사(을/를, 이/가)는 받침에 따라 달라지므로 `josa()` 가 자동 선택합니다.
자세한 사용법은 [`CONVENTIONS.md`](CONVENTIONS.md) 를 보세요.

## 7. 의도적으로 하지 않은 것들

"왜 이게 없지?" 싶은 것들의 이유입니다.

| 없는 것 | 이유 |
|---|---|
| 프론트 빌드 파이프라인 | 파일 고치고 새로고침하면 끝. 사내 도구 규모에 번들러는 과함 |
| ORM 모델 클래스 | 원시 SQL 이 더 명확하다고 판단. `models.py` 는 Pydantic 응답 모델만 |
| 주기적 DB 폴링 | 서버리스 DB 자동 절전을 방해해 요금이 폭증. 실제 사고 있었음 |
| WebSocket 외부 브로커 | 단일 인스턴스 전제. 확장 시 Redis pub/sub 필요 |
| 자동화 테스트 | 미비 상태. 기여를 환영합니다 |
| 이메일 로그인 | 사내 도구라 PIN 으로 마찰 최소화 |
