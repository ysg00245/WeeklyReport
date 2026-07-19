# AI 어시스턴트를 위한 안내

이 파일은 Claude Code 등 AI 코딩 도구가 이 저장소를 처음 열었을 때 자동으로 읽는 문서입니다.
사람이 읽어도 좋지만, **"이 프로젝트 파악해줘"** 라고 물었을 때 AI가 빠르고 정확하게
답할 수 있도록 쓰여 있습니다.

더 깊은 내용은 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)(구조·데이터 모델)와
[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)(반드시 지켜야 할 규칙)를 참고하세요.

---

## 이 프로젝트가 하는 일

사내 **주간보고** 웹앱입니다. 흐름은 이렇습니다.

```
구성원이 주간보고 작성
      ↓
팀장이 팀 전체를 AI로 요약
      ↓
그 요약 + 팀장 본인 보고를 합쳐 "최종 취합본" 생성
      ↓
상위 조직장에게 [보고]
      ↓
상위 조직장이 승인 / 보완요청(코멘트)  → 실시간 알림으로 팀장에게 전달
```

사용자는 **회사 직원**이고, 로그인은 사번·이메일이 아니라 **이름 선택 + PIN 4자리**입니다.
사내 도구라 마찰을 최대한 줄인 설계입니다.

## 기술 구성

- **백엔드**: FastAPI + SQLAlchemy(async). 진입점 `main.py`
- **DB**: PostgreSQL 또는 SQLite. `DATABASE_URL` 유무로 자동 전환 (스키마는 동일)
- **프론트**: 바닐라 JS + CSS. **빌드 도구가 없습니다.** `static/` 을 그대로 서빙
- **실시간**: WebSocket(`/ws`) + Web Push
- **AI**: Anthropic Claude API (`routers/ai.py`)

프론트에 번들러·프레임워크가 없는 것은 의도된 선택입니다. 파일을 고치면 새로고침으로 바로 확인됩니다.
**React·Vue 등으로 바꾸자고 먼저 제안하지 마세요.**

## 실행하기

```bash
python -m venv venv && venv\Scripts\activate      # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                              # ADMIN_PW, SYSTEM_ADMIN_PW 만 채워도 실행됨
python -m uvicorn main:app --reload --port 8000
```

`DATABASE_URL` 을 비워두면 SQLite 파일로 동작합니다. 테이블은 첫 실행 시 자동 생성되므로
별도 마이그레이션 명령이 없습니다.

## 파일 지도

```
main.py              FastAPI 앱 · WebSocket 엔드포인트 · 스케줄러 · 정적 캐시 미들웨어
database.py          엔진/세션 생성 + 테이블 생성 + 컬럼 마이그레이션 (엔진별 분기)
models.py            Pydantic 모델
deadline.py          마감 시각 계산
ws_manager.py        WebSocket 연결 관리 (인메모리)

routers/
  auth.py            PIN 로그인, 관리자 로그인, 세션 토큰, 결재권자 판정
  members.py         구성원 CRUD
  reports.py         주간보고 CRUD, 상태 변경(보완요청 등)
  ai.py              AI 요약, 최종 취합, 보고 제출·결재
  settings.py        설정, landing-config, bootstrap(진입 통합 API)
  system_admin.py    조직 관리, 전사 구성원, 조직도 CSV
  org_labels.py      조직 호칭 공용 헬퍼 + 한국어 조사 처리
  push.py            Web Push 구독·발송
  permissions.py     마감 후 수정 권한
  teams.py / divisions.py / team_deps.py

static/
  index.html         단일 페이지 (모든 화면이 여기 있음)
  js/                기능별 모듈 — 전역 스코프 공유, import 없음
  css/style.css
```

**화면별 JS 담당**: `app.js`(부팅·WebSocket·라우팅) `auth.js`(로그인) `user.js`(보고 작성)
`admin.js`(관리자 콘솔) `ai.js`(AI 요약·최종취합) `division.js`(상위 조직장 결재)
`system_admin.js`(시스템 관리자) `settings.js` `members.js` `utils.js` `api.js` `pwa.js`

## 반드시 알아야 할 것 5가지

작업 전에 이것만은 읽어주세요. **모르고 고치면 실제로 사고가 났던 항목들**입니다.

