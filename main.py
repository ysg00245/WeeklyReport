import os
from dotenv import load_dotenv

# .env 로드. 시스템 환경변수(Render 등)가 이미 설정돼 있으면 load_dotenv 가 덮어쓰지 않는다.
load_dotenv()

from fastapi import FastAPI, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import json
import os
from datetime import datetime

from database import init_db, get_db
from routers import members, reports, auth, ai, permissions, settings, push, teams, divisions, system_admin
from routers.auth import require_auth
from ws_manager import manager
from fastapi import WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text

scheduler = AsyncIOScheduler()

# 운영 환경에서는 OpenAPI 문서(/docs, /redoc, /openapi.json) 비활성화
_is_prod = os.getenv("ENV", "").lower() in ("prod", "production") or os.getenv("RENDER") is not None
app = FastAPI(
    title="주간보고 시스템",
    docs_url=None if _is_prod else "/docs",
    redoc_url=None if _is_prod else "/redoc",
    openapi_url=None if _is_prod else "/openapi.json",
)

# ── 관리자 비밀번호 검증 ─────────────────────────────────
# 이 코드는 공개 저장소라 기본값이 공격자에게도 알려져 있다.
# 운영(ENV=prod / Render)에서는 경고만 하지 말고 기동 자체를 막는다.
_WEAK_PW = {"1234", "admin", "password", "changeme", "test", ""}
_admin_pw = os.getenv("ADMIN_PW", "1234")
_sys_admin_pw = os.getenv("SYSTEM_ADMIN_PW", "")

if _is_prod:
    _weak = [n for n, v in (("ADMIN_PW", _admin_pw), ("SYSTEM_ADMIN_PW", _sys_admin_pw))
             if v.strip().lower() in _WEAK_PW]
    if _weak:
        raise RuntimeError(
            f"[SECURITY] {', '.join(_weak)} 가 비어 있거나 기본/취약한 값입니다. "
            "운영 환경에서는 기동할 수 없습니다. 환경변수에 강력한 비밀번호를 설정하세요."
        )
elif _admin_pw.strip().lower() in _WEAK_PW or not _sys_admin_pw.strip():
    # 이모지를 쓰지 않는다 — Windows 기본 콘솔(cp949)에서 UnicodeEncodeError 로 기동이 죽는다.
    print("[SECURITY] 관리자 비밀번호가 기본값이거나 비어 있습니다. "
          "로컬 개발에서는 허용되지만 운영 배포 전 반드시 변경하세요.")

# 정적 파일 마운트
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── 정적 자산 캐시 헤더 (32차 최적화) ──
# JS/CSS 는 전부 ?v=버스터로 참조하므로(캐시버스터 규칙 필수) 버스터가 있으면 불변 캐시,
# 없는 자산(아이콘 등)은 1시간. 매 페이지 로드마다 12개 파일이 304 재검증 왕복하던 것 제거.
# /sw.js, /manifest.json 은 별도 루트 라우트라 여기 안 걸림 (manifest 는 자체 no-store 유지).
@app.middleware("http")
async def static_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") and "cache-control" not in response.headers:
        if "v" in request.query_params:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=3600"
    return response

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(default="")):
    """WebSocket 엔드포인트 — 토큰 검증 후 연결 수락"""
    # 토큰 검증
    if not token:
        await websocket.close(code=1008, reason="Auth required")
        return
    from database import AsyncSessionLocal, now_sql
    async with AsyncSessionLocal() as db:
        res = await db.execute(text(
            f"SELECT identity FROM sessions WHERE token = :t AND expires_at > {now_sql}"
        ), {"t": token})
        if not res.mappings().first():
            await websocket.close(code=1008, reason="Invalid token")
            return

    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ── PWA 설치 가용 여부 헬퍼 (시스템 관리자 토글) ──
