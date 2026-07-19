"""
주간보고 CRUD API
- 보고 제출 시 role/position/project/sub_role을 스냅샷으로 저장 (과거 이력 보존)
"""
import json
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, DATABASE_URL, now_sql
from models import ReportSave, ReportOut
from ws_manager import manager
from routers.auth import require_auth, is_report_approver
from routers.team_deps import get_team_id

router = APIRouter(prefix="/api/reports", tags=["reports"])

def get_current_week_key() -> str:
    """ISO 8601 기준 현재 주차 키 반환 (예: 2026-W18)"""
    from datetime import timedelta
    kst_now = datetime.utcnow() + timedelta(hours=9)
    iso_year, iso_week, _ = kst_now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


async def _team_slug(db: AsyncSession, tid: int):
    """WS 브로드캐스트용 팀 slug. 전역 브로드캐스트라 팀 정보 없이는
    다른 팀 관리자/동명이인에게 오배송된다 — 모든 reports 이벤트에 동봉."""
    row = (await db.execute(text("SELECT slug FROM teams WHERE id = :tid"), {"tid": tid})).mappings().first()
    return row["slug"] if row else None


async def _has_saved_summary(db: AsyncSession, tid: int, week_key: str) -> bool:
    """해당 주차에 이미 저장된 AI 요약(summaries) 레코드가 있는지 확인.
    True 면 보고 변경 시 'AI 요약 stale' 노티를 발송해야 함."""
    res = await db.execute(text(
        "SELECT 1 FROM summaries WHERE team_id = :tid AND week_key = :wk LIMIT 1"
    ), {"tid": tid, "wk": week_key})
    return res.first() is not None


