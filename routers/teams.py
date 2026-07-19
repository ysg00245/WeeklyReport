"""팀 관리 API"""
import os
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, now_sql
from pydantic import BaseModel
from routers.auth import require_system_admin, _issue_token
from routers.org_labels import get_org_labels, josa

router = APIRouter(prefix="/api/teams", tags=["teams"])
ADMIN_PW        = os.getenv("ADMIN_PW", "1234")
SYSTEM_ADMIN_PW = os.getenv("SYSTEM_ADMIN_PW", "")


class TeamCreate(BaseModel):
    slug: str
    name: str
    division_id: int | None = None
    admin_pw: str = ""

class TeamUpdate(BaseModel):
    name: str = ""
    division_id: int | None = None
    admin_pw: str = ""


@router.get("")
async def list_teams(db: AsyncSession = Depends(get_db)):
    """전체 팀 목록 (랜딩 화면용 — 비인증). 팀장명 포함, 본부 순서 → 팀 id 순."""
    result = await db.execute(text("""
        SELECT id, slug, name, division_id, leader_name
          FROM teams
         ORDER BY COALESCE(division_id, 9999), id
    """))
    return [dict(r) for r in result.mappings().all()]


@router.post("")
async def create_team(
    body: TeamCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 생성 — 시스템 관리자 전용"""
    pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode() if body.admin_pw else None
    try:
        await db.execute(text(f"""
            INSERT INTO teams (slug, name, division_id, admin_pw_hash, created_at)
            VALUES (:slug, :name, :did, :pw_hash, {now_sql})
        """), {"slug": body.slug, "name": body.name, "did": body.division_id, "pw_hash": pw_hash})
        await db.commit()
    except Exception as e:
        raise HTTPException(400, f"{(await get_org_labels(db))['team']} 생성 실패: {str(e)}")
    return {"ok": True}


@router.put("/{slug}")
async def update_team(
    slug: str,
    body: TeamUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 정보 수정 — 시스템 관리자 전용"""
    if body.name:
        await db.execute(text("UPDATE teams SET name=:n WHERE slug=:s"), {"n": body.name, "s": slug})
    if body.division_id is not None:
        await db.execute(text("UPDATE teams SET division_id=:d WHERE slug=:s"), {"d": body.division_id, "s": slug})
    if body.admin_pw:
        pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode()
        await db.execute(text("UPDATE teams SET admin_pw_hash=:h WHERE slug=:s"), {"h": pw_hash, "s": slug})
    await db.commit()
    return {"ok": True}


@router.delete("/{slug}")
async def delete_team(
    slug: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 삭제 — 시스템 관리자 전용"""
    if slug == "default":
        raise HTTPException(400, f"기본 {josa((await get_org_labels(db))['team'], '은')} 삭제할 수 없습니다")
    await db.execute(text("DELETE FROM teams WHERE slug=:s"), {"s": slug})
    await db.commit()
    return {"ok": True}


@router.post("/{slug}/admin-login")
async def team_admin_login(slug: str, request: Request, db: AsyncSession = Depends(get_db)):
    """
    팀 어드민 로그인 — 토큰 발급.
    우선순위:
      1) SYSTEM_ADMIN_PW → 시스템 관리자 세션
      2) 팀별 admin_pw_hash → 팀 관리자 세션
      3) 전역 ADMIN_PW → 팀 관리자 세션 (하위 호환)
    """
    body = await request.json()
    pw = body.get("password", "")

    # 팀 조회
    result = await db.execute(
        text("SELECT id, name, admin_pw_hash FROM teams WHERE slug = :slug"), {"slug": slug}
    )
    team = result.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")

    tid = team["id"]

    # 1) 시스템 관리자
    if SYSTEM_ADMIN_PW and pw == SYSTEM_ADMIN_PW:
        token = await _issue_token(db, "__sysadmin__", team_id=None, is_admin=True, is_system_admin=True)
        return {
            "success": True, "team_id": tid, "team_name": team["name"],
            "is_super": True, "is_system_admin": True, "token": token,
        }

    # 2) 팀별 bcrypt PW
    if team["admin_pw_hash"]:
        try:
            if bcrypt.checkpw(pw.encode(), team["admin_pw_hash"].encode()):
                token = await _issue_token(db, f"__admin__:{tid}", team_id=tid, is_admin=True)
                return {
                    "success": True, "team_id": tid, "team_name": team["name"],
                    "is_super": False, "is_system_admin": False, "token": token,
                }
        except Exception:
            pass

    # 3) 전역 ADMIN_PW
    if pw == ADMIN_PW:
        token = await _issue_token(db, f"__admin__:{tid}", team_id=tid, is_admin=True)
        return {
            "success": True, "team_id": tid, "team_name": team["name"],
            "is_super": False, "is_system_admin": False, "token": token,
        }

    raise HTTPException(401, "비밀번호가 틀렸습니다")