# 변경 이력 (2026-05-14, 16차): 클라이언트 측 promo / 환경설정 가이드를 _saPwaInstallEnabled 로 차단하지만
# Chrome 메뉴 (⋮ → 홈 화면에 추가) 는 Chrome 자체 기능이라 우리 코드로 못 막음.
# → 서버측에서 manifest 자체를 차단 (404) + index.html 의 <link rel="manifest"> 제거 → installability 미충족 → Chrome 메뉴 "앱 설치" 항목 자체 안 뜸.
# 이미 설치된 사용자는 영향 없음 (standalone 은 새 manifest fetch 안 함). SW/푸쉬도 영향 없음.
async def _is_pwa_install_enabled(db: AsyncSession) -> bool:
    """settings.pwa_install_enabled 가 false 면 PWA 설치 가용 안 함. default True."""
    r = await db.execute(text("SELECT value FROM settings WHERE key='pwa_install_enabled'"))
    row = r.fetchone()
    if not row:
        return True
    val = str(row[0] or "").lower().strip()
    return val in ("true", "1", "yes")  # settings.py 의 landing-config 로직과 일치


# GET + HEAD 둘 다 받아야 Chrome 일부 버전의 manifest pre-flight 거부 안 함 (405 시 PWA 설치 멈춤 사례).
@app.api_route("/manifest.json", methods=["GET", "HEAD"])
async def get_manifest():
    """
    PWA manifest. 개발/운영 환경에 따라 dev/prod manifest 반환.
    Cache-Control 강제 — Chrome 이 manifest 를 적극 캐시해서 갱신이 안 되는 사례 다수 보고됨.
    FileResponse 대신 raw Response 로 헤더 확실히 적용 + media_type 보장.
    GET/HEAD 모두 받음 (HEAD 거부 시 Chrome PWA install 다이얼로그가 멈춤).
    pwa_install_enabled=false 면 404 → Chrome 의 "앱 설치" 메뉴 자체 안 뜸 (16차).
    """
    from fastapi.responses import Response
    # 시스템 관리자가 PWA 설치 OFF 한 경우 → 404
    from database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        if not await _is_pwa_install_enabled(db):
            raise HTTPException(404, "PWA install is disabled by administrator")

    path = "static/manifest.json" if _is_prod else "static/manifest.dev.json"
    with open(path, "rb") as f:
        content = f.read()
    return Response(
        content=content,
        media_type="application/manifest+json",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

@app.api_route("/sw.js", methods=["GET", "HEAD"])
async def get_sw():
    # SW 는 항상 재검증 — 새 배포의 SW 갱신이 브라우저 캐시에 막히지 않도록
    return FileResponse("static/sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})

# ── 마감 전날 12:00 KST Push 알림 스케줄러 ──
async def _send_deadline_for_team(db, team_id: int, team_name: str, *, force: bool = False,
                                  at_time: str | None = None) -> dict:
    """팀 1개 처리.

    at_time="HH:MM" — 스케줄 발송. 그 팀의 notify_times 중 (오늘 날짜, 이 시각)에
                      해당하는 항목이 있을 때만 보낸다.
    force=True      — 관리자 수동 트리거. 시각 조건 없이 미제출자에게 즉시 발송.

    반환: {team_id, team_name, sent, no_sub, failed, skipped_reason}
    """
    from deadline import (load_deadline_config, get_deadline_for_week, get_kst_now,
                          normalize_notify_times)
    from routers.push import send_push_to_member
    from datetime import datetime as dt, timedelta as td

    kst_now = get_kst_now()
    year, week, _ = kst_now.isocalendar()
    week_key = f"{year}-W{week:02d}"

    config = await load_deadline_config(db, team_id=team_id)
    info = get_deadline_for_week(week_key, config)
    if not info.get("enabled") or not info.get("deadline_at"):
        return {"team_id": team_id, "team_name": team_name, "sent": 0, "no_sub": 0, "failed": 0,
                "skipped_reason": "마감 설정 비활성"}

    deadline_dt = dt.strptime(info["deadline_at"], "%Y-%m-%d %H:%M:%S")
    hours_until = (deadline_dt - kst_now).total_seconds() / 3600

    # 스케줄 발송: 오늘이 '마감일 + day_offset' 이고 시각이 일치하는 항목을 찾는다.
    matched = None
    if not force:
        today = kst_now.date()
        for nt in normalize_notify_times(config):
            if not nt.get("enabled", True):
                continue
            if nt["time"] != at_time:
                continue
            if (deadline_dt.date() + td(days=nt["day_offset"])) == today:
                matched = nt
                break
        if not matched:
            return {"team_id": team_id, "team_name": team_name, "sent": 0, "no_sub": 0, "failed": 0,
                    "skipped_reason": f"{at_time} 에 예정된 알림 없음"}
        if hours_until <= 0:
            return {"team_id": team_id, "team_name": team_name, "sent": 0, "no_sub": 0, "failed": 0,
                    "skipped_reason": "이미 마감 시각 경과"}

    # 미제출자 조회 (팀 한정 + 노출 + 보고 대상)
    result = await db.execute(text("""
        SELECT m.name FROM members m
        LEFT JOIN reports r ON r.member_name = m.name AND r.week_key = :wk AND r.team_id = m.team_id
        WHERE m.team_id = :tid
          AND COALESCE(m.is_visible, TRUE) = TRUE
          AND COALESCE(m.is_report_target, TRUE) = TRUE
          AND r.id IS NULL
    """), {"wk": week_key, "tid": team_id})
    unsubmitted = [row[0] for row in result.fetchall()]
    if not unsubmitted:
        return {"team_id": team_id, "team_name": team_name, "sent": 0, "no_sub": 0, "failed": 0,
                "skipped_reason": "전원 제출 완료"}

    deadline_label = deadline_dt.strftime("%m월 %d일 %H:%M")
    # 당일/전날 판정은 설정의 day_offset 기준. (시간차로 추정하면 마감 시각을 바꿀 때마다 어긋난다)
    if matched is not None:
        is_day_of = matched["day_offset"] == 0
    else:
        is_day_of = deadline_dt.date() == kst_now.date()   # 수동 트리거
    push_title = "⏰ 주간보고 오늘 마감 알림" if is_day_of else "⏰ 주간보고 마감 전날 알림"
    push_body_prefix = "오늘" if is_day_of else "내일"
    push_tag = "deadline-reminder-day-of" if is_day_of else "deadline-reminder-before"
    sent_total = 0; no_sub_total = 0; failed_total = 0
    for name in unsubmitted:
        r = await send_push_to_member(
            member_name=name,
            title=push_title,
            body=f"{push_body_prefix} {deadline_label}까지 주간보고를 제출해주세요. ({team_name})",
            url="/",
            db=db,
            tag=push_tag,
        )
        if r and r.get("total", 0) == 0:
            no_sub_total += 1
        else:
            sent_total   += r.get("sent", 0)
            failed_total += len(r.get("errors") or [])

    return {"team_id": team_id, "team_name": team_name,
            "sent": sent_total, "no_sub": no_sub_total, "failed": failed_total,
            "skipped_reason": None, "unsubmitted_count": len(unsubmitted)}


async def send_deadline_push_notifications(*, force: bool = False, at_time: str | None = None) -> dict:
    """전체 팀 순회하며 마감 알림 발송.

    at_time="HH:MM" — 스케줄러가 그 시각에 호출. 각 팀은 자기 notify_times 와 대조해 판단.
    force=True      — 관리자 수동 트리거. 시각 조건 무시.
    """
    from database import AsyncSessionLocal

    summary = {"teams_processed": 0, "teams_sent": 0, "total_sent": 0, "total_no_sub": 0, "total_failed": 0, "details": []}
    async with AsyncSessionLocal() as db:
        try:
            # 모든 팀 순회
            teams_r = await db.execute(text("SELECT id, name FROM teams ORDER BY id"))
            teams = teams_r.mappings().all()
            for t in teams:
                try:
                    r = await _send_deadline_for_team(db, t["id"], t["name"], force=force, at_time=at_time)
                    summary["teams_processed"] += 1
                    if r.get("sent", 0) > 0:
                        summary["teams_sent"] += 1
                    summary["total_sent"]   += r.get("sent", 0)
                    summary["total_no_sub"] += r.get("no_sub", 0)
                    summary["total_failed"] += r.get("failed", 0)
                    summary["details"].append(r)
                except Exception as e:
                    print(f"[Scheduler] 팀 {t['name']} 발송 오류: {e}")
                    summary["details"].append({"team_id": t["id"], "team_name": t["name"], "error": str(e)})
            # 이모지 금지 — Windows 기본 콘솔(cp949)에서 UnicodeEncodeError 발생
            print(f"[Scheduler] 마감 알림 완료 — 팀 {summary['teams_processed']}개 처리, "
                  f"발송 {summary['total_sent']} / 구독없음 {summary['total_no_sub']} / 실패 {summary['total_failed']}")
        except Exception as exc:
            import traceback
            print(f"[Scheduler] 오류: {exc}")
            traceback.print_exc()
    return summary

async def _collect_notify_times() -> list[str]:
    """전 팀 설정에서 알림 시각(HH:MM)의 합집합을 구한다.

    이 시각에만 스케줄러가 깨어나므로, 팀이 몇 개든 하루 DB 접근은 '서로 다른 시각의 수' 로 제한된다.
    (매시간 폴링하면 Neon autosuspend 가 걸리지 않아 요금이 급증한다 — database.py 주석 참고)
    """
    from database import AsyncSessionLocal
    from deadline import load_deadline_config, normalize_notify_times, DEFAULT_NOTIFY_TIMES
    times: set[str] = set()
    try:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(text("SELECT id FROM teams"))).fetchall()
            for (tid,) in rows:
                cfg = await load_deadline_config(db, team_id=tid)
                if not cfg.get("enabled", True):
                    continue
                for nt in normalize_notify_times(cfg):
                    if nt.get("enabled", True):
                        times.add(nt["time"])
    except Exception as e:
        print(f"[Scheduler] 알림 시각 수집 실패 — 기본값 사용: {e}")
    if not times:
        times = {x["time"] for x in DEFAULT_NOTIFY_TIMES}
    return sorted(times)


async def refresh_deadline_jobs() -> list[str]:
    """설정된 알림 시각마다 cron 잡을 재등록. 마감 설정이 저장될 때마다 호출된다."""
    for job in scheduler.get_jobs():
        if job.id.startswith("deadline_push"):
            scheduler.remove_job(job.id)
    times = await _collect_notify_times()
    for t in times:
        h, m = map(int, t.split(":"))
        scheduler.add_job(
            send_deadline_push_notifications,
            trigger="cron",
            hour=h, minute=m,
            timezone="Asia/Seoul",
            id=f"deadline_push_{h:02d}{m:02d}",
            kwargs={"at_time": t},
            replace_existing=True,
        )
    print(f"[Scheduler] 마감 알림 시각 등록: {', '.join(times)} (KST)")
    return times


@app.on_event("startup")
async def on_startup():
    await init_db()
    scheduler.start()
    await refresh_deadline_jobs()
    # ⚠️ DB keepalive 루프는 30차에서 제거 — Neon compute 한도 소진(서비스 정지)의 원인.
    #    유휴 시 autosuspend 로 과금을 멈추는 것이 정상 동작이며, 재도입 금지 (database.py 주석 참고).

@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown(wait=False)

@app.get("/", response_class=HTMLResponse)
async def read_root():
    with open(os.path.join("static", "index.html"), encoding="utf-8") as f:
        html = f.read()
    # pwa_install_enabled=false 면 <link rel="manifest"> 라인 제거 → Chrome 의 "앱 설치" 메뉴 자체 안 뜸 (16차)
    from database import AsyncSessionLocal
    import re
    async with AsyncSessionLocal() as db:
        if not await _is_pwa_install_enabled(db):
            html = re.sub(r'<link\s+rel="manifest"[^>]*>\s*', '', html, flags=re.IGNORECASE)
    return html

# ── 데이터 마이그레이션 모델 ──
class ImportData(BaseModel):
    members: list[str]
    roles: dict[str, str]
    positions: dict[str, str]
    projects: dict[str, str] = {}
    sub_roles: dict[str, str] = {}
    sort_orders: dict[str, int] = {}
    pins: dict[str, str]
    db: dict[str, dict[str, dict]]

# ── 데이터 마이그레이션 (내보내기/가져오기) ──
@app.get("/api/export", tags=["migration"])
async def export_data(db: AsyncSession = Depends(get_db), auth: dict = Depends(require_auth)):
    """DB의 모든 데이터를 JSON 형식으로 내보내기 (관리자 전용 — PIN 해시 포함)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 데이터를 내보낼 수 있습니다")
    # 1. Members
    result = await db.execute(text("SELECT name, role, position, project, sub_role, sort_order FROM members"))
    members_rows = result.mappings().all()
    
    members_list = [m["name"] for m in members_rows]
    roles_dict = {m["name"]: m["role"] for m in members_rows}
    positions_dict = {m["name"]: m["position"] for m in members_rows}
    projects_dict = {m["name"]: m["project"] for m in members_rows}
    sub_roles_dict = {m["name"]: m["sub_role"] for m in members_rows}
    sort_orders_dict = {m["name"]: m["sort_order"] for m in members_rows}
    
    # 2. PINs (마이그레이션을 위해 해시값 포함)
    pin_result = await db.execute(text("SELECT member_name, pin_hash FROM pins"))
    pins_dict = {p["member_name"]: p["pin_hash"] for p in pin_result.mappings().all()}
    
    # 3. Reports
    report_result = await db.execute(text("SELECT * FROM reports"))
    all_reports = report_result.mappings().all()
    db_dict = {}
    for r in all_reports:
        wk = r["week_key"]
        if wk not in db_dict: db_dict[wk] = {}
        # custom_data 보정 및 Flattening
        cd = r.get("custom_data", "{}")
        if isinstance(cd, str):
            try: cd = json.loads(cd)
            except: cd = {}

        db_dict[wk][r["member_name"]] = {
            "done": cd.get("done", ""),
            "plan": cd.get("plan", ""),
            "issue": cd.get("issue", ""),
            "note": cd.get("note", ""),
            "sor_cnt": cd.get("sor_cnt", 0),
            "sop_cnt": cd.get("sop_cnt", 0),
            "chg_cnt": cd.get("chg_cnt", 0),
            "custom_data": cd,
            "role": r["role"],
            "position": r["position"],
            "project": r["project"],
            "sub_role": r["sub_role"],
            "status": r["status"],
            "time": r["submitted_at"]
        }
        
    return {
        "members": members_list,
        "roles": roles_dict,
        "positions": positions_dict,
        "projects": projects_dict,
        "sub_roles": sub_roles_dict,
        "sort_orders": sort_orders_dict,
        "pins": pins_dict,
        "db": db_dict
    }

@app.post("/api/import", tags=["migration"])
async def import_data(data: ImportData, db: AsyncSession = Depends(get_db),
                      auth: dict = Depends(require_auth)):
    """JSON 데이터를 DB로 가져오기 (관리자 전용 — DB 전체 덮어쓰기 위험).
    - 옛 백업 형식(reports 안에 done/plan/issue/note/sor_cnt 등이 직접 있는 케이스)도 호환.
      → 자동으로 custom_data JSON으로 변환.
    - reports 안의 role/position/project/sub_role이 비면 members 정보에서 폴백.
    - PostgreSQL의 ON CONFLICT는 unique constraint 필요 — 없는 경우를 대비해 한 번 보장."""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 데이터를 가져올 수 있습니다")
    try:
        # 0. reports의 (member_name, week_key) UNIQUE 보장 (SQLite/PostgreSQL 양쪽 호환)
        try:
            await db.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_member_week ON reports(member_name, week_key)"
            ))
            await db.commit()
        except Exception:
            pass  # 이미 있으면 무시

        # 1. Members
        for name in data.members:
            role = data.roles.get(name, "etc")
            pos = data.positions.get(name, "")
            proj = data.projects.get(name, "")
            sub = data.sub_roles.get(name, "")
            order = data.sort_orders.get(name, 0)

            await db.execute(text("""
                INSERT INTO members (name, role, position, project, sub_role, sort_order)
                VALUES (:name, :role, :pos, :proj, :sub, :order)
                ON CONFLICT(name) DO UPDATE SET
                    role=excluded.role, position=excluded.position,
                    project=excluded.project, sub_role=excluded.sub_role,
                    sort_order=excluded.sort_order
            """), {"name": name, "role": role, "pos": pos, "proj": proj, "sub": sub, "order": order})

        # 2. PINs
        for name, pin_hash in data.pins.items():
            await db.execute(text("""
                INSERT INTO pins (member_name, pin_hash) VALUES (:name, :hash)
                ON CONFLICT(member_name) DO UPDATE SET pin_hash=excluded.pin_hash
            """), {"name": name, "hash": pin_hash})

        # 3. Reports
        # 옛 형식의 본문 컬럼명 — 만약 r에 custom_data가 비어있고 이 키들이 있으면 자동으로 묶어서 custom_data로 변환
        LEGACY_BODY_KEYS = ["done", "plan", "issue", "note", "sor_cnt", "sop_cnt", "chg_cnt"]

        imported_count = 0
        for week_key, member_reports in data.db.items():
            for name, r in member_reports.items():
                # 3-1. custom_data 빌드 (옛 형식 호환)
                cd = r.get("custom_data")
                if not cd or (isinstance(cd, dict) and not cd):
                    # 옛 형식: 직접 컬럼들이 있을 때 — custom_data로 재구성
                    cd = {}
                    for k in LEGACY_BODY_KEYS:
                        if k in r and r[k] not in (None, "", 0):
                            cd[k] = r[k]
                    # 카운터 0이라도 다 살리려면 위 조건을 풀면 되지만, 빈 보고가 너무 커지므로 의미값만 보존
                if isinstance(cd, str):
                    c_data_str = cd  # 이미 JSON 문자열이면 그대로
                else:
                    c_data_str = json.dumps(cd or {}, ensure_ascii=False)

                # 3-2. role/position/project/sub_role — reports에 없으면 members 정보에서 폴백
                role_v = r.get("role") or data.roles.get(name, "etc")
                pos_v  = r.get("position") or data.positions.get(name, "")
                proj_v = r.get("project") or data.projects.get(name, "")
                sub_v  = r.get("sub_role") or data.sub_roles.get(name, "")
                status_v = r.get("status") or "submitted"
                from datetime import timedelta
                kst_now = datetime.utcnow() + timedelta(hours=9)
                time_v = r.get("submitted_at") or r.get("time") or kst_now.strftime("%Y-%m-%d %H:%M:%S")

                await db.execute(text("""
                    INSERT INTO reports (member_name, week_key, role, position, project, sub_role, custom_data, status, submitted_at)
                    VALUES (:name, :wk, :role, :pos, :proj, :sub, :data, :status, :time)
                    ON CONFLICT(member_name, week_key) DO UPDATE SET
                        role=excluded.role, position=excluded.position, project=excluded.project,
                        sub_role=excluded.sub_role, custom_data=excluded.custom_data,
                        status=excluded.status, submitted_at=excluded.submitted_at
                """), {
                    "name": name, "wk": week_key, "role": role_v,
                    "pos": pos_v, "proj": proj_v, "sub": sub_v,
                    "data": c_data_str, "status": status_v, "time": time_v,
                })
                imported_count += 1

        await db.commit()
        return {
            "status": "success",
            "imported": {
                "members": len(data.members),
                "pins": len(data.pins),
                "reports": imported_count,
            }
        }
    except Exception as e:
        await db.rollback()
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"가져오기 실패: {type(e).__name__}: {str(e)}")

# 라우터 등록
app.include_router(divisions.router)    # 본부 관리
app.include_router(teams.router)        # 팀 관리
app.include_router(system_admin.router) # 시스템 관리자
app.include_router(members.router)
app.include_router(reports.router)
app.include_router(auth.router)
app.include_router(ai.router)
app.include_router(permissions.router)
app.include_router(settings.router)
app.include_router(push.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
