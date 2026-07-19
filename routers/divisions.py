"""
본부 관리 API
- 본부 목록 조회 (공개 — 팀 선택 화면용)
- 본부 생성 / 수정 / 삭제 (시스템 관리자 전용)
"""
import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, now_sql
from pydantic import BaseModel
from routers.auth import require_auth, require_system_admin
from routers.org_labels import get_org_labels, josa

router = APIRouter(prefix="/api/divisions", tags=["divisions"])


# ── 모델 ──────────────────────────────────────────────

class DivisionCreate(BaseModel):
    slug: str
    name: str
    admin_pw: str = ""    # 본부 관리자 비밀번호 (선택)
    head_name: str = ""   # 본부장 (선택)

class DivisionUpdate(BaseModel):
    name: str = ""
    admin_pw: str = ""
    head_name: str | None = None


# ── 엔드포인트 ────────────────────────────────────────

@router.get("")
async def list_divisions(db: AsyncSession = Depends(get_db)):
    """본부 목록 (랜딩/팀 선택 화면용 — 비인증)"""
    result = await db.execute(text(
        "SELECT id, slug, name, head_name FROM divisions ORDER BY id"
    ))
    return [dict(r) for r in result.mappings().all()]


@router.get("/{slug}/teams")
async def list_division_teams(slug: str, db: AsyncSession = Depends(get_db)):
    """특정 본부 소속 팀 목록"""
    div_res = await db.execute(text("SELECT id FROM divisions WHERE slug=:slug"), {"slug": slug})
    div = div_res.mappings().first()
    if not div:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['division'], '을')} 찾을 수 없습니다")
    result = await db.execute(text(
        "SELECT id, slug, name FROM teams WHERE division_id=:did ORDER BY id"
    ), {"did": div["id"]})
    return [dict(r) for r in result.mappings().all()]


async def _ensure_division_hq(db: AsyncSession, div_slug: str, head_name: str):
    """그룹장 지정 시 그룹장을 '그룹 소속 구성원'으로 자동 보장.

    members 는 team_id 가 필수라 컨테이너 row 가 하나 필요하다(`divhq-{slug}`).
    이건 '별도 유닛'이 아니라 **그룹 자체를 가리키는 내부 컨테이너**다:
      - 팀명 = 그룹명 그대로 ('직속' 같은 가짜 조직명 만들지 않음)
      - leader_name 을 두지 않음 → 이 사람은 '유닛장'이 아니라 '그룹장'
      - 유닛 목록/유닛 수 집계에서는 제외되고, picker 에서는 유닛들과 나란히 그룹장 카드로 노출
    """
    head = (head_name or "").strip()
    if not head:
        return
    d = (await db.execute(text("SELECT id, name FROM divisions WHERE slug=:s"), {"s": div_slug})).mappings().first()
    if not d:
        return
    hq_slug = f"divhq-{div_slug}"
    t = (await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": hq_slug})).mappings().first()
    if t:
        tid = t["id"]
        await db.execute(text("UPDATE teams SET division_id=:d, name=:n, leader_name=NULL WHERE id=:i"),
                         {"d": d["id"], "n": d["name"], "i": tid})
    else:
        r = await db.execute(text(f"""
            INSERT INTO teams (slug, name, division_id, created_at)
            VALUES (:s, :n, :d, {now_sql}) RETURNING id
        """), {"s": hq_slug, "n": d["name"], "d": d["id"]})
        tid = r.scalar()
    # 그룹장 구성원 보장 (있으면 그대로 — PIN 유지)
    m = (await db.execute(text("SELECT id FROM members WHERE name=:n AND team_id=:t"), {"n": head, "t": tid})).mappings().first()
    if not m:
        await db.execute(text(f"""
            INSERT INTO members (name, role, position, title, project, team_id, is_report_target, created_at)
            VALUES (:n, 'etc', '', :ti, '', :t, FALSE, {now_sql})
        """), {"n": head, "t": tid, "ti": "그룹장"})


@router.post("")
async def create_division(
    body: DivisionCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """본부 생성 (시스템 관리자 전용)"""
    pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode() if body.admin_pw else None
    try:
        await db.execute(text(f"""
            INSERT INTO divisions (slug, name, admin_pw_hash, head_name, created_at)
            VALUES (:slug, :name, :pw_hash, :head, {now_sql})
        """), {"slug": body.slug, "name": body.name, "pw_hash": pw_hash, "head": body.head_name or None})
        await _ensure_division_hq(db, body.slug, body.head_name)
        await db.commit()
    except Exception as e:
        raise HTTPException(400, f"{(await get_org_labels(db))['division']} 생성 실패: {str(e)}")
    return {"ok": True}


@router.put("/{slug}")
async def update_division(
    slug: str,
    body: DivisionUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """본부 정보 수정 (시스템 관리자 전용)"""
    if body.name:
        await db.execute(
            text("UPDATE divisions SET name=:name WHERE slug=:slug"),
            {"name": body.name, "slug": slug},
        )
    if body.admin_pw:
        pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode()
        await db.execute(
            text("UPDATE divisions SET admin_pw_hash=:h WHERE slug=:slug"),
            {"h": pw_hash, "slug": slug},
        )
    if body.head_name is not None:
        await db.execute(
            text("UPDATE divisions SET head_name=:v WHERE slug=:slug"),
            {"v": body.head_name or None, "slug": slug},
        )
        await _ensure_division_hq(db, slug, body.head_name)
    await db.commit()
    return {"ok": True}


@router.delete("/{slug}")
async def delete_division(
    slug: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """본부 삭제 (시스템 관리자 전용) — 소속 팀이 있으면 삭제 불가"""
    check = await db.execute(text("""
        SELECT COUNT(*) FROM teams
        WHERE division_id = (SELECT id FROM divisions WHERE slug=:slug)
    """), {"slug": slug})
    if (check.scalar() or 0) > 0:
        raise HTTPException(400, "하위 조직이 있어 삭제할 수 없습니다. 먼저 하위 조직을 이동하거나 삭제하세요.")
    await db.execute(text("DELETE FROM divisions WHERE slug=:slug"), {"slug": slug})
    await db.commit()
    return {"ok": True}