### 1. 조직 호칭을 문자열에 직접 쓰지 마세요

"팀장"·"팀원"·"본부"는 회사마다 다릅니다(그룹/유닛/구성원 등). 설정으로 바뀝니다.

```js
orgLabel('leader')                    // ✅
olj('team', '을')                     // ✅ 조사까지 자동 (유닛을 / 본부를)
'팀장에게 보고합니다'                  // ❌ 절대 금지
```

HTML은 `data-ol="{team} 관리"`, 속성은 `data-ol-attr="placeholder:{member} 이름"`.
백엔드는 `get_org_labels(db)` + `josa()`.

### 2. JS/CSS를 고쳤으면 캐시버스터를 올리세요

`/static/*?v=...` 에는 **1년 불변 캐시** 헤더가 붙습니다.
`static/index.html` 의 `?v=` 값을 올리지 않으면 사용자 브라우저에 구버전이 1년간 남습니다.

```html
<script src="/static/js/app.js?v=20260720d"></script>   <!-- 이 값을 올릴 것 -->
```

### 3. DB를 주기적으로 찌르는 코드를 넣지 마세요

`setInterval` 로 DB를 호출하는 keepalive·폴링을 **절대 추가하지 마세요.**
서버리스 PostgreSQL(Neon 등)의 자동 절전이 걸리지 않아 **요금이 폭증합니다.**
실제로 이것 때문에 서비스가 멈춘 적이 있습니다.

첫 요청이 느린 것(콜드스타트)은 "서버를 깨우는 중" 안내 문구로 처리합니다.
WebSocket heartbeat(25초)는 소켓 전용이라 DB를 거치지 않으므로 무관합니다.

### 4. 전역 초기화식에서 `orgLabel()` 을 부르지 마세요

모듈이 로드되는 시점에는 서버에서 호칭이 아직 안 왔습니다. 기본값으로 굳어버립니다.

```js
const NOTES = { title: `${orgLabel('team')} 안내` };   // ❌ 항상 '팀'으로 고정됨
const NOTES = { title: '{team} 안내' };                // ✅ 렌더 시 fillOrgLabels() 로 치환
```

### 5. 단일 인스턴스 전제입니다

WebSocket 연결을 프로세스 메모리(`ws_manager.py`)에 들고 있습니다.
워커나 인스턴스를 늘리면 **일부 사용자에게 실시간 알림이 안 갑니다.**
확장하려면 Redis pub/sub 같은 외부 브로커가 필요합니다.

## 자주 하는 작업

| 하려는 것 | 건드릴 곳 |
|---|---|
| 보고 양식에 항목 추가 | 관리자 콘솔의 양식 설정(DB), 코드 수정 불필요 |
| AI 요약 문구·형식 변경 | 시스템 관리자 콘솔 → 프롬프트 탭 (DB 우선, 코드는 기본값) |
| 새 API 추가 | `routers/` 에 추가 후 `main.py` 에서 include |
| 화면 문구 수정 | `static/index.html` (+ 호칭은 `data-ol`) → **캐시버스터 올리기** |
| 새 컬럼 추가 | `database.py` 의 **PostgreSQL·SQLite 마이그레이션 목록 양쪽 모두** |
| 실시간 알림 추가 | 서버 `manager.broadcast()` + `app.js` 의 `socket.onmessage` 분기 |

⚠️ **AI 프롬프트는 DB 값이 코드 기본값보다 우선합니다.** 코드의 `DEFAULT_*` 만 고치면
이미 DB에 값이 있는 배포에서는 반영되지 않습니다.

## 이 프로젝트에서 하지 말아야 할 것

- 프론트엔드 프레임워크 도입 제안 (빌드 없는 구조가 의도된 선택)
- DB 폴링·keepalive 추가 (위 3번)
- 조직 호칭·회사명 하드코딩 (위 1번)
- `docs/` 없이 큰 구조 변경 — 변경 이유를 문서에 남겨주세요
- 캐시버스터 갱신 누락 (위 2번)

## 더 읽을거리

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 데이터 모델, 인증 계층, 요청 흐름, 실시간 설계
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — 코딩 규칙과 그 규칙이 생긴 이유(사고 이력)
- [`README.md`](README.md) — 설치·배포·커스터마이즈
