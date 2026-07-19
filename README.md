# Weekly Report

주간보고를 **작성 → AI 요약 → 최종 취합 → 상위 조직 결재**까지 한 흐름으로 처리하는 사내용 웹앱입니다.

스프레드시트로 주간보고를 취합하던 팀을 위해 만들었습니다. 구성원이 보고를 올리면 AI가 팀 단위로 요약하고,
팀장이 그 요약과 본인 보고를 합쳐 상부 보고서를 만든 뒤 상위 조직장에게 보고하면, 승인·보완요청이
실시간 알림으로 되돌아옵니다.

- **PIN 4자리 로그인** — 사번·이메일 없이 이름 선택 + PIN. 사내 도구에 맞춘 낮은 마찰
- **AI 요약** — 구성원별 / 프로젝트별 / 팀 전체. 출력 형식까지 프롬프트로 조정 가능
- **계층 보고** — 팀장이 [보고] → 상위 조직장이 열람·승인·보완요청(코멘트)
- **실시간 알림** — WebSocket + Web Push(PWA). 보완요청은 즉시 도착
- **조직 관리** — 조직도 트리, 일괄 인사이동·겸직·퇴사, CSV 내보내기/가져오기
- **멀티 조직** — 한 인스턴스에서 여러 상위조직/팀 운영, 조직별 관리자 분리
- **호칭 커스터마이즈** — 본부/팀/팀원을 그룹/유닛/구성원 등 원하는 명칭으로 (아래 참조)

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 백엔드 | FastAPI, SQLAlchemy(async), APScheduler |
| DB | PostgreSQL 또는 SQLite — 코드 변경 없이 전환 |
| 프론트 | 바닐라 JS + CSS (빌드 도구·프레임워크 없음) |
| 실시간 | WebSocket, Web Push(VAPID) |
| AI | Anthropic Claude API |

프론트에 빌드 단계가 없습니다. `static/` 을 그대로 서빙하므로 클론 후 바로 수정·확인할 수 있습니다.

## 빠르게 실행하기

```bash
git clone <this-repo>
cd weekly-report

python -m venv venv
venv\Scripts\activate          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env           # 값 채우기 (아래 표 참조)
python -m uvicorn main:app --reload --port 8000
```

`http://127.0.0.1:8000` 으로 접속합니다. `DATABASE_URL` 을 비워두면 SQLite 파일로 동작하므로
DB 없이도 바로 띄워볼 수 있습니다. 테이블은 첫 실행 시 자동 생성됩니다.

관리자 콘솔은 화면 우측 상단 자물쇠 아이콘 → `ADMIN_PW`,
시스템 관리자 콘솔은 같은 자리에서 `SYSTEM_ADMIN_PW` 로 진입합니다.
조직·구성원은 시스템 관리자 콘솔에서 만들거나 조직도 CSV로 한 번에 넣을 수 있습니다.

## 환경 변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `DATABASE_URL` | | PostgreSQL 접속 URL. **비우면 SQLite** 로 동작 |
| `DB_PATH` | | SQLite 파일 경로 (기본 `weekly_report.db`) |
| `ADMIN_PW` | ✅ | 팀 관리자 기본 비밀번호. 팀별 비밀번호는 콘솔에서 따로 지정 가능 |
| `SYSTEM_ADMIN_PW` | ✅ | 시스템 관리자(전 조직 관리) 비밀번호 |
| `ANTHROPIC_API_KEY` | | AI 요약용. 없으면 요약 기능만 비활성 |
| `VAPID_SUB` / `VAPID_EMAIL` | | Web Push 발신자 정보 |
| `ENV` | | `prod` 로 두면 `/docs` 등 OpenAPI 문서 비활성 |

VAPID 키 쌍은 최초 실행 시 자동 생성되어 DB에 저장됩니다.

## 조직 호칭 바꾸기

기본 호칭은 **본부 / 팀 / 팀원 / 팀장 / 본부장** 입니다. 회사 체계에 맞게 바꿀 수 있습니다.

시스템 관리자 콘솔 → **조직 관리 → 조직 호칭** 에서 5개 값을 입력하면 화면 전체에 즉시 반영됩니다.
예를 들어 `그룹 / 유닛 / 구성원 / 유닛장 / 그룹장` 으로 넣으면 버튼·안내문·알림·에러 메시지까지 모두 바뀝니다.

