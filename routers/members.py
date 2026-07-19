"""
팀원 관리 CRUD API
- 삭제 시: 현재 주차 보고만 삭제, 과거 이력은 보존
- 이름 변경 시: PIN 초기화 (새로 등록 필요)
"""
import json
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import List
from pydantic import BaseModel
from database import get_db, now_sql
from models import MemberCreate, MemberUpdate, MemberOut, ReorderRequest, MemberBatchItem, MemberBatchUpdate
from routers.auth import require_auth
from routers.team_deps import get_team_id
from routers.org_labels import get_org_labels, josa

router = APIRouter(prefix="/api/members", tags=["members"])


def _require_admin(auth: dict):
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 접근 가능합니다")


def current_week_key() -> str:
    """현재 ISO 주차 키 반환 (예: 2026-W18)"""
    from datetime import datetime, timedelta
    kst_now = datetime.utcnow() + timedelta(hours=9)
    iso = kst_now.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


@router.get("", response_model=list[MemberOut])
async def list_members(
    request: Request,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
):
    """팀원 목록 — 로그인 화면용. 인증된 사용자만 PIN 등록 여부 확인 가능 (main 보안 패치 보존)."""
    from database import now_sql
    token = request.headers.get("X-Auth-Token", "")
    is_authed = False
    if token:
        try:
            res = await db.execute(text(
                f"SELECT 1 FROM sessions WHERE token = :t AND expires_at > {now_sql}"
            ), {"t": token})
            is_authed = res.first() is not None
        except Exception:
            is_authed = False

    # 정렬: 프로젝트(기타/빈값 마지막) → 직급 순(본부장~사원) → 이름
    # 로그인/관리자/시스템콘솔/모든 멤버 노출 지점 일관 적용
    POSITION_ORDER = """CASE m.position
        WHEN '본부장'     THEN 0
        WHEN '연구소장'   THEN 0
        WHEN '이사'       THEN 1
        WHEN '팀장'       THEN 2
        WHEN '부장'       THEN 3
        WHEN '차장'       THEN 4
        WHEN '과장'       THEN 5
        WHEN '대리'       THEN 6
        WHEN '주임'       THEN 7
        WHEN '사원'       THEN 8
        ELSE 99
    END"""
    # 프로젝트: 빈값/'기타' 는 가장 마지막. 나머지는 알파벳/한글 순.
    PROJECT_ORDER = """CASE
        WHEN COALESCE(m.project, '') = ''     THEN 1
        WHEN m.project = '기타'              THEN 1
        ELSE 0
    END"""
    # 정책: is_visible=FALSE 멤버는 모든 사용자에게서 제외.
    # 노출 OFF = 주간보고 작성 대상에서도 제외 (관리자 콘솔 count·역할설정·보고 카드 모두).
    # 노출 토글 자체는 시스템 관리자 콘솔의 /api/system-admin/teams/{slug}/members 에서만 가능 — 그쪽은 hidden 도 반환.
    #
    # 팀장(👑) / 주보관리자 정·부(📋) 배지 표시를 위해 teams 와 LEFT JOIN 하여 per-row 불리언으로 노출.
    # 주의: SQL 의 `col = val` 비교는 col 이 NULL 이면 NULL 반환 (3-value logic). Pydantic bool
    # 필드는 None 을 거부하므로 반드시 COALESCE 로 FALSE 보정. 안 그러면 ResponseValidationError 500.
    if is_authed:
        result = await db.execute(text(
            f"""SELECT m.id, m.name, m.role, m.position, COALESCE(m.title, '') as title,
                      m.project, m.sub_role, m.created_at, m.sort_order,
                      COALESCE(m.is_visible, TRUE) as is_visible,
                      COALESCE(m.is_report_target, TRUE) as is_report_target,
                      COALESCE(m.avatar_config, '') as avatar_config,
                      (p.pin_hash IS NOT NULL) as has_pin,
                      p.created_at as pin_set_at,
                      COALESCE(t.leader_name            = m.name, FALSE) as is_leader,
                      COALESCE(t.report_admin_primary   = m.name, FALSE) as is_report_admin_primary,
                      COALESCE(t.report_admin_secondary = m.name, FALSE) as is_report_admin_secondary,
                      EXISTS (SELECT 1 FROM divisions dd WHERE dd.head_name = m.name) as is_division_head
               FROM members m
               LEFT JOIN pins  p ON m.name = p.member_name AND p.team_id = m.team_id
               LEFT JOIN teams t ON t.id    = m.team_id
               WHERE m.team_id = :tid AND COALESCE(m.is_visible, TRUE) = TRUE
               ORDER BY {PROJECT_ORDER}, COALESCE(m.project, ''), {POSITION_ORDER}, m.name ASC"""
        ), {"tid": tid})
    else:
        # 비로그인 (로그인 화면): 위와 동일 필터 + 팀 메타도 노출(이름 카드 옆 배지용)
        result = await db.execute(text(
            f"""SELECT m.id, m.name, m.role, m.position, COALESCE(m.title, '') as title,
                      m.project, m.sub_role, m.created_at, m.sort_order,
                      TRUE as is_visible,
                      COALESCE(m.is_report_target, TRUE) as is_report_target,
                      COALESCE(m.avatar_config, '') as avatar_config,
                      false as has_pin, NULL as pin_set_at,
                      COALESCE(t.leader_name            = m.name, FALSE) as is_leader,
                      COALESCE(t.report_admin_primary   = m.name, FALSE) as is_report_admin_primary,
                      COALESCE(t.report_admin_secondary = m.name, FALSE) as is_report_admin_secondary,
                      EXISTS (SELECT 1 FROM divisions dd WHERE dd.head_name = m.name) as is_division_head
               FROM members m
               LEFT JOIN teams t ON t.id = m.team_id
               WHERE m.team_id = :tid AND COALESCE(m.is_visible, TRUE) = TRUE
               ORDER BY {PROJECT_ORDER}, COALESCE(m.project, ''), {POSITION_ORDER}, m.name ASC"""
        ), {"tid": tid})
    rows = result.mappings().all()
    return rows


