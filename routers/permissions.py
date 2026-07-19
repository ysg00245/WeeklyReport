from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, DATABASE_URL, now_sql
from models import PermissionGrantRequest, PermissionOut
from routers.auth import require_auth
from routers.team_deps import get_team_id

router = APIRouter(prefix="/api/permissions", tags=["permissions"])

@router.get("", response_model=list[PermissionOut])
async def list_permissions(
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """유효 권한 전체 목록 (관리자 전용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 접근 가능합니다")
    result = await db.execute(text(
        f"SELECT member_name, week_key, starts_at, expires_at FROM late_permissions WHERE expires_at > {now_sql} AND team_id = :tid ORDER BY expires_at DESC"
    ), {"tid": tid})
    rows = result.mappings().all()
    return rows

@router.get("/{name}/detail")
async def get_user_permission_details(
    name: str,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """특정 팀원의 유효한 수정권한 상세 — 본인 또는 관리자"""
    if not auth.get("is_admin") and auth.get("identity") != name:
        raise HTTPException(403, "본인 권한만 조회 가능합니다")
    result = await db.execute(text(
        f"SELECT week_key, starts_at, expires_at FROM late_permissions "
        f"WHERE member_name = :name AND expires_at > {now_sql} AND starts_at <= {now_sql} AND team_id = :tid "
        f"ORDER BY week_key DESC"
    ), {"name": name, "tid": tid})
    rows = result.mappings().all()
    return [dict(r) for r in rows]

@router.get("/{name}", response_model=list[str])
async def list_user_permissions(
    name: str,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """특정 팀원에게 허용된 과거 주차 목록 — 본인 또는 관리자"""
    if not auth.get("is_admin") and auth.get("identity") != name:
        raise HTTPException(403, "본인 권한만 조회 가능합니다")
    result = await db.execute(text(
        f"SELECT week_key FROM late_permissions WHERE member_name = :name AND expires_at > {now_sql} AND starts_at <= {now_sql} AND team_id = :tid ORDER BY week_key DESC"
    ), {"name": name, "tid": tid})
    rows = result.mappings().all()
    return [r["week_key"] for r in rows]

@router.post("", response_model=PermissionOut, status_code=201)
async def grant_permission(
    body: PermissionGrantRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """과거 주차 작성 권한 부여 (관리자 전용, UPSERT)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 권한을 부여할 수 있습니다")
    await db.execute(text(
        """
        INSERT INTO late_permissions (member_name, week_key, starts_at, expires_at, team_id)
        VALUES (:name, :wk, :start, :exp, :tid)
        ON CONFLICT(team_id, member_name, week_key) DO UPDATE SET
          starts_at = excluded.starts_at,
          expires_at = excluded.expires_at
        """
    ), {
        "name": body.member_name,
        "wk": body.week_key,
        "start": body.starts_at,
        "exp": body.expires_at,
        "tid": tid,
    })
    await db.commit()

    # 팀원에게 수정권한 부여 푸시 알림
    try:
        from routers.push import send_push_to_member
        expires_str = body.expires_at[:16] if body.expires_at else ""
        await send_push_to_member(
            member_name=body.member_name,
            title="✍️ 마감 후 수정 권한 부여",
            body=f"{body.week_key} 주간보고 수정 권한이 부여되었습니다. {expires_str}까지 수정 가능합니다.",
            url="/",
            db=db,
            tag="permission-granted",
        )
    except Exception as e:
        print(f"[Push] 수정권한 부여 알림 오류: {e}")

    return PermissionOut(
        member_name=body.member_name,
        week_key=body.week_key,
        starts_at=body.starts_at,
        expires_at=body.expires_at
    )

@router.delete("/{name}/{week_key}")
async def revoke_permission(
    name: str,
    week_key: str,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """과거 주차 작성 권한 회수 (관리자 전용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 권한을 회수할 수 있습니다")
    await db.execute(text(
        "DELETE FROM late_permissions WHERE member_name = :name AND week_key = :wk AND team_id = :tid"
    ), {"name": name, "wk": week_key, "tid": tid})
    await db.commit()
    return {"ok": True, "message": "권한이 회수되었습니다."}