조사(을/를, 이/가)도 받침에 따라 자동으로 맞춰집니다 — `유닛을` / `본부를` 처럼요.

### 코드에 문구를 추가할 때

호칭을 **문자열에 직접 쓰지 마세요.** 하나만 놓쳐도 한 화면에서 호칭이 섞입니다.

```js
// JS
orgLabel('leader')            // → 팀장 / 유닛장
olj('team', '을')             // → 팀을 / 유닛을  (조사 자동)

// 정적 HTML — textContent 치환
<div data-ol="{team} 관리">팀 관리</div>
<div data-ol="{team:을} 선택하세요">팀을 선택하세요</div>

// 속성(placeholder·title 등)
<input data-ol-attr="placeholder:{member} 이름" placeholder="팀원 이름">
```

```python
# 백엔드 — 사용자에게 toast 로 보이는 메시지만 대상
from routers.org_labels import get_org_labels, josa
raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
```

두 가지 함정이 있습니다.

1. **전역 초기화식에서 `orgLabel()` 을 부르지 마세요.** 모듈 로드 시점에는 서버 호칭이 아직
   도착하지 않아 기본값으로 굳습니다. 토큰(`{team}`)으로 저장했다가 렌더 시 `fillOrgLabels()` 로 치환하세요.
2. **`<b>`·`<code>` 가 섞인 문단에 `data-ol` 을 붙이면 마크업이 사라집니다.** `textContent` 를
   덮어쓰기 때문입니다. 치환할 텍스트만 `<span data-ol>` 으로 감싸세요.

## 브랜드(제품명·회사명) 바꾸기

기본값은 회사명 없이 제품명(`Weekly Report`)만 노출됩니다. 배포처 정보를 넣으려면
`settings` 테이블에 `team_id = 0`, `key = 'brand'` 로 아래 JSON을 저장하세요.

```json
{ "product": "Weekly Report", "company": "회사명", "tagline": "부제" }
```

헤더·로그인 화면·푸터 저작권 표기에 반영됩니다. 값이 비면 구분자까지 함께 사라지므로
`© 2026  · ` 같은 찌꺼기가 남지 않습니다.

### 로고 교체

`static/img/` 에 들어있는 아이콘은 **어느 조직에도 속하지 않는 기본 아이콘**입니다.
자사 로고로 바꾸려면 같은 파일명·같은 크기로 덮어쓰면 됩니다.

| 파일 | 크기 | 용도 |
|---|---|---|
| `app-icon.png` | 96×96 | 헤더·로그인 화면·로딩 화면 |
| `app-icon-192.png` / `app-icon-512.png` | 192, 512 | PWA 설치 아이콘, iOS 홈 화면 |
| `app-icon-192-maskable.png` / `app-icon-512-maskable.png` | 192, 512 | Android adaptive icon |
| `*-dev.png` | 동일 | 개발 환경용 (설치된 앱을 운영과 구분) |

**maskable 아이콘은 여백을 넉넉히 두세요.** Android 가 원형·둥근사각형 등으로 잘라내기 때문에,
도형이 가장자리까지 차 있으면 잘립니다. 중앙 80% 안에 넣는 것을 권장합니다.

파일명을 바꾸고 싶다면 `static/manifest.json`, `static/manifest.dev.json`, `static/sw.js`,
`static/index.html` 의 경로도 함께 고쳐야 합니다. 그냥 덮어쓰는 쪽이 간단합니다.

교체 후에는 `static/index.html` 의 캐시버스터(`?v=`)를 올려야 기존 사용자에게도 새 로고가 보입니다.
이미 앱을 설치한 사용자는 홈 화면 아이콘이 OS 캐시에 남아 있어, 재설치해야 바뀔 수 있습니다.

## 어떤 DB를 써야 하나요

**SQLite 와 PostgreSQL 은 같은 스키마를 만듭니다.** 코드가 엔진에 맞춰 타입만 바꿔 생성하므로,
`DATABASE_URL` 만 바꾸면 됩니다. 나중에 SQLite → PostgreSQL 로 옮겨도 테이블 구조는 그대로입니다.