@router.put("/reorder/all")
async def reorder_members(
    req: ReorderRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """드래그 앤 드롭으로 결정된 전체 순서 일괄 저장 (관리자 전용)"""
    _require_admin(auth)
    for index, name in enumerate(req.names):
        await db.execute(text("UPDATE members SET sort_order = :idx WHERE name = :name AND team_id = :tid"), {"idx": index, "name": name, "tid": tid})
    await db.commit()
    return {"ok": True}


@router.post("", response_model=MemberOut, status_code=201)
async def add_member(
    body: MemberCreate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """팀원 추가 (관리자 전용)"""
    _require_admin(auth)
    try:
        result = await db.execute(text(
            "INSERT INTO members (name, role, position, project, sub_role, team_id) VALUES (:name, :role, :pos, :proj, :sub, :tid) RETURNING id, created_at, sort_order"
        ), {"name": body.name, "role": body.role, "pos": body.position, "proj": body.project, "sub": body.sub_role, "tid": tid})
        row = result.mappings().first()
        await db.commit()
        return {
            "id": row["id"],
            "name": body.name,
            "role": body.role,
            "position": body.position,
            "project": body.project,
            "sub_role": body.sub_role,
            "created_at": row["created_at"],
            "sort_order": row["sort_order"],
            "is_visible": True,
            "has_pin": False,
            "pin_set_at": None
        }
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"이미 존재하는 이름이거나 등록 실패: {str(e)}")



@router.put("/batch")
async def update_members_batch(
    body: MemberBatchUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """여러 팀원 정보를 한 번의 요청으로 일괄 수정 (관리자 전용)"""
    _require_admin(auth)
    from datetime import datetime, timedelta
    kst_now = datetime.utcnow() + timedelta(hours=9)
    wk_iso = kst_now.isocalendar()
    wk = f"{wk_iso[0]}-W{wk_iso[1]:02d}"

    try:
        for item in body.items:
            name = item.name
            u = item.update

            update_fields = []
            params = {"n": name, "wk": wk, "tid": tid}

            if u.role is not None:
                update_fields.append("role = :role")
                params["role"] = u.role
            if u.position is not None:
                update_fields.append("position = :pos")
                params["pos"] = u.position
            if u.project is not None:
                update_fields.append("project = :proj")
                params["proj"] = u.project
            if u.sub_role is not None:
                update_fields.append("sub_role = :sub")
                params["sub"] = u.sub_role

            if update_fields:
                update_fields.append(f"updated_at = {now_sql}")
                sql = f"UPDATE members SET {', '.join(update_fields)} WHERE name = :n AND team_id = :tid"
                await db.execute(text(sql), params)
                # 현재 주차 보고서 스냅샷도 동기화
                rep_sql = f"UPDATE reports SET {', '.join(update_fields)} WHERE member_name = :n AND week_key = :wk AND team_id = :tid"
                await db.execute(text(rep_sql), params)

        await db.commit()
        return {"ok": True, "count": len(body.items)}
    except Exception as e:
        await db.rollback()
        raise HTTPException(400, f"일괄 저장 실패: {str(e)}")


@router.put("/{name}", response_model=MemberOut)
async def update_member(
    name: str,
    body: MemberUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """팀원 정보 수정 / 이름 변경 (관리자 전용)"""
    _require_admin(auth)
    # 1. 존재 확인
    res = await db.execute(text("SELECT * FROM members WHERE name = :name AND team_id = :tid"), {"name": name, "tid": tid})
    member = res.mappings().first()
    if not member:
        raise HTTPException(status_code=404, detail=f"{josa((await get_org_labels(db))['member'], '을')} 찾을 수 없습니다.")

    wk_iso = date.today().isocalendar()
    wk = f"{wk_iso[0]}-W{wk_iso[1]:02d}"

    # 2. 업데이트할 필드 동적 구성 (한 번의 쿼리로 통합하여 네트워크 지연 최소화)
    update_fields = []
    params = {"n": name, "wk": wk, "tid": tid}

    if body.role is not None:
        update_fields.append("role = :role")
        params["role"] = body.role
    if body.position is not None:
        update_fields.append("position = :pos")
        params["pos"] = body.position
    if body.project is not None:
        update_fields.append("project = :proj")
        params["proj"] = body.project
    if body.sub_role is not None:
        update_fields.append("sub_role = :sub")
        params["sub"] = body.sub_role
    if body.is_visible is not None:
        update_fields.append("is_visible = :is_visible")
        params["is_visible"] = bool(body.is_visible)

    if update_fields:
        # members 테이블 업데이트
        await db.execute(text(f"UPDATE members SET {', '.join(update_fields)} WHERE name = :n AND team_id = :tid"), params)
        # 현재 주차 reports 테이블도 함께 업데이트 (스냅샷 갱신)
        await db.execute(text(f"UPDATE reports SET {', '.join(update_fields)} WHERE member_name = :n AND week_key = :wk AND team_id = :tid"), params)

    # 3. 이름 변경 — 모델 필드명은 new_name (body.name 아님)
    final_name = name
    if body.new_name is not None and body.new_name != name:
        try:
            await db.execute(text("UPDATE members SET name = :new WHERE name = :old AND team_id = :tid"),
                             {"new": body.new_name, "old": name, "tid": tid})
            # PIN은 보안 상 초기화, 현재 주차 reports만 이름 갱신, 과거 이력은 스냅샷이라 그대로 유지
            await db.execute(text("DELETE FROM pins WHERE member_name = :n AND team_id = :tid"), {"n": name, "tid": tid})
            await db.execute(text("UPDATE reports SET member_name = :new WHERE member_name = :old AND week_key = :wk AND team_id = :tid"),
                             {"new": body.new_name, "old": name, "wk": wk, "tid": tid})
            final_name = body.new_name
        except Exception:
            await db.rollback()
            raise HTTPException(400, f"이미 존재하는 이름입니다: {body.new_name}")

    await db.commit()

    # 4. 결과 반환
    final_res = await db.execute(text(
        """SELECT m.id, m.name, m.role, m.position, m.project, m.sub_role, m.created_at, m.sort_order,
                  COALESCE(m.is_visible, TRUE) as is_visible,
                  (p.pin_hash IS NOT NULL) as has_pin, p.created_at as pin_set_at
           FROM members m
           LEFT JOIN pins p ON m.name = p.member_name AND p.team_id = m.team_id
           WHERE m.name = :name AND m.team_id = :tid"""
    ), {"name": final_name, "tid": tid})
    return final_res.mappings().first()


class ReportTargetUpdate(BaseModel):
    is_report_target: bool


@router.put("/{name}/report-target")
async def set_report_target(
    name: str,
    body: ReportTargetUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """주간보고 집계 대상 여부 토글 (팀 관리자 전용).
    is_visible(로그인 목록 노출)과 별개 — 명단엔 보이되 미제출/제출률 집계에서만 빼는 용도.
    예: 팀장은 명단 노출 + 집계 제외(보고는 상위로 올라감)."""
    _require_admin(auth)
    await db.execute(text(
        "UPDATE members SET is_report_target = :v WHERE name = :n AND team_id = :tid"
    ), {"v": bool(body.is_report_target), "n": name, "tid": tid})
    await db.commit()
    return {"ok": True, "is_report_target": bool(body.is_report_target)}


class AvatarUpdate(BaseModel):
    img: str | None = None       # base64 data URL (소형 리사이즈) — None/'' 이면 제거
    color: str | None = None     # 사진 없을 때 배경 (hex 또는 그라데이션 CSS)
    initial: str | None = None   # 원 안 글자 (미지정 시 이름 첫 글자)
    border: str | None = None    # 테두리 색
    shape: str | None = None     # 'circle'(기본) | 'rounded'(둥근 사각형)
    effect: str | None = None    # 애니메이션: shine|pulse|glow|float


# 아바타 데이터 URL 상한 (base64). 256px 리사이즈면 보통 수십 KB — 넉넉히 300KB 로 제한.
_AVATAR_MAX_LEN = 300_000


@router.put("/{name}/avatar")
async def set_avatar(
    name: str,
    body: AvatarUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """아바타 꾸미기 저장 — 본인(또는 관리자)만. config 를 JSON 문자열로 members.avatar_config 에 저장."""
    if not (auth.get("is_admin") or auth.get("is_system_admin") or auth.get("identity") == name):
        raise HTTPException(403, "본인 또는 관리자만 변경할 수 있습니다")
    if body.img and len(body.img) > _AVATAR_MAX_LEN:
        raise HTTPException(413, "이미지가 너무 큽니다. 더 작은 사진을 사용해주세요.")
    cfg = {}
    if body.img:     cfg["img"]     = body.img
    if body.color:   cfg["color"]   = body.color
    if body.initial: cfg["initial"] = body.initial[:4]   # 원 안 글자는 최대 4자
    if body.border:  cfg["border"]  = body.border
    if body.shape == "rounded": cfg["shape"] = "rounded"
    if body.effect in ("shine", "pulse", "glow", "float", "shake", "bounce", "heartbeat", "spin", "rainbow"):
        cfg["effect"] = body.effect
    value = json.dumps(cfg, ensure_ascii=False) if cfg else ""
    await db.execute(text(
        "UPDATE members SET avatar_config = :v WHERE name = :n AND team_id = :tid"
    ), {"v": value, "n": name, "tid": tid})
    await db.commit()
    return {"ok": True, "avatar_config": value}


@router.delete("/{name}")
async def delete_member(
    name: str,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """팀원 삭제 (관리자 전용)"""
    _require_admin(auth)
    # 1. 현재 주차 보고서 삭제
    wk = current_week_key()
    await db.execute(text("DELETE FROM reports WHERE member_name = :name AND week_key = :wk AND team_id = :tid"), {"name": name, "wk": wk, "tid": tid})

    # 2. PIN 정보 삭제
    await db.execute(text("DELETE FROM pins WHERE member_name = :name AND team_id = :tid"), {"name": name, "tid": tid})

    # 3. 팀원 삭제
    await db.execute(text("DELETE FROM members WHERE name = :name AND team_id = :tid"), {"name": name, "tid": tid})

    await db.commit()
    return {"ok": True}