@router.get("", response_model=list[ReportOut])
async def list_reports(
    week: str = Query(..., description="주차 키 (예: 2026-W18)"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """해당 주 전체 보고 (관리자 또는 결재권자=팀장/주간보고 담당자)"""
    if not await is_report_approver(auth, db):
        raise HTTPException(403, "주간보고 담당자만 접근 가능합니다")
    result = await db.execute(text(
        """SELECT id, member_name, week_key, done, plan, issue, note,
                  sor_cnt, sop_cnt, chg_cnt, custom_data,
                  role, position, project, sub_role, submitted_at, status
           FROM reports WHERE week_key = :week AND team_id = :tid
           ORDER BY member_name"""
    ), {"week": week, "tid": tid})
    rows = result.mappings().all()

    # JSON 파싱 및 데이터 보정 (Flattening)
    reports = []
    for row in rows:
        r = dict(row)
        # custom_data 보정 및 Flattening (UI 호환성)
        cd = r.get("custom_data", "{}")
        if isinstance(cd, str):
            try: cd = json.loads(cd)
            except: cd = {}

        # 개별 컬럼 데이터가 있으면 우선적으로 사용
        for k in ["done", "plan", "issue", "note", "sor_cnt", "sop_cnt", "chg_cnt"]:
            col_val = r.get(k)
            if col_val is not None and col_val not in ("", 0):
                r[k] = col_val
            else:
                r[k] = cd.get(k, "" if k not in ["sor_cnt", "sop_cnt", "chg_cnt"] else 0)

        r["custom_data"] = cd
        reports.append(r)
    return reports


@router.get("/metrics")
async def get_metrics(weeks: int = Query(8, ge=1, le=26), db: AsyncSession = Depends(get_db), tid: int = Depends(get_team_id)):
    """운영 지표 (SOR/SOP/CHG) — 최근 N주 주차별·멤버별 집계"""
    result = await db.execute(text(
        """SELECT member_name, week_key, role, project,
                  sor_cnt, sop_cnt, chg_cnt, custom_data
           FROM reports
           WHERE team_id = :tid
           ORDER BY week_key DESC
           LIMIT :limit"""
    ), {"limit": weeks * 50, "tid": tid})
    rows = result.mappings().all()

    week_set: set[str] = set()
    raw: list[dict] = []
    for row in rows:
        r = dict(row)
        cd = r.get("custom_data") or "{}"
        if isinstance(cd, str):
            try: cd = json.loads(cd)
            except: cd = {}
        def _cnt(key):
            v = r.get(key)
            return int(v) if v and int(v) > 0 else int(cd.get(key, 0) or 0)
        r["sor"] = _cnt("sor_cnt")
        r["sop"] = _cnt("sop_cnt")
        r["chg"] = _cnt("chg_cnt")
        week_set.add(r["week_key"])
        raw.append(r)

    sorted_weeks = sorted(week_set)[-weeks:]
    raw = [r for r in raw if r["week_key"] in sorted_weeks]

    weekly: dict[str, dict] = {wk: {"sor": 0, "sop": 0, "chg": 0} for wk in sorted_weeks}
    member_map: dict[str, dict] = {}
    for r in raw:
        wk = r["week_key"]
        if wk not in weekly:
            continue
        weekly[wk]["sor"] += r["sor"]
        weekly[wk]["sop"] += r["sop"]
        weekly[wk]["chg"] += r["chg"]
        if r.get("role") == "ops" and (r["sor"] or r["sop"] or r["chg"]):
            name = r["member_name"]
            if name not in member_map:
                member_map[name] = {"name": name, "project": r.get("project") or "운영",
                                    "weeks": {wk: {"sor": 0, "sop": 0, "chg": 0} for wk in sorted_weeks}}
            member_map[name]["weeks"][wk]["sor"] += r["sor"]
            member_map[name]["weeks"][wk]["sop"] += r["sop"]
            member_map[name]["weeks"][wk]["chg"] += r["chg"]

    return {
        "weeks": sorted_weeks,
        "weekly_totals": weekly,
        "members": list(member_map.values()),
    }


def _parse_report_row(row) -> dict:
    """보고서 DB row → dict 변환 (공통 파싱 로직)"""
    r = dict(row)
    cd = r.get("custom_data", "{}")
    if isinstance(cd, str):
        try: cd = json.loads(cd)
        except: cd = {}
    for k in ["done", "plan", "issue", "note", "sor_cnt", "sop_cnt", "chg_cnt"]:
        col_val = r.get(k)
        if col_val is not None and col_val not in ("", 0):
            r[k] = col_val
        else:
            r[k] = cd.get(k, "" if k not in ["sor_cnt", "sop_cnt", "chg_cnt"] else 0)
    r["custom_data"] = cd
    return r


# NOTE: `/{name}` 본인-또는-관리자 엔드포인트는 main의 보안 패치 패턴(/my + /{name} 관리자 전용)으로 통합.
#       아래 _REPORT_COLS 다음에 등장하는 main 패턴을 그대로 사용.

_REPORT_COLS = """id, member_name, week_key, done, plan, issue, note,
                  sor_cnt, sop_cnt, chg_cnt, custom_data,
                  role, position, project, sub_role, submitted_at, status"""


@router.get("/my", response_model=Optional[ReportOut])
async def get_my_report(
    week: str = Query(..., description="주차 키"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """내 보고서 조회 — 세션 토큰에서 신원 추출 (URL에 이름 노출 없음)"""
    name = auth.get("identity")
    if not name or auth.get("is_admin"):
        raise HTTPException(403, "본인 세션으로만 조회 가능합니다")
    result = await db.execute(text(
        f"SELECT {_REPORT_COLS} FROM reports WHERE member_name = :name AND week_key = :wk AND team_id = :tid"
    ), {"name": name, "wk": week, "tid": tid})
    row = result.mappings().first()
    return _parse_report_row(row) if row else None


@router.get("/my/history", response_model=list[ReportOut])
async def get_my_history(
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """내 이력 조회 — 세션 기반"""
    name = auth.get("identity")
    if not name or auth.get("is_admin"):
        raise HTTPException(403, "본인 세션으로만 조회 가능합니다")
    result = await db.execute(text(
        f"SELECT {_REPORT_COLS} FROM reports WHERE member_name = :name AND team_id = :tid ORDER BY week_key DESC"
    ), {"name": name, "tid": tid})
    return [_parse_report_row(r) for r in result.mappings().all()]


@router.delete("/my")
async def delete_my_report(
    week: str = Query(..., description="삭제할 주차"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """내 보고서 삭제 (초기화용 — 세션 기반)"""
    name = auth.get("identity")
    if not name or auth.get("is_admin"):
        raise HTTPException(403, "본인 세션으로만 삭제 가능합니다")
    await db.execute(text(
        "DELETE FROM reports WHERE member_name = :name AND week_key = :week AND team_id = :tid"
    ), {"name": name, "week": week, "tid": tid})
    await db.commit()

    # AI 재요약 권장 여부는 페이로드에 인라인 — 노티 두 개 분리 발송 방식 폐기.
    summary_stale = await _has_saved_summary(db, tid, week)
    await manager.broadcast({
        "type": "REPORT_DELETED",
        "member_name": name,
        "week_key": week,
        "summary_stale": summary_stale,
        "team_id": tid,
        "team_slug": await _team_slug(db, tid),
    })

    return {"ok": True}


@router.get("/{name}", response_model=Optional[ReportOut])
async def get_report(
    name: str,
    week: str = Query(..., description="주차 키"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """개인 보고 조회 (관리자용 — 일반 사용자는 /my 사용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 접근 가능합니다. 본인 보고서는 /api/reports/my 를 사용하세요")
    result = await db.execute(text(
        f"SELECT {_REPORT_COLS} FROM reports WHERE member_name = :name AND week_key = :wk AND team_id = :tid"
    ), {"name": name, "wk": week, "tid": tid})
    row = result.mappings().first()
    return _parse_report_row(row) if row else None


@router.post("/{name}", response_model=ReportOut, status_code=201)
async def save_report(
    name: str,
    body: ReportSave,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    if not auth.get("is_admin") and auth.get("identity") != name:
        raise HTTPException(403, "본인의 보고서만 제출할 수 있습니다")
    """보고 저장/수정 (UPSERT)"""

    # 1. 팀원 정보 가져오기 (스냅샷용)
    res = await db.execute(text("SELECT role, position, project, sub_role FROM members WHERE name = :name AND team_id = :tid"), {"name": name, "tid": tid})
    member = res.mappings().first()
    if not member:
        raise HTTPException(404, "명단에 등록된 사용자가 아닙니다")

    # 2. 마감 검증 + 과거 주차 작성 권한 검증
    current_wk = get_current_week_key()
    is_late_submission = False  # 마감 경과 후 수정 여부 추적

    # 2-1. 현재 주차인 경우: 마감 여부 확인
    if body.week_key == current_wk:
        from deadline import load_deadline_config, is_deadline_passed
        config = await load_deadline_config(db)
        if is_deadline_passed(body.week_key, config):
            # 마감 경과 — late_permission이 있으면 허용
            perm_res = await db.execute(text(
                f"SELECT expires_at FROM late_permissions WHERE member_name = :name AND week_key = :wk AND expires_at > {now_sql} AND team_id = :tid"
            ), {"name": name, "wk": body.week_key, "tid": tid})
            if not perm_res.mappings().first():
                raise HTTPException(403, "주간보고 마감 시간이 경과했습니다.\n관리자에게 수정 권한을 요청해주세요.")
            is_late_submission = True  # 마감 후 권한 부여로 수정
    else:
        # 2-2. 과거 주차: 기존 권한 검증 로직
        perm_res = await db.execute(text(
            f"SELECT expires_at FROM late_permissions WHERE member_name = :name AND week_key = :wk AND expires_at > {now_sql} AND team_id = :tid"
        ), {"name": name, "wk": body.week_key, "tid": tid})
        if not perm_res.mappings().first():
            raise HTTPException(403, "해당 주차의 주간보고 작성 권한이 없거나 만료되었습니다.")
        is_late_submission = True  # 과거 주차 = 항상 마감 후

    # 3. 데이터 저장 (UPSERT)
    c_data = body.custom_data.copy() if body.custom_data else {}
    c_data_str = json.dumps(c_data, ensure_ascii=False)

    upsert_sql = f"""
        INSERT INTO reports (member_name, week_key, done, plan, issue, note, sor_cnt, sop_cnt, chg_cnt, custom_data, role, position, project, sub_role, status, submitted_at, team_id)
        VALUES (:name, :wk, :done, :plan, :issue, :note, :sor, :sop, :chg, :data, :role, :pos, :proj, :sub, 'submitted', {now_sql}, :tid)
        ON CONFLICT(team_id, member_name, week_key) DO UPDATE SET
            done = excluded.done,
            plan = excluded.plan,
            issue = excluded.issue,
            note = excluded.note,
            sor_cnt = excluded.sor_cnt,
            sop_cnt = excluded.sop_cnt,
            chg_cnt = excluded.chg_cnt,
            custom_data = excluded.custom_data,
            role = excluded.role,
            position = excluded.position,
            project = excluded.project,
            sub_role = excluded.sub_role,
            status = 'submitted',
            submitted_at = {now_sql},
            updated_at = {now_sql}
        RETURNING id, submitted_at
    """

    try:
        save_res = await db.execute(text(upsert_sql), {
            "name": name,
            "wk": body.week_key,
            "done": body.done,
            "plan": body.plan,
            "issue": body.issue,
            "note": body.note,
            "sor": body.sor_cnt,
            "sop": body.sop_cnt,
            "chg": body.chg_cnt,
            "data": c_data_str,
            "role": member["role"],
            "pos": member["position"],
            "proj": member["project"],
            "sub": member["sub_role"],
            "tid": tid,
        })
        row = save_res.mappings().first()
        await db.commit()

        # AI 재요약 권장 여부는 페이로드에 인라인 — 노티 두 개 분리 발송 방식 폐기.
        # (이전: LATE_REPORT_UPDATED 별도 이벤트로 두 번째 노티 → 사용자 UX 불만)
        summary_stale = await _has_saved_summary(db, tid, body.week_key)
        await manager.broadcast({
            "type": "REPORT_SUBMITTED",
            "member_name": name,
            "week_key": body.week_key,
            "is_late": is_late_submission,
            "summary_stale": summary_stale,
            "team_id": tid,
            "team_slug": await _team_slug(db, tid),
        })

        return {
            "id": row["id"],
            "member_name": name,
            "week_key": body.week_key,
            "custom_data": body.custom_data,
            "role": member["role"],
            "position": member["position"],
            "project": member["project"],
            "sub_role": member["sub_role"],
            "submitted_at": row["submitted_at"],
            "status": "submitted"
        }
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"저장 중 오류 발생: {str(e)}")


@router.put("/{name}/status")
async def update_report_status(
    name: str,
    week: str = Query(..., description="주차 키"),
    status: str = Query(..., description="변경할 상태 (needs_revision, submitted 등)"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """보고 상태 변경 (관리자 전용: 보완 요청 등)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 상태를 변경할 수 있습니다")
    result = await db.execute(text(
        f"UPDATE reports SET status=:status, updated_at={now_sql} WHERE member_name=:name AND week_key=:week AND team_id=:tid"
    ), {"name": name, "week": week, "status": status, "tid": tid})
    await db.commit()

    # WS 실시간 알림 (사용자 화면 상태 즉시 갱신)
    # 보완요청은 보고서 *내용* 무변경 → AI 요약 stale 아님. 재요약 노티 미발송.
    # team_slug 동봉 — 전역 브로드캐스트라 이름만으로 매칭하면 타 팀 동명이인에게 오배송된다.
    await manager.broadcast({
        "type": "REPORT_STATUS_CHANGED",
        "member_name": name,
        "week_key": week,
        "status": status,
        "team_id": tid,
        "team_slug": await _team_slug(db, tid),
    })

    # 보완 요청 시 Push 알림 발송
    if status == 'needs_revision':
        try:
            from routers.push import send_push_to_member
            await send_push_to_member(
                member_name=name,
                title="⚠️ 주간보고 보완 요청",
                body=f"{week} 주간보고에 보완 요청이 있습니다. 확인 후 수정해주세요.",
                url="/",
                db=db,
                tag="revision-request",
            )
        except Exception as e:
            print(f"[Push] 보완요청 알림 발송 오류: {e}")

    return {"ok": True}


@router.delete("/{name}")
async def delete_report(
    name: str,
    week: str = Query(..., description="삭제할 주차"),
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """보고 삭제 (관리자 전용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 삭제할 수 있습니다")
    await db.execute(text(
        "DELETE FROM reports WHERE member_name = :name AND week_key = :week AND team_id = :tid"
    ), {"name": name, "week": week, "tid": tid})
    await db.commit()

    # AI 재요약 권장 여부는 페이로드에 인라인 — 노티 두 개 분리 발송 방식 폐기.
    summary_stale = await _has_saved_summary(db, tid, week)
    await manager.broadcast({
        "type": "REPORT_DELETED",
        "member_name": name,
        "week_key": week,
        "summary_stale": summary_stale,
        "team_id": tid,
        "team_slug": await _team_slug(db, tid),
    })

    return {"ok": True}


@router.get("/{name}/history", response_model=list[ReportOut])
async def get_history(
    name: str,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """개인 이력 조회 (관리자 전용 — 일반 사용자는 /my/history 사용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 접근 가능합니다. 본인 이력은 /api/reports/my/history 를 사용하세요")
    result = await db.execute(text(
        """SELECT id, member_name, week_key, custom_data,
                  role, position, project, sub_role, submitted_at, status
           FROM reports
           WHERE member_name = :name AND team_id = :tid
           ORDER BY week_key DESC"""
    ), {"name": name, "tid": tid})
    rows = result.mappings().all()

    history = []
    for row in rows:
        r = dict(row)
        cd = r.get("custom_data", "{}")
        if isinstance(cd, str):
            try: cd = json.loads(cd)
            except: cd = {}

        r["done"] = cd.get("done", "")
        r["plan"] = cd.get("plan", "")
        r["issue"] = cd.get("issue", "")
        r["note"] = cd.get("note", "")
        r["sor_cnt"] = cd.get("sor_cnt", 0)
        r["sop_cnt"] = cd.get("sop_cnt", 0)
        r["chg_cnt"] = cd.get("chg_cnt", 0)
        r["custom_data"] = cd
        history.append(r)
    return history