| | SQLite | PostgreSQL |
|---|---|---|
| 설정 | `DATABASE_URL` 비워두기 | `DATABASE_URL` 지정 |
| 데이터 위치 | 서버의 파일 1개 | 별도 DB 서버 |
| 적합한 경우 | 로컬 개발, 사내 서버에 직접 설치 | 클라우드 배포(Render 등) |
| 주의 | 컨테이너 PaaS 에서는 **재배포 시 파일이 사라짐** | 없음 |

**사내 서버가 있다면** SQLite로 충분합니다. 수십~수백 명 규모의 주간보고 정도는 문제없고,
백업도 파일 하나만 복사하면 됩니다.

**사내 서버가 없다면** 아래 클라우드 배포를 따라가세요. 이때 **SQLite 를 쓰면 안 됩니다.**
Render 같은 컨테이너 기반 서비스는 재배포·재시작할 때마다 디스크가 초기화돼서
**작성된 보고가 전부 사라집니다.** 반드시 PostgreSQL 을 붙이세요.

## 클라우드 배포 (사내 서버가 없는 경우)

Render(웹 서버) + Neon(PostgreSQL) 조합입니다. 둘 다 무료 플랜으로 시작할 수 있습니다.

### 1. 데이터베이스 만들기 (Neon)

1. [neon.tech](https://neon.tech) 가입 → **Create project**
2. 리전은 사용자와 가까운 곳으로 (한국이면 `Asia Pacific (Singapore)`)
3. 생성되면 **Connection string** 을 복사합니다. 이런 형태입니다:
   ```
   postgresql://<user>:<password>@<host>.neon.tech/<db>?sslmode=require
   ```
4. **Settings → Compute → Autosuspend** 를 켜 둡니다(기본 5분). 아무도 안 쓰는 시간에
   DB가 잠들어 요금이 거의 안 나옵니다.
5. **Settings → Billing → Spending limit** 에 상한을 걸어두세요. 실수로 요금이 폭주하는 것을 막습니다.

> Neon 이 아니어도 됩니다. Supabase, Railway, AWS RDS 등 PostgreSQL 이면 무엇이든 동작합니다.
> 접속 URL 형식만 같으면 됩니다.

### 2. 웹 서버 배포 (Render)

1. [render.com](https://render.com) 가입 → **New → Web Service** → 이 저장소를 fork 한 뒤 연결
2. 설정값:
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: Free 또는 Starter
   (저장소에 `render.yaml`·`Procfile` 이 있어 자동으로 잡히는 경우도 많습니다)
3. **Environment** 탭에서 환경 변수를 등록합니다:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | 1단계에서 복사한 Neon 접속 URL |
   | `ADMIN_PW` | 팀 관리자 비밀번호 (직접 정하기) |
   | `SYSTEM_ADMIN_PW` | 시스템 관리자 비밀번호 (더 강하게) |
   | `ANTHROPIC_API_KEY` | AI 요약을 쓸 경우만 |
   | `ENV` | `prod` |
   | `VAPID_SUB` | 배포 후 받은 주소 (예: `https://myapp.onrender.com`) |

4. 배포가 끝나면 `https://<서비스명>.onrender.com` 으로 접속됩니다.
   테이블은 첫 실행 때 자동 생성되므로 별도 마이그레이션이 필요 없습니다.

### 3. 초기 설정

1. 우측 상단 자물쇠 아이콘 → `SYSTEM_ADMIN_PW` 로 시스템 관리자 콘솔 진입
2. **조직 관리** 에서 조직·팀을 만들고 구성원을 추가 (또는 조직도 CSV 로 한 번에)
3. 필요하면 **조직 호칭**·**브랜드** 설정 (위 항목 참조)
4. 구성원은 첫 로그인 시 본인이 PIN 4자리를 등록합니다

### 무료 플랜에서 알아둘 것

- **Render Free 는 15분 유휴 후 잠듭니다.** 다음 접속 때 깨어나는 데 30초~1분 걸립니다.
  실사용 팀이라면 Starter 플랜을 권합니다.
- **Neon 도 자동 절전됩니다.** 첫 요청이 몇 초 느린데, 앱이 "서버를 깨우는 중" 안내를 띄웁니다.
- ⚠️ **절전을 막으려고 주기적으로 DB를 찌르는 코드(keepalive)를 넣지 마세요.**
  절전이 안 걸려서 요금이 급증합니다. 이 앱이 주기적 DB 폴링을 넣지 않은 이유입니다.
  느린 첫 요청은 안내 문구로 처리하는 편이 훨씬 저렴합니다.

### 백업

- **PostgreSQL**: Neon 등 관리형 서비스는 자동 백업·시점 복구를 제공합니다. 설정에서 켜 두세요.
- **SQLite**: `weekly_report.db` 파일을 주기적으로 복사하면 됩니다.

### 정적 파일 캐시 규칙

`/static/*?v=...` 요청에는 1년 불변 캐시 헤더가 붙습니다. **JS/CSS 를 고쳤으면
`static/index.html` 의 `?v=` 값을 반드시 올려야 합니다.** 올리지 않으면 사용자 브라우저에
구버전이 계속 남습니다.

## 프로젝트 구조

```
main.py              FastAPI 앱, WebSocket, 스케줄러, 정적 캐시 미들웨어
database.py          엔진·세션·마이그레이션 (PostgreSQL/SQLite 양쪽)
routers/
  auth.py            PIN·관리자 인증, 세션 토큰
  members.py         구성원 CRUD
  reports.py         주간보고 CRUD, 상태 변경
  ai.py              AI 요약, 최종 취합, 결재
  settings.py        설정, landing-config, bootstrap
  system_admin.py    조직 관리, 전사 구성원, 조직도 CSV
  org_labels.py      조직 호칭 공용 헬퍼
  push.py            Web Push
static/
  index.html         단일 페이지 (모든 화면)
  js/                기능별 모듈 (빌드 없음)
  css/style.css
```

## 설계 메모

- **인증 계층이 3개입니다.** 시스템 관리자(전 조직) / 팀 관리자(팀별 비밀번호) / 구성원(PIN).
  결재 권한은 별도 플래그가 아니라 "이 사람이 이 팀의 팀장인가"로 판정합니다.
- **겸직은 행을 2개 만듭니다.** 한 사람이 두 팀에 속하면 `(team_id, name)` 조합으로 각각 존재하며,
  PIN 과 보고 이력도 소속별로 분리됩니다.
- **WebSocket 은 UX 보조입니다.** 끊겨도 화면을 다시 그리면 DB 기준으로 정확한 상태가 나오도록
  설계했고, 실시간 알림은 Web Push 가 백업합니다.
- **단일 인스턴스 전제입니다.** WebSocket 연결을 메모리에 들고 있으므로, 워커·인스턴스를 늘리려면
  Redis pub/sub 같은 외부 브로커가 필요합니다.
- **조직도 CSV 는 위치 기반으로 파싱합니다.** 헤더의 앞 4열 이름은 조직 호칭에 따라 달라지므로
  검증하지 않고, 열 개수와 뒤쪽 고정열로 형식을 확인합니다.

## 더 읽을거리

코드를 고치기 전에 읽으면 좋습니다. AI 어시스턴트에게 "이 프로젝트 파악해줘" 라고
물을 때도 이 문서들을 근거로 답하게 됩니다.

| 문서 | 내용 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | **AI 온보딩용 요약** — 프로젝트 개요, 파일 지도, 필수 주의사항 5가지 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 조직 모델, 인증 계층, 요청 흐름, 실시간 설계, 의도적으로 안 넣은 것들 |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | 코딩 규칙 12가지와 **그 규칙이 생긴 이유**(대부분 실제 사고 이력) |

`CLAUDE.md` 는 Claude Code 가 저장소를 열 때 자동으로 읽습니다. 다른 AI 도구를 쓴다면
그 파일을 먼저 읽혀주세요.

## 기여

이슈·PR 환영합니다. 코드를 고치기 전에 [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) 를
한 번 읽어주세요 — 겉보기엔 이상하지만 이유가 있는 규칙들이 정리되어 있습니다.

자동화 테스트가 아직 없습니다. 이 부분 기여를 특히 환영합니다.

## 라이선스

MIT — 자유롭게 사용·수정·재배포할 수 있습니다. 자세한 내용은 [`LICENSE`](LICENSE),
한글 참고 번역은 [`LICENSE.ko.md`](LICENSE.ko.md) 를 보세요.
