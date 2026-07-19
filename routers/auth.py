"""
PIN 인증 & 관리자 로그인 API
- 토큰 기반 세션 관리 (sessions 테이블)
- 팀 관리자 / 시스템 관리자 구분
"""
import os
import secrets
import bcrypt
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, now_sql
from models import LoginRequest, LoginResponse, AdminLoginRequest, ResetPinRequest
from routers.team_deps import get_team_id

router = APIRouter(prefix="/api", tags=["auth"])

ADMIN_PW        = os.getenv("ADMIN_PW", "1234")
SYSTEM_ADMIN_PW = os.getenv("SYSTEM_ADMIN_PW", "")  # 시스템 관리자 전용 PW

SESSION_DAYS = 7  # 세션 유효기간


# ── 헬퍼 ──────────────────────────────────────────────

def _get_kst_now() -> str:
    return (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")

def _make_expires() -> str:
    return (datetime.utcnow() + timedelta(hours=9, days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")

def hash_pin(pin: str) -> str:
    return bcrypt.hashpw(pin.encode(), bcrypt.gensalt()).decode()

def verify_pin(pin: str, hashed: str) -> bool:
    return bcrypt.checkpw(pin.encode(), hashed.encode())

async def _issue_token(
    db: AsyncSession,
    identity: str,
    team_id: int | None = None,
    is_admin: bool = False,
    is_system_admin: bool = False,
) -> str:
    """세션 토큰 발급 및 DB 저장"""
    token   = secrets.token_urlsafe(32)
    expires = _make_expires()
    await db.execute(text(f"""
        INSERT INTO sessions
            (token, identity, team_id, is_admin, is_system_admin, created_at, expires_at)
        VALUES
            (:token, :identity, :team_id, :is_admin, :is_sys, {now_sql}, :expires)
    """), {
        "token":    token,
        "identity": identity,
        "team_id":  team_id,
        "is_admin": bool(is_admin),
        "is_sys":   bool(is_system_admin),
        "expires":  expires,
    })
    await db.commit()
    return token


# ── 인증 의존성 ────────────────────────────────────────

async def require_auth(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    """X-Auth-Token 헤더로 세션 검증. 만료/미존재 시 401."""
    token = request.headers.get("X-Auth-Token")
    if not token:
        raise HTTPException(401, "인증이 필요합니다")
    now = _get_kst_now()
    res = await db.execute(
        text("SELECT * FROM sessions WHERE token=:t AND expires_at > :now"),
        {"t": token, "now": now},
    )
    row = res.mappings().first()
    if not row:
        raise HTTPException(401, "세션이 만료되었습니다. 다시 로그인해주세요.")
    return dict(row)


async def require_team_admin(auth: dict = Depends(require_auth)) -> dict:
    """팀 관리자 또는 시스템 관리자 권한 필요"""
    if not (auth.get("is_admin") or auth.get("is_system_admin")):
        raise HTTPException(403, "관리자 권한이 필요합니다")
    return auth


async def require_system_admin(auth: dict = Depends(require_auth)) -> dict:
    """시스템 관리자 전용"""
    if not auth.get("is_system_admin"):
        raise HTTPException(403, "시스템 관리자 권한이 필요합니다")
    return auth


async def is_report_approver(auth: dict, db: AsyncSession) -> bool:
    """결재권자(보고받는 사람) 판정 — 팀장 전용.
    - 관리자(팀/시스템, admin_pw 로그인)는 항상 True. (주간보고 담당자는 admin_pw 로 콘솔 접근)
    - PIN 세션은 그 사람이 자기 팀(team_id)의 '팀장(leader_name)'일 때만 True.
      → 주간보고 담당자(report_admin)는 PIN 로그인 시 결재권자 아님 (일반 작성폼). 콘솔은 admin_pw 로.
    팀원 보고 열람 + AI 요약 같은 '읽기/요약' 권한에만 사용."""
    if auth.get("is_admin") or auth.get("is_system_admin"):
        return True
    identity = auth.get("identity")
    tid = auth.get("team_id")
    if not identity or not tid:
        return False
    r = await db.execute(text(
        "SELECT 1 FROM teams WHERE id = :tid AND leader_name = :n"
    ), {"tid": tid, "n": identity})
    return r.first() is not None


async def division_head_ids(auth: dict, db: AsyncSession) -> list:
    """그룹장(상위조직장) 판정 — PIN 세션 이름이 divisions.head_name 과 일치하는 division id 목록.
    (팀장 leader_name 매칭과 동일 패턴. 겸직 가능 — 여러 그룹장이면 전부 반환. 아니면 빈 리스트)"""
    identity = auth.get("identity") or ""
    if not identity or identity.startswith("__"):
        return []
    r = await db.execute(text(
        "SELECT id FROM divisions WHERE head_name = :n ORDER BY id"
    ), {"n": identity})
    return [row[0] for row in r.fetchall()]


async def require_report_approver(auth: dict = Depends(require_auth), db: AsyncSession = Depends(get_db)) -> dict:
    """결재권자(팀장/주간보고 담당자) 또는 관리자 권한 필요."""
    if not await is_report_approver(auth, db):
        raise HTTPException(403, "주간보고 담당자(결재권자 포함) 권한이 필요합니다")
    return auth


# ── 팀원 PIN 로그인 ────────────────────────────────────

@router.post("/auth/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
):
    # 팀원 존재 확인
    res = await db.execute(
        text("SELECT name FROM members WHERE name = :name AND team_id = :tid"),
        {"name": body.name, "tid": tid},
    )
    member = res.mappings().first()
    if not member:
        raise HTTPException(404, "명단에 등록된 사용자가 아닙니다")

    verified_name = member["name"]

    # PIN 조회
    pin_res = await db.execute(
        text("SELECT pin_hash FROM pins WHERE member_name = :name AND team_id = :tid"),
        {"name": verified_name, "tid": tid},
    )
    pin_row = pin_res.mappings().first()

    if pin_row:
        if not verify_pin(body.pin, pin_row["pin_hash"]):
            raise HTTPException(401, "PIN이 틀렸습니다")
        token = await _issue_token(db, verified_name, team_id=tid)
        announcement = await _consume_admin_pw_announcement(db, tid, verified_name)
        await db.commit()
        return LoginResponse(success=True, message="로그인 성공", is_new=False, name=verified_name, token=token, admin_pw_announcement=announcement)
    else:
        # 최초 등록
        hashed = hash_pin(body.pin)
        await db.execute(text(
            f"INSERT INTO pins (member_name, pin_hash, created_at, team_id)"
            f" VALUES (:name, :hashed, {now_sql}, :tid)"
        ), {"name": verified_name, "hashed": hashed, "tid": tid})
        token = await _issue_token(db, verified_name, team_id=tid)
        announcement = await _consume_admin_pw_announcement(db, tid, verified_name)
        await db.commit()
        return LoginResponse(
            success=True,
            message=f"{verified_name}님 PIN이 등록되었습니다",
            is_new=True,
            name=verified_name,
            token=token,
            admin_pw_announcement=announcement,
        )


async def _consume_admin_pw_announcement(db: AsyncSession, team_id: int, member_name: str) -> dict | None:
    """
    로그인한 팀원이 주간보고 관리자(정 또는 부)로 지정되어 있고,
    pending 평문 비밀번호가 있으면 → 1회용 안내 반환 + 해당 슬롯 NULL 처리.
    """
    res = await db.execute(text("""
        SELECT report_admin_primary, report_admin_secondary,
               pending_admin_pw_primary, pending_admin_pw_secondary
          FROM teams WHERE id = :tid
    """), {"tid": team_id})
    row = res.mappings().first()
    if not row:
        return None

    role = None
    pw = None
    if row["report_admin_primary"] == member_name and row["pending_admin_pw_primary"]:
        role = "정"
        pw = row["pending_admin_pw_primary"]
        await db.execute(text(
            "UPDATE teams SET pending_admin_pw_primary = NULL WHERE id = :tid"
        ), {"tid": team_id})
    elif row["report_admin_secondary"] == member_name and row["pending_admin_pw_secondary"]:
        role = "부"
        pw = row["pending_admin_pw_secondary"]
        await db.execute(text(
            "UPDATE teams SET pending_admin_pw_secondary = NULL WHERE id = :tid"
        ), {"tid": team_id})
    else:
        return None

    return {"role": role, "password": pw}


# ── 관리자 로그인 (팀 관리자 / 시스템 관리자 통합) ───────

@router.post("/admin/login")
async def admin_login(
    body: AdminLoginRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
):
    """
    비밀번호로 관리자 로그인.
    우선순위:
      1) SYSTEM_ADMIN_PW 일치  → 시스템 관리자 세션
      2) 팀별 admin_pw_hash 일치 → 팀 관리자 세션
      3) 전역 ADMIN_PW 일치     → 팀 관리자 세션 (하위 호환)
    """
    pw = body.password

    # 1) 시스템 관리자
    if SYSTEM_ADMIN_PW and pw == SYSTEM_ADMIN_PW:
        token = await _issue_token(db, "__sysadmin__", team_id=None, is_admin=True, is_system_admin=True)
        return {"success": True, "message": "시스템 관리자 인증 성공", "token": token, "is_system_admin": True}

    # 2) 팀별 비밀번호 (bcrypt)
    team_res = await db.execute(text("SELECT admin_pw_hash FROM teams WHERE id = :tid"), {"tid": tid})
    team_row = team_res.mappings().first()
    if team_row and team_row["admin_pw_hash"]:
        try:
            if bcrypt.checkpw(pw.encode(), team_row["admin_pw_hash"].encode()):
                token = await _issue_token(db, f"__admin__:{tid}", team_id=tid, is_admin=True)
                return {"success": True, "message": "관리자 인증 성공", "token": token, "is_system_admin": False}
        except Exception:
            pass

    # 3) 전역 ADMIN_PW (하위 호환)
    if pw == ADMIN_PW:
        token = await _issue_token(db, f"__admin__:{tid}", team_id=tid, is_admin=True)
        return {"success": True, "message": "관리자 인증 성공", "token": token, "is_system_admin": False}

    raise HTTPException(401, "비밀번호가 틀렸습니다")


# ── 로그아웃 ───────────────────────────────────────────

@router.post("/auth/logout")
async def logout(request: Request, db: AsyncSession = Depends(get_db)):
    token = request.headers.get("X-Auth-Token")
    if token:
        await db.execute(text("DELETE FROM sessions WHERE token=:t"), {"t": token})
        await db.commit()
    return {"ok": True}


# ── PIN 초기화 (관리자만, main 보안 패치 보존) ──────────

@router.post("/auth/reset-pin")
async def reset_pin(
    body: ResetPinRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """관리자용 PIN 초기화"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 PIN을 초기화할 수 있습니다")
    await db.execute(
        text("DELETE FROM pins WHERE member_name = :name AND team_id = :tid"),
        {"name": body.name, "tid": tid},
    )
    await db.commit()
    return {"ok": True, "message": f"{body.name}님 PIN이 초기화되었습니다"}
