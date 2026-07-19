"""
시스템 관리자 전용 API
- 전역 설정 관리 (team_id = 0)
- AI 프롬프트 관리 (전역 기본값 + 팀별 추가 설정 통합 조회/수정)
- 조직 현황 (본부 + 팀 목록)
- 시스템 현황 통계
"""
import json
import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db, now_sql, IS_DEV, is_postgres
from pydantic import BaseModel
from routers.auth import require_system_admin
from routers.org_labels import get_org_labels, josa

router = APIRouter(prefix="/api/system-admin", tags=["system_admin"])

# team_id=0 → 전역(시스템) 설정 슬롯
GLOBAL_TEAM_ID = 0


# ── 모델 ──────────────────────────────────────────────

class SettingUpsert(BaseModel):
    value: str  # JSON 문자열 또는 일반 문자열

class TeamCreate(BaseModel):
    slug: str
    name: str
    division_id: int | None = None
    admin_pw: str = ""
    leader_name: str = ""              # 팀장명 (조직도용)
    report_admin_primary: str = ""     # 주간보고 관리자 (정)
    report_admin_secondary: str = ""   # 주간보고 관리자 (부)

class TeamUpdate(BaseModel):
    name: str = ""
    division_id: int | None = None
    admin_pw: str = ""
    leader_name: str | None = None
    report_admin_primary: str | None = None
    report_admin_secondary: str | None = None

class PromptUpdate(BaseModel):
    content: str   # 프롬프트 원문 (JSON 아닌 plain text)

class TeamPromptUpdate(BaseModel):
    team_id: int
    content: str


# ── 조직 현황 ──────────────────────────────────────────

@router.get("/org")
async def get_org(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """본부 + 팀 전체 계층 구조 (팀은 본부 순서 → 팀 id 순)"""
    div_res = await db.execute(text("SELECT id, slug, name, head_name FROM divisions ORDER BY id"))
    divisions = [dict(r) for r in div_res.mappings().all()]

    # 본부 미지정(NULL)은 맨 뒤로
    team_res = await db.execute(text("""
        SELECT id, slug, name, division_id, leader_name, report_admin_primary, report_admin_secondary
          FROM teams
         ORDER BY COALESCE(division_id, 9999), id
    """))
    teams = [dict(r) for r in team_res.mappings().all()]

    # 팀별 멤버 수
    # 집계 대상 = 목록 노출(is_visible) AND 집계대상(is_report_target). 둘 중 하나라도 OFF면 카운트 제외.
    cnt_res = await db.execute(text("SELECT team_id, COUNT(*) as cnt FROM members WHERE COALESCE(is_visible, TRUE) = TRUE AND COALESCE(is_report_target, TRUE) = TRUE GROUP BY team_id"))
    member_counts = {r["team_id"]: r["cnt"] for r in cnt_res.mappings().all()}

    for t in teams:
        t["member_count"] = member_counts.get(t["id"], 0)

    return {"divisions": divisions, "teams": teams}


# ── 팀 관리 (시스템 관리자용) ──────────────────────────

@router.post("/teams")
async def create_team(
    body: TeamCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 생성"""
    pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode() if body.admin_pw else None
    # 주간보고 관리자가 지정되었고 admin_pw 도 설정되었다면 → 1회용 평문 안내용으로 저장
    pending_pw_1 = body.admin_pw if (body.admin_pw and body.report_admin_primary) else None
    pending_pw_2 = body.admin_pw if (body.admin_pw and body.report_admin_secondary) else None
    try:
        await db.execute(text(f"""
            INSERT INTO teams (slug, name, division_id, admin_pw_hash, leader_name, report_admin_primary, report_admin_secondary, pending_admin_pw_primary, pending_admin_pw_secondary, created_at)
            VALUES (:slug, :name, :did, :pw_hash, :leader, :ra1, :ra2, :pp1, :pp2, {now_sql})
        """), {
            "slug": body.slug, "name": body.name, "did": body.division_id, "pw_hash": pw_hash,
            "leader": body.leader_name or None,
            "ra1":    body.report_admin_primary or None,
            "ra2":    body.report_admin_secondary or None,
            "pp1":    pending_pw_1,
            "pp2":    pending_pw_2,
        })
        await db.commit()
    except Exception as e:
        raise HTTPException(400, f"{(await get_org_labels(db))['team']} 생성 실패: {str(e)}")
    return {"ok": True}


async def _leader_label(db) -> str:
    """org_labels.leader 설정값(기본 '팀장'). 리더 지정 시 members.title 에 동기화할 값."""
    return (await get_org_labels(db))["leader"]


@router.put("/teams/{slug}")
async def update_team(
    slug: str,
    body: TeamUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 정보 수정"""
    if body.name:
        await db.execute(text("UPDATE teams SET name=:n WHERE slug=:s"), {"n": body.name, "s": slug})
    if body.division_id is not None:
        await db.execute(text("UPDATE teams SET division_id=:d WHERE slug=:s"), {"d": body.division_id, "s": slug})
    if body.leader_name is not None:
        await db.execute(text("UPDATE teams SET leader_name=:v WHERE slug=:s"), {"v": body.leader_name or None, "s": slug})
        # 동기화(팀 편집 기준): 팀장 지정 → 그 멤버 직책(title)=리더라벨, 기존 팀장 직책 해제
        _lbl = await _leader_label(db)
        _tr = (await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": slug})).mappings().first()
        if _tr:
            _tid = _tr["id"]
            _nl = (body.leader_name or "").strip()
            # 이 팀에서 기존에 직책=리더라벨 이던 (새 팀장이 아닌) 멤버 → 직책 해제
            await db.execute(text(
                "UPDATE members SET title='' WHERE team_id=:tid AND COALESCE(title,'')=:lbl AND name<>:nl"
            ), {"tid": _tid, "lbl": _lbl, "nl": _nl})
            # 새 팀장 → 직책=리더라벨
            if _nl:
                await db.execute(text(
                    "UPDATE members SET title=:lbl WHERE team_id=:tid AND name=:nl"
                ), {"lbl": _lbl, "tid": _tid, "nl": _nl})
    if body.report_admin_primary is not None:
        await db.execute(text("UPDATE teams SET report_admin_primary=:v WHERE slug=:s"), {"v": body.report_admin_primary or None, "s": slug})
    if body.report_admin_secondary is not None:
        await db.execute(text("UPDATE teams SET report_admin_secondary=:v WHERE slug=:s"), {"v": body.report_admin_secondary or None, "s": slug})

    # 비밀번호 변경 시: 해시 갱신 + (현재 지정된) 주간보고 관리자에게 1회용 평문 안내 셋업
    if body.admin_pw:
        pw_hash = bcrypt.hashpw(body.admin_pw.encode(), bcrypt.gensalt()).decode()
        await db.execute(text("UPDATE teams SET admin_pw_hash=:h WHERE slug=:s"), {"h": pw_hash, "s": slug})
        # 현재 팀의 ra1/ra2 조회 (방금 위에서 갱신했을 수도 있으므로 다시 읽음)
        cur = await db.execute(text(
            "SELECT report_admin_primary, report_admin_secondary FROM teams WHERE slug=:s"
        ), {"s": slug})
        ra = cur.mappings().first() or {}
        await db.execute(text("""
            UPDATE teams
               SET pending_admin_pw_primary   = CASE WHEN :ra1 IS NOT NULL AND :ra1 <> '' THEN :pw ELSE NULL END,
                   pending_admin_pw_secondary = CASE WHEN :ra2 IS NOT NULL AND :ra2 <> '' THEN :pw ELSE NULL END
             WHERE slug=:s
        """), {
            "ra1": ra.get("report_admin_primary"),
            "ra2": ra.get("report_admin_secondary"),
            "pw":  body.admin_pw,
            "s":   slug,
        })
    await db.commit()
    return {"ok": True}


@router.get("/teams/{slug}/members")
async def get_team_members(
    slug: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """특정 팀에 속한 멤버 목록 — 시스템 관리자 콘솔의 팀원 관리 모달 + 콤보박스용. 팀장/주보관리자 정보 동봉."""
    if not slug or slug == '__new__':
        return {"members": [], "team": None}
    # 팀 정보 (팀장/주보관리자 포함)
    tr = await db.execute(text("""
        SELECT id, slug, name, leader_name, report_admin_primary, report_admin_secondary
          FROM teams WHERE slug = :s
    """), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    # 멤버 (is_visible / has_pin / title 포함)
    # 정렬: 프로젝트(기타/빈값 마지막) → 직급(부장~사원) → 이름. 시스템 관리자 모달은 hidden 도 함께 반환.
    res = await db.execute(text("""
        SELECT m.id, m.name, m.position, COALESCE(m.title, '') as title,
               m.role, m.sub_role, m.project,
               m.sort_order,
               COALESCE(m.is_visible, TRUE) as is_visible,
               (p.pin_hash IS NOT NULL) as has_pin,
               p.created_at as pin_set_at
          FROM members m
          LEFT JOIN pins p ON p.member_name = m.name AND p.team_id = m.team_id
         WHERE m.team_id = :tid
         ORDER BY
           CASE WHEN COALESCE(m.project,'') = '' OR m.project = '기타' THEN 1 ELSE 0 END,
           COALESCE(m.project, ''),
           CASE m.position
             WHEN '부장' THEN 3 WHEN '차장' THEN 4 WHEN '과장' THEN 5
             WHEN '대리' THEN 6 WHEN '주임' THEN 7 WHEN '사원' THEN 8
             ELSE 99
           END,
           m.name
    """), {"tid": team["id"]})
    return {"team": dict(team), "members": [dict(r) for r in res.mappings().all()]}


class MemberVisibilityRequest(BaseModel):
    is_visible: bool


class TeamMemberCreate(BaseModel):
    name: str
    role: str = "etc"
    position: str = ""    # 직급 (사원/주임/대리/과장/차장/부장)
    title: str = ""       # 직책 (본부장/연구소장/이사/팀장 등) — 직급과 별개
    project: str = ""
    sub_role: str = ""


class TeamMemberUpdate(BaseModel):
    new_name: str | None = None
    role: str | None = None
    position: str | None = None
    title: str | None = None
    project: str | None = None
    sub_role: str | None = None


@router.post("/teams/{slug}/members")
async def add_team_member(
    slug: str,
    body: TeamMemberCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀원 추가 (시스템 관리자)"""
    tr = await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    try:
        await db.execute(text(f"""
            INSERT INTO members (name, role, position, title, project, sub_role, team_id, created_at)
            VALUES (:n, :r, :p, :ti, :proj, :sub, :tid, {now_sql})
        """), {
            "n": body.name, "r": body.role, "p": body.position, "ti": body.title,
            "proj": body.project, "sub": body.sub_role, "tid": team["id"],
        })
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(400, f"{(await get_org_labels(db))['member']} 추가 실패: {str(e)}")
    return {"ok": True}


@router.put("/teams/{slug}/members/{name}")
async def update_team_member(
    slug: str,
    name: str,
    body: TeamMemberUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀원 정보 수정 / 이름 변경 (시스템 관리자)"""
    tr = await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    tid = team["id"]

    fields = []
    params = {"name": name, "tid": tid}
    if body.role is not None:
        fields.append("role = :role"); params["role"] = body.role
    if body.position is not None:
        fields.append("position = :pos"); params["pos"] = body.position
    if body.title is not None:
        fields.append("title = :title"); params["title"] = body.title
    if body.project is not None:
        fields.append("project = :proj"); params["proj"] = body.project
    if body.sub_role is not None:
        fields.append("sub_role = :sub"); params["sub"] = body.sub_role
    if fields:
        await db.execute(text(f"UPDATE members SET {', '.join(fields)} WHERE name = :name AND team_id = :tid"), params)

    # 동기화(역방향): 멤버 직책을 리더라벨로 지정 → 그 사람을 이 팀의 팀장(leader_name)으로 승격(기존 팀장 강등)
    if body.title is not None:
        _lbl = await _leader_label(db)
        _final = body.new_name if (body.new_name and body.new_name != name) else name
        if body.title.strip() == _lbl:
            # 기존 팀장(다른 멤버) 직책 해제 후 리더 교체
            await db.execute(text(
                "UPDATE members SET title='' WHERE team_id=:tid AND COALESCE(title,'')=:lbl AND name<>:nm"
            ), {"tid": tid, "lbl": _lbl, "nm": name})
            await db.execute(text("UPDATE teams SET leader_name=:nl WHERE id=:tid"), {"nl": _final, "tid": tid})

    # 이름 변경 — PIN 초기화 + 같은 주차 reports 갱신
    if body.new_name and body.new_name != name:
        from datetime import date
        wk_iso = date.today().isocalendar()
        wk = f"{wk_iso[0]}-W{wk_iso[1]:02d}"
        try:
            await db.execute(text(
                "UPDATE members SET name = :new WHERE name = :old AND team_id = :tid"
            ), {"new": body.new_name, "old": name, "tid": tid})
            await db.execute(text(
                "DELETE FROM pins WHERE member_name = :n AND team_id = :tid"
            ), {"n": name, "tid": tid})
            await db.execute(text(
                "UPDATE reports SET member_name = :new WHERE member_name = :old AND week_key = :wk AND team_id = :tid"
            ), {"new": body.new_name, "old": name, "wk": wk, "tid": tid})
        except Exception:
            await db.rollback()
            raise HTTPException(400, f"이미 존재하는 이름입니다: {body.new_name}")
    await db.commit()
    return {"ok": True}


@router.delete("/teams/{slug}/members/{name}")
async def delete_team_member(
    slug: str,
    name: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀원 삭제 (시스템 관리자) — 현재 주차 보고서 + PIN + 팀원 모두 정리. 과거 이력은 보존."""
    tr = await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    tid = team["id"]
    from datetime import datetime, timedelta
    kst_now = datetime.utcnow() + timedelta(hours=9)
    iso = kst_now.isocalendar()
    wk = f"{iso[0]}-W{iso[1]:02d}"

    await db.execute(text("DELETE FROM reports WHERE member_name = :n AND week_key = :wk AND team_id = :tid"),
                     {"n": name, "wk": wk, "tid": tid})
    await db.execute(text("DELETE FROM pins WHERE member_name = :n AND team_id = :tid"),
                     {"n": name, "tid": tid})
    await db.execute(text("DELETE FROM members WHERE name = :n AND team_id = :tid"),
                     {"n": name, "tid": tid})
    await db.commit()
    return {"ok": True}


@router.put("/teams/{slug}/members/{name}/visibility")
async def set_member_visibility(
    slug: str,
    name: str,
    body: MemberVisibilityRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀원 로그인 화면 노출 토글 (시스템 관리자)"""
    tr = await db.execute(text("SELECT id FROM teams WHERE slug = :s"), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    upd = await db.execute(text("""
        UPDATE members SET is_visible = :v WHERE team_id = :tid AND name = :n
    """), {"v": bool(body.is_visible), "tid": team["id"], "n": name})
    await db.commit()
    return {"ok": True, "is_visible": bool(body.is_visible)}


@router.delete("/teams/{slug}/members/{name}/pin")
async def reset_member_pin(
    slug: str,
    name: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀원 PIN 초기화 (시스템 관리자 — 모든 팀의 멤버 PIN 초기화 가능)"""
    tr = await db.execute(text("SELECT id FROM teams WHERE slug = :s"), {"s": slug})
    team = tr.mappings().first()
    if not team:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")
    await db.execute(text(
        "DELETE FROM pins WHERE member_name = :n AND team_id = :tid"
    ), {"n": name, "tid": team["id"]})
    await db.commit()
    return {"ok": True}


# ── 신기능 안내 배너 (시스템 관리자 제어) ───────────────────
# - settings 키: banner_nonce, banner_override
# - banner_override 가 비어있으면 클라이언트 코드의 APP_VER_NOTES 사용
# - banner_nonce 가 변경되면 모든 사용자에게 강제 재노출 (클라이언트가 wr_banner_seen_nonce 와 비교)

class BannerOverride(BaseModel):
    enabled: bool = False
    version: str = ""        # 표시용 (선택)
    audience: str = "all"    # all | member | admin | system_admin
    title: str = ""
    sub: str = ""
    cta_text: str = ""
    cta_action: str = ""     # openSettings | showInstallPromo | ''


@router.get("/banner")
async def get_banner_config(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """현재 배너 override + nonce 조회"""
    res = await db.execute(text(
        "SELECT key, value FROM settings WHERE team_id = 0 AND key IN ('banner_override', 'banner_nonce')"
    ))
    raw = {r["key"]: r["value"] for r in res.mappings().all()}
    override = _parse_val(raw.get("banner_override")) or {}
    nonce = raw.get("banner_nonce") or ""
    return {"override": override, "nonce": nonce}


@router.put("/banner")
async def update_banner_override(
    body: BannerOverride,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """배너 override 콘텐츠 저장 (nonce 는 갱신 안 함 — 재노출하려면 별도 /banner/republish 호출)"""
    payload = json.dumps(body.dict(), ensure_ascii=False)
    await db.execute(text("""
        INSERT INTO settings (key, value, team_id) VALUES ('banner_override', :v, 0)
        ON CONFLICT (team_id, key) DO UPDATE SET value = excluded.value
    """), {"v": payload})
    await db.commit()
    return {"ok": True}


@router.post("/banner/republish")
async def republish_banner(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """배너 nonce 갱신 — 이미 닫은 사용자에게도 다시 한 번 노출"""
    import secrets
    new_nonce = secrets.token_hex(8)
    await db.execute(text("""
        INSERT INTO settings (key, value, team_id) VALUES ('banner_nonce', :v, 0)
        ON CONFLICT (team_id, key) DO UPDATE SET value = excluded.value
    """), {"v": new_nonce})
    await db.commit()
    return {"ok": True, "nonce": new_nonce}


@router.delete("/teams/{slug}")
async def delete_team(
    slug: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 삭제 (기본팀 보호)"""
    if slug == "default":
        raise HTTPException(400, f"기본 {josa((await get_org_labels(db))['team'], '은')} 삭제할 수 없습니다")
    await db.execute(text("DELETE FROM teams WHERE slug=:s"), {"s": slug})
    await db.commit()
    return {"ok": True}


# ── 주간보고 관리자 안내 재발송 ───────────────────────
#  쓰임새: 비밀번호 안내 모달을 못 봤거나(이미 로그인 상태였거나, 푸시 알림을 껐거나) 무심코 닫은 경우.
#  - pending_admin_pw 슬롯이 살아있으면 → 다음 로그인 시 모달이 자동 표시되므로 푸시만 발송
#  - pending_admin_pw 슬롯이 비어있으면 → "재안내가 필요하면 시스템 관리자에게 비밀번호 재설정 요청" 안내
@router.post("/teams/{slug}/notify-admin-pw")
async def notify_team_admin_pw(
    slug: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """주간보고 관리자(정/부)에게 비밀번호 안내 푸시 재발송"""
    res = await db.execute(text("""
        SELECT id, name, report_admin_primary, report_admin_secondary,
               pending_admin_pw_primary, pending_admin_pw_secondary
          FROM teams WHERE slug=:s
    """), {"s": slug})
    row = res.mappings().first()
    if not row:
        raise HTTPException(404, f"{josa((await get_org_labels(db))['team'], '을')} 찾을 수 없습니다")

    team_name = row["name"]
    targets   = []   # [(name, pending_alive_bool)]
    if row["report_admin_primary"]:
        targets.append((row["report_admin_primary"], bool(row["pending_admin_pw_primary"])))
    if row["report_admin_secondary"]:
        targets.append((row["report_admin_secondary"], bool(row["pending_admin_pw_secondary"])))

    if not targets:
        raise HTTPException(400, "지정된 주간보고 관리자가 없습니다")

    # 푸시 발송
    sent = 0
    no_sub = 0
    pending_alive = 0
    pending_gone = 0
    from routers.push import send_push_to_member
    for name, alive in targets:
        if alive:
            pending_alive += 1
            push_body = f"[{team_name}] 주간보고 관리자 비밀번호 안내가 있습니다. 시스템에 로그인하면 자동으로 표시됩니다."
        else:
            pending_gone += 1
            push_body = f"[{team_name}] 주간보고 관리자로 등록되어 있습니다. 비밀번호 안내가 필요하면 시스템 관리자에게 요청해주세요."

        # 구독 여부 확인
        check = await db.execute(
            text("SELECT COUNT(*) FROM push_subscriptions WHERE member_name=:n"),
            {"n": name},
        )
        if (check.scalar() or 0) == 0:
            no_sub += 1
            continue
        try:
            await send_push_to_member(
                member_name=name,
                title="🔔 주간보고 관리자 안내",
                body=push_body,
                url="/",
                db=db,
                tag="admin-pw-resend",
            )
            sent += 1
        except Exception as e:
            print(f"[Push] 안내 재발송 실패 ({name}): {e}")

    return {
        "ok": True,
        "team": team_name,
        "targets": [{"name": n, "pending_alive": a} for n, a in targets],
        "sent": sent,
        "no_subscription": no_sub,
        "pending_alive": pending_alive,
        "pending_gone": pending_gone,
    }


# ── 전역 설정 (team_id = 0) ────────────────────────────

@router.get("/settings")
async def get_global_settings(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전역 설정 전체 조회"""
    res = await db.execute(text(
        "SELECT key, value FROM settings WHERE team_id = 0 ORDER BY key"
    ))
    return {r["key"]: _parse_val(r["value"]) for r in res.mappings().all()}


@router.put("/settings/{key}")
async def upsert_global_setting(
    key: str,
    body: SettingUpsert,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전역 설정 저장/업데이트"""
    await db.execute(text("""
        INSERT INTO settings (key, value, team_id) VALUES (:key, :val, 0)
        ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value
    """), {"key": key, "val": body.value})
    await db.commit()
    return {"ok": True}


# ── AI 프롬프트 관리 ───────────────────────────────────

@router.get("/prompts")
async def get_all_prompts(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """
    전역 기본 프롬프트 + 모든 팀의 추가 프롬프트 + ai.py 의 시스템 default 통합 조회.
    시스템 관리자가 한 화면에서 전체를 파악할 수 있도록.
    """
    # ai.py 가 사용하는 default 텍스트 (사용자가 비워두면 이 값이 적용됨)
    from routers.ai import (
        DEFAULT_PERSONA_PROMPT,
        DEFAULT_ASSIST_PROMPT,
        DEFAULT_FORMAT_MEMBER_INDIVIDUAL,
        DEFAULT_FORMAT_MEMBER_GROUP,
        DEFAULT_FORMAT_PROJECT,
        DEFAULT_FORMAT_TEAM,
    )
    defaults = {
        "ai_persona":                  DEFAULT_PERSONA_PROMPT,
        "ai_assist_prompt":            DEFAULT_ASSIST_PROMPT,
        "ai_format_member_individual": DEFAULT_FORMAT_MEMBER_INDIVIDUAL,
        "ai_format_member_group":      DEFAULT_FORMAT_MEMBER_GROUP,
        "ai_format_project":           DEFAULT_FORMAT_PROJECT,
        "ai_format_team":              DEFAULT_FORMAT_TEAM,
    }

    # 전역 프롬프트 (team_id=0) — settings 에 사용자가 저장한 값
    global_res = await db.execute(text("""
        SELECT key, value FROM settings
        WHERE team_id = 0 AND key LIKE 'ai_%'
        ORDER BY key
    """))
    global_prompts = {r["key"]: r["value"] for r in global_res.mappings().all()}

    # 팀별 추가 프롬프트
    team_res = await db.execute(text("""
        SELECT t.id, t.name AS team_name, s.key, s.value
        FROM settings s
        JOIN teams t ON t.id = s.team_id
        WHERE s.team_id > 0 AND s.key LIKE 'ai_%addition%'
        ORDER BY s.team_id, s.key
    """))
    team_additions = {}
    for r in team_res.mappings().all():
        tid = r["id"]
        if tid not in team_additions:
            team_additions[tid] = {"team_id": tid, "team_name": r["team_name"], "additions": {}}
        team_additions[tid]["additions"][r["key"]] = r["value"]

    return {
        "global": global_prompts,          # 사용자가 settings 에 저장한 오버라이드 값
        "defaults": defaults,              # ai.py 의 시스템 기본값
        "team_additions": list(team_additions.values()),
    }


@router.delete("/prompts/global/{key}")
async def reset_global_prompt(
    key: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전역 AI 프롬프트 오버라이드 삭제 → 시스템 기본값으로 복원"""
    if not key.startswith("ai_"):
        raise HTTPException(400, "ai_ 접두사가 있는 키만 허용됩니다")
    await db.execute(
        text("DELETE FROM settings WHERE key=:key AND team_id=0"),
        {"key": key},
    )
    await db.commit()
    return {"ok": True}


@router.put("/prompts/global/{key}")
async def update_global_prompt(
    key: str,
    body: PromptUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전역 AI 프롬프트 저장 (ai_persona_prompt, ai_summary_prompt 등)"""
    if not key.startswith("ai_"):
        raise HTTPException(400, "ai_ 접두사가 있는 키만 허용됩니다")
    await db.execute(text("""
        INSERT INTO settings (key, value, team_id) VALUES (:key, :val, 0)
        ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value
    """), {"key": key, "val": body.content})
    await db.commit()
    return {"ok": True}


@router.put("/prompts/team/{team_id}/{key}")
async def update_team_prompt_addition(
    team_id: int,
    key: str,
    body: PromptUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """특정 팀의 추가 프롬프트 수정 (시스템 관리자가 팀 추가분을 직접 편집)"""
    if not key.startswith("ai_"):
        raise HTTPException(400, "ai_ 접두사가 있는 키만 허용됩니다")
    await db.execute(text("""
        INSERT INTO settings (key, value, team_id) VALUES (:key, :val, :tid)
        ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value
    """), {"key": key, "val": body.content, "tid": team_id})
    await db.commit()
    return {"ok": True}


@router.delete("/prompts/team/{team_id}/{key}")
async def delete_team_prompt_addition(
    team_id: int,
    key: str,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """팀 추가 프롬프트 삭제"""
    await db.execute(text(
        "DELETE FROM settings WHERE key=:key AND team_id=:tid"
    ), {"key": key, "tid": team_id})
    await db.commit()
    return {"ok": True}


# ── 시스템 현황 통계 ───────────────────────────────────

@router.get("/stats")
async def get_system_stats(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전사 통계 — 팀별 멤버 수 + 이번 주 제출 현황"""
    from datetime import datetime, timedelta
    kst_now = datetime.utcnow() + timedelta(hours=9)
    year, week, _ = kst_now.isocalendar()
    week_key = f"{year}-W{week:02d}"

    # 팀별 멤버 수 (+ 본부 정보) — 본부 순서 → 팀 id 순으로 정렬
    member_res = await db.execute(text("""
        SELECT t.id, t.name AS team_name,
               t.division_id, d.name AS division_name,
               COUNT(m.id) AS member_count
          FROM teams t
          LEFT JOIN members m  ON m.team_id = t.id AND COALESCE(m.is_visible, TRUE) = TRUE AND COALESCE(m.is_report_target, TRUE) = TRUE
          LEFT JOIN divisions d ON d.id = t.division_id
         GROUP BY t.id, t.name, t.division_id, d.name
         ORDER BY COALESCE(t.division_id, 9999), t.id
    """))
    teams = [dict(r) for r in member_res.mappings().all()]

    # 본부 목록 (이번 주 그룹 패널 헤더용)
    div_list_res = await db.execute(text("SELECT id, name FROM divisions ORDER BY id"))
    divisions = [dict(r) for r in div_list_res.mappings().all()]

    # 팀별 이번 주 제출 수
    # 집계 비대상 멤버의 보고는 제외 (member_count 와 분모/분자 일관성 유지 → submit_rate>100% 방지)
    submit_res = await db.execute(text("""
        SELECT r.team_id, COUNT(*) AS submit_count
        FROM reports r
        JOIN members m ON m.team_id = r.team_id AND m.name = r.member_name
                      AND COALESCE(m.is_visible, TRUE) = TRUE
                      AND COALESCE(m.is_report_target, TRUE) = TRUE
        WHERE r.week_key = :wk
        GROUP BY r.team_id
    """), {"wk": week_key})
    submit_counts = {r["team_id"]: r["submit_count"] for r in submit_res.mappings().all()}

    for t in teams:
        t["submit_count"] = submit_counts.get(t["id"], 0)
        t["submit_rate"] = round(
            t["submit_count"] / t["member_count"] * 100 if t["member_count"] else 0, 1
        )

    total_members = sum(t["member_count"] for t in teams)
    total_submits = sum(t["submit_count"] for t in teams)

    return {
        "week_key": week_key,
        "teams": teams,
        "divisions": divisions,
        "total_members": total_members,
        "total_submits": total_submits,
        "total_rate": round(total_submits / total_members * 100 if total_members else 0, 1),
    }


# ── 운영기 → 개발기 데이터 동기화 (Neon 스키마 직접 복사) ─────────
# 운영기(public 스키마)와 개발기(dev 스키마)가 같은 Neon DB에 있으므로
# HTTP 호출 없이 같은 커넥션 안에서 INSERT INTO dev.X SELECT FROM public.X 로 처리.

# sessions 는 의도적으로 제외 — 동기화 시 현재 시스템 관리자 토큰이 무효화되어
# 곧바로 401 이 떨어지고, 운영기 사용자 세션이 dev 로 넘어와 인증되는 보안 문제도 있음
_SYNC_TABLES = [
    "divisions",
    "teams",
    "members",
    "pins",
    "settings",
    "reports",
    "summaries",
    "late_permissions",
    "push_subscriptions",
]


class SyncSelectiveRequest(BaseModel):
    tables: list[str] = []   # 비어있으면 _SYNC_TABLES 전체


@router.get("/sync-tables")
async def list_sync_tables(auth: dict = Depends(require_system_admin)):
    """동기화 가능한 테이블 목록 — 프론트 체크박스 UI 용"""
    return {"tables": _SYNC_TABLES}


@router.post("/sync-from-prod")
async def sync_from_prod(
    body: SyncSelectiveRequest | None = None,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """
    운영기(public 스키마) → 개발기(dev 스키마) 선택적 복사.
    body.tables 가 비어있으면 _SYNC_TABLES 전체, 아니면 선택한 테이블만.
    개발 환경에서만 허용.
    """
    if not IS_DEV:
        raise HTTPException(403, "운영 환경에서는 실행할 수 없습니다")
    if not is_postgres:
        raise HTTPException(400, "PostgreSQL 환경에서만 지원됩니다")

    requested = (body.tables if body and body.tables else _SYNC_TABLES)
    target_tables = [t for t in requested if t in _SYNC_TABLES]
    if not target_tables:
        raise HTTPException(400, "선택된 동기화 대상 테이블이 없습니다")

    results = []
    errors  = []

    for table in target_tables:
        await db.execute(text(f"SAVEPOINT sp_{table}"))
        try:
            # public 테이블 존재 여부 (information_schema 사용 — Neon Pooler 호환)
            exists = await db.execute(text("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = :t
                )
            """), {"t": table})
            if not exists.scalar():
                await db.execute(text(f"RELEASE SAVEPOINT sp_{table}"))
                results.append({"table": table, "rows": 0, "skipped": "운영기에 없음"})
                continue

            # dev ∩ public 공통 컬럼 (information_schema.columns — pg_catalog 는 Neon Pooler 에서 0행 반환)
            dev_res = await db.execute(text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'dev' AND table_name = :t
            """), {"t": table})
            dev_cols = {r[0] for r in dev_res.fetchall()}

            pub_res = await db.execute(text("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = :t
            """), {"t": table})
            pub_cols = {r[0] for r in pub_res.fetchall()}

            cols = sorted(dev_cols & pub_cols)
            print(f"[SYNC] {table}: 공통 컬럼 {len(cols)}개 → {cols}")
            if not cols:
                errors.append({"table": table, "error": "공통 컬럼 없음"})
                await db.execute(text(f"RELEASE SAVEPOINT sp_{table}"))
                continue

            col_list = ", ".join(cols)

            # dev 테이블 비우고 공통 컬럼 기준으로 복사
            await db.execute(text(f"TRUNCATE dev.{table} RESTART IDENTITY CASCADE"))
            result = await db.execute(text(
                f"INSERT INTO dev.{table} ({col_list}) SELECT {col_list} FROM public.{table}"
            ))
            count = result.rowcount
            results.append({"table": table, "rows": count})
            await db.execute(text(f"RELEASE SAVEPOINT sp_{table}"))
        except Exception as e:
            await db.execute(text(f"ROLLBACK TO SAVEPOINT sp_{table}"))
            print(f"[SYNC ERROR] {table}: {e}")
            errors.append({"table": table, "error": str(e)})

    await db.commit()

    return {
        "ok": True,
        "synced": results,
        "errors": errors,
        "message": f"{len(results)}개 테이블 동기화 완료" + (f", {len(errors)}개 오류" if errors else ""),
    }


@router.get("/export-all")
async def export_all(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전체 데이터 JSON 내보내기 (백업/이관용)"""
    _EXPORT = ["divisions", "teams", "members", "pins", "settings", "reports", "summaries", "late_permissions"]
    data = {}
    for table in _EXPORT:
        try:
            r = await db.execute(text(f"SELECT * FROM {table}"))
            data[table] = [dict(row) for row in r.mappings().all()]
        except Exception:
            data[table] = []
    return data


# ── 조직도 CSV (엑셀 편집용) ─────────────────────────────
# 컬럼 매핑: [0]=divisions.name [1]=divisions.head_name [2]=teams.name [3]=teams.leader_name
# 앞 4개 헤더명은 조직 호칭 설정을 따른다(그룹/유닛 등). 파싱은 전부 '위치 기반'이라
# 헤더명 자체는 사람이 읽는 라벨일 뿐이며, 형식 검증은 호칭과 무관한 뒤쪽 고정열로 한다.
ORG_CSV_FIXED_TAIL = ["주보관리자(정)", "주보관리자(부)", "이름", "직급", "직책", "프로젝트", "역할", "집계대상", "로그인노출"]
ORG_CSV_COLS = 4 + len(ORG_CSV_FIXED_TAIL)


def _org_csv_header(labels: dict) -> list:
    """내보내기용 헤더 — 조직 호칭 반영."""
    return [labels["division"], labels["division_head"], labels["team"], labels["leader"]] + ORG_CSV_FIXED_TAIL
_ROLE_TO_KOR = {"dev": "개발", "ops": "운영", "etc": "기타"}
_KOR_TO_ROLE = {"개발": "dev", "운영": "ops", "기타": "etc"}


@router.get("/org-csv")
async def export_org_csv(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """조직도 CSV 내보내기 — 멤버 1명 = 1행. 멤버 없는 유닛도 1행(이름 칸 공란)으로 포함."""
    import csv as _csv, io as _io
    # COALESCE(d.id, 999999): NULLS LAST 는 SQLite 호환이 불안해 정렬키로 대체
    r = await db.execute(text("""
        SELECT COALESCE(d.name, '')        AS grp,
               COALESCE(d.head_name, '')   AS grp_head,
               t.name                      AS unit,
               COALESCE(t.leader_name, '') AS unit_leader,
               COALESCE(t.report_admin_primary, '')   AS ra1,
               COALESCE(t.report_admin_secondary, '') AS ra2,
               COALESCE(m.name, '')        AS mname,
               COALESCE(m.position, '')    AS mpos,
               COALESCE(m.title, '')       AS mtitle,
               COALESCE(m.project, '')     AS mproj,
               COALESCE(m.role, '')        AS mrole,
               COALESCE(m.is_report_target, TRUE) AS tgt,
               COALESCE(m.is_visible, TRUE)       AS vis
        FROM teams t
        LEFT JOIN divisions d ON t.division_id = d.id
        LEFT JOIN members  m ON m.team_id = t.id
        ORDER BY COALESCE(d.id, 999999), t.id, COALESCE(m.sort_order, 0), COALESCE(m.id, 0)
    """))
    buf = _io.StringIO()
    w = _csv.writer(buf, lineterminator="\n")
    w.writerow(_org_csv_header(await get_org_labels(db)))
    for row in r.mappings().all():
        w.writerow([
            row["grp"], row["grp_head"], row["unit"], row["unit_leader"], row["ra1"], row["ra2"],
            row["mname"], row["mpos"], row["mtitle"], row["mproj"],
            _ROLE_TO_KOR.get(row["mrole"], row["mrole"] or ""),
            "Y" if row["tgt"] else "N",
            "Y" if row["vis"] else "N",
        ])
    # 유닛(팀)이 하나도 없는 그룹도 보존 — '유닛 칸이 빈 행'으로 내보냄 (없으면 반영 시 삭제로 오인)
    r2 = await db.execute(text(
        "SELECT d.name, COALESCE(d.head_name,'') AS head FROM divisions d "
        "WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.division_id = d.id) ORDER BY d.id"))
    for row in r2.mappings().all():
        w.writerow([row["name"], row["head"], "", "", "", "", "", "", "", "", "", "", ""])
    return {"csv": buf.getvalue()}


class OrgCsvBody(BaseModel):
    csv: str


def _parse_org_csv(csv_text: str):
    """CSV 텍스트 → (groups, units, errors). groups={이름:그룹장}, units={이름:{...members[]}}"""
    import csv as _csv, io as _io
    errors = []
    rows = list(_csv.reader(_io.StringIO(csv_text.lstrip("﻿"))))
    if not rows:
        return {}, {}, ["CSV가 비어있습니다"]
    header = [h.strip() for h in rows[0]]
    # 앞 4개 열 이름은 조직 호칭(그룹/유닛, 본부/팀 …)에 따라 달라지므로 이름 검증에서 제외한다.
    # 파싱이 위치 기반이라 실제로 필요한 것은 '열 개수 + 호칭 무관한 뒤쪽 고정열' 뿐 —
    # 이렇게 해야 호칭을 바꾼 뒤/다른 조직에서 내보낸 CSV 도 그대로 다시 읽을 수 있다.
    if len(header) != ORG_CSV_COLS or header[4:] != ORG_CSV_FIXED_TAIL:
        return {}, {}, [
            f"헤더가 양식과 다릅니다. {ORG_CSV_COLS}개 열이어야 하며 5번째 열부터 다음과 같아야 합니다: "
            f"{','.join(ORG_CSV_FIXED_TAIL)} (1~4번째 열은 조직 호칭에 따라 이름이 달라질 수 있습니다)"
        ]

    groups: dict = {}   # 그룹명 -> 그룹장
    units: dict = {}    # 유닛명 -> {group, leader, ra1, ra2, members: [..]}
    for i, raw in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in raw):
            continue
        v = [(raw[j].strip() if j < len(raw) else "") for j in range(ORG_CSV_COLS)]
        grp, gh, unit, ul, ra1, ra2, name, pos, title, proj, role, tgt, vis = v
        if not unit:
            # 유닛 칸이 빈 행 = '그룹 전용 행' (유닛 없는 그룹 보존용). 그룹까지 없으면 오류.
            if grp:
                if gh or grp not in groups:
                    groups[grp] = gh or groups.get(grp, "")
            else:
                errors.append(f"{i}행: 유닛명이 비어있습니다")
            continue
        if grp:
            if grp in groups and gh and groups[grp] and groups[grp] != gh:
                errors.append(f"{i}행: 그룹 '{grp}' 의 그룹장이 행마다 다릅니다 ('{groups[grp]}' vs '{gh}')")
            if gh or grp not in groups:
                groups[grp] = gh or groups.get(grp, "")
        u = units.setdefault(unit, {"group": grp, "leader": ul, "ra1": ra1, "ra2": ra2, "members": []})
        if u["group"] != grp:
            errors.append(f"{i}행: 유닛 '{unit}' 의 그룹이 행마다 다릅니다 ('{u['group']}' vs '{grp}')")
        for k, val in (("leader", ul), ("ra1", ra1), ("ra2", ra2)):
            if val and u[k] and u[k] != val:
                errors.append(f"{i}행: 유닛 '{unit}' 의 {k} 가 행마다 다릅니다")
            if val:
                u[k] = val
        if name:
            if any(m["name"] == name for m in u["members"]):
                errors.append(f"{i}행: 유닛 '{unit}' 에 '{name}' 이 중복입니다")
                continue
            if role and role not in _KOR_TO_ROLE:
                errors.append(f"{i}행: 역할은 개발/운영/기타 중 하나여야 합니다 ('{role}')")
            u["members"].append({
                "name": name, "position": pos, "title": title, "project": proj,
                "role": _KOR_TO_ROLE.get(role, "etc"),
                "is_report_target": (tgt.upper() != "N"),
                "is_visible": (vis.upper() != "N"),
            })
    return groups, units, errors


async def _build_org_plan(db: AsyncSession, groups: dict, units: dict):
    """CSV(그룹/유닛) ↔ DB(divisions/teams/members) 비교 → 전체 교체 계획. 이름 매칭으로 기존 ID 재사용."""
    db_divs = {r["name"]: dict(r) for r in (await db.execute(text("SELECT id, slug, name, head_name FROM divisions"))).mappings().all()}
    db_teams = {r["name"]: dict(r) for r in (await db.execute(text("SELECT id, slug, name, division_id, leader_name, report_admin_primary, report_admin_secondary FROM teams"))).mappings().all()}
    db_members = [dict(r) for r in (await db.execute(text("SELECT id, team_id, name FROM members"))).mappings().all()]
    tid_to_name = {t["id"]: n for n, t in db_teams.items()}

    plan = {"groups": {"create": [], "update": [], "delete": []},
            "units": {"create": [], "update": [], "delete": []},
            "members": {"create": [], "update": [], "move": [], "delete": []},
            "warnings": []}

    for gname, ghead in groups.items():
        if gname not in db_divs:
            plan["groups"]["create"].append({"name": gname, "head": ghead})
        elif (db_divs[gname]["head_name"] or "") != ghead:
            plan["groups"]["update"].append({"name": gname, "head": ghead})
    for gname in db_divs:
        if gname not in groups:
            plan["groups"]["delete"].append({"name": gname})

    default_slug_team = next((n for n, t in db_teams.items() if t["slug"] == "default"), None)
    for uname, u in units.items():
        if uname not in db_teams:
            plan["units"]["create"].append({"name": uname, "group": u["group"]})
        else:
            plan["units"]["update"].append({"name": uname, "group": u["group"]})
    for tname in db_teams:
        if tname not in units:
            if tname == default_slug_team:
                plan["warnings"].append(f"기본팀 '{tname}' 은 CSV에 없지만 삭제하지 않습니다(시스템 보호)")
            else:
                plan["units"]["delete"].append({"name": tname})

    # 멤버: (유닛명, 이름) 기준 비교. 사라진 (팀,이름) ↔ 새로 생긴 (팀,이름) 중 같은 이름은 '이동'으로 매칭
    csv_pairs = {(uname, m["name"]): m for uname, u in units.items() for m in u["members"]}
    db_pairs = {(tid_to_name.get(m["team_id"], f"#팀{m['team_id']}"), m["name"]): m for m in db_members}
    removed = {p: m for p, m in db_pairs.items() if p not in csv_pairs}
    added = {p: m for p, m in csv_pairs.items() if p not in db_pairs}
    moved_names = set()
    for (new_unit, name) in list(added.keys()):
        cand = next((p for p in removed if p[1] == name), None)
        if cand:
            plan["members"]["move"].append({"name": name, "from": cand[0], "to": new_unit})
            moved_names.add((new_unit, name)); removed.pop(cand)
    for p, m in added.items():
        if p not in moved_names:
            plan["members"]["create"].append({"unit": p[0], "name": p[1]})
    for p in removed:
        plan["members"]["delete"].append({"unit": p[0], "name": p[1]})
    plan["members"]["update"] = [{"unit": p[0], "name": p[1]} for p in csv_pairs if p in db_pairs]

    # 유닛장/주보관리자가 해당 유닛 멤버가 아니면 경고 (그룹장은 비멤버 허용)
    for uname, u in units.items():
        names = {m["name"] for m in u["members"]}
        for label, val in (("유닛장", u["leader"]), ("주보관리자(정)", u["ra1"]), ("주보관리자(부)", u["ra2"])):
            if val and val not in names:
                plan["warnings"].append(f"유닛 '{uname}' 의 {label} '{val}' 이 그 유닛 멤버 목록에 없습니다")
    return plan


@router.post("/org-csv/preview")
async def preview_org_csv(
    body: OrgCsvBody,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """CSV 업로드 미리보기 — 반영 없이 추가/변경/이동/삭제 계획만 반환"""
    groups, units, errors = _parse_org_csv(body.csv)
    if errors:
        return {"ok": False, "errors": errors}
    plan = await _build_org_plan(db, groups, units)
    return {"ok": True, "plan": plan}


@router.post("/org-csv/apply")
async def apply_org_csv(
    body: OrgCsvBody,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """CSV 반영 (전체 교체) — 유닛/그룹은 이름 매칭으로 기존 ID 재사용(보고·PIN·설정 보존).
    멤버 이동 시 PIN 도 함께 이동, 과거 보고는 원 유닛에 보존. 삭제 유닛의 보고/요약은 이력으로 남긴다."""
    groups, units, errors = _parse_org_csv(body.csv)
    if errors:
        raise HTTPException(400, "CSV 오류: " + " / ".join(errors[:5]))

    def _mkslug(prefix, used):
        i = 1
        while f"{prefix}-{i}" in used:
            i += 1
        used.add(f"{prefix}-{i}")
        return f"{prefix}-{i}"

    db_divs = {r["name"]: dict(r) for r in (await db.execute(text("SELECT id, slug, name FROM divisions"))).mappings().all()}
    db_teams = {r["name"]: dict(r) for r in (await db.execute(text("SELECT id, slug, name FROM teams"))).mappings().all()}
    used_slugs = {t["slug"] for t in db_teams.values()} | {d["slug"] for d in db_divs.values()}
    stats = {"groups": 0, "units": 0, "members": 0, "moved": 0, "deleted_members": 0, "deleted_units": 0}

    # 1) 그룹 upsert (이름 매칭)
    div_ids = {}
    for gname, ghead in groups.items():
        if gname in db_divs:
            await db.execute(text("UPDATE divisions SET head_name = :h WHERE id = :i"), {"h": ghead or None, "i": db_divs[gname]["id"]})
            div_ids[gname] = db_divs[gname]["id"]
        else:
            slug = _mkslug("group", used_slugs)
            r = await db.execute(text("INSERT INTO divisions (slug, name, head_name) VALUES (:s, :n, :h) RETURNING id"),
                                 {"s": slug, "n": gname, "h": ghead or None})
            div_ids[gname] = r.scalar()
        stats["groups"] += 1

    # 2) 유닛 upsert (이름 매칭 → ID 재사용)
    team_ids = {}
    for uname, u in units.items():
        did = div_ids.get(u["group"]) if u["group"] else None
        if uname in db_teams:
            tid = db_teams[uname]["id"]
            await db.execute(text("UPDATE teams SET division_id=:d, leader_name=:l, report_admin_primary=:r1, report_admin_secondary=:r2 WHERE id=:i"),
                             {"d": did, "l": u["leader"] or None, "r1": u["ra1"] or None, "r2": u["ra2"] or None, "i": tid})
        else:
            slug = _mkslug("unit", used_slugs)
            r = await db.execute(text("INSERT INTO teams (slug, name, division_id, leader_name, report_admin_primary, report_admin_secondary) VALUES (:s,:n,:d,:l,:r1,:r2) RETURNING id"),
                                 {"s": slug, "n": uname, "d": did, "l": u["leader"] or None, "r1": u["ra1"] or None, "r2": u["ra2"] or None})
            tid = r.scalar()
        team_ids[uname] = tid
        stats["units"] += 1

    # 3) 멤버 반영 — 이동 감지용 현재 상태
    db_members = [dict(r) for r in (await db.execute(text("SELECT id, team_id, name FROM members"))).mappings().all()]
    db_pairs = {(m["team_id"], m["name"]): m for m in db_members}
    # CSV 가 최종적으로 원하는 전체 (팀ID, 이름) 집합 — 이동/삭제 판정 기준
    csv_tid_pairs = {(team_ids[un], mm["name"]) for un, uu in units.items() for mm in uu["members"]}

    for uname, u in units.items():
        tid = team_ids[uname]
        for order, m in enumerate(u["members"]):
            params = {"t": tid, "n": m["name"], "p": m["position"], "ti": m["title"], "pr": m["project"],
                      "r": m["role"], "tg": m["is_report_target"], "v": m["is_visible"], "o": order}
            if (tid, m["name"]) in db_pairs:
                await db.execute(text("UPDATE members SET position=:p, title=:ti, project=:pr, role=:r, is_report_target=:tg, is_visible=:v, sort_order=:o WHERE team_id=:t AND name=:n"), params)
            else:
                # 같은 이름이 옛 유닛에서 빠지는 경우(=CSV 최종 집합에 없음) → '이동': 멤버 행/PIN 을 새 유닛으로 (아바타 보존)
                old = next(((otid, nm) for (otid, nm) in db_pairs if nm == m["name"] and (otid, nm) not in csv_tid_pairs), None)
                if old:
                    await db.execute(text("UPDATE members SET team_id=:t, position=:p, title=:ti, project=:pr, role=:r, is_report_target=:tg, is_visible=:v, sort_order=:o WHERE team_id=:ot AND name=:n"), {**params, "ot": old[0]})
                    await db.execute(text("UPDATE pins SET team_id=:t WHERE team_id=:ot AND member_name=:n"), {"t": tid, "ot": old[0], "n": m["name"]})
                    db_pairs.pop(old, None)
                    stats["moved"] += 1
                else:
                    await db.execute(text("INSERT INTO members (name, position, title, project, role, is_report_target, is_visible, sort_order, team_id) VALUES (:n,:p,:ti,:pr,:r,:tg,:v,:o,:t)"), params)
            stats["members"] += 1

    # 4) 삭제 — CSV에 없는 멤버(+PIN), CSV에 없는 유닛(멤버/PIN 삭제, 보고·요약은 이력 보존), 빈 그룹
    keep_tids = set(team_ids.values())
    for (tid, name) in list(db_pairs.keys()):
        if (tid, name) not in csv_tid_pairs and tid in keep_tids:
            await db.execute(text("DELETE FROM members WHERE team_id=:t AND name=:n"), {"t": tid, "n": name})
            await db.execute(text("DELETE FROM pins WHERE team_id=:t AND member_name=:n"), {"t": tid, "n": name})
            stats["deleted_members"] += 1
    for tname, t in db_teams.items():
        if tname not in units and t["slug"] != "default":
            await db.execute(text("DELETE FROM members WHERE team_id=:t"), {"t": t["id"]})
            await db.execute(text("DELETE FROM pins WHERE team_id=:t"), {"t": t["id"]})
            await db.execute(text("DELETE FROM teams WHERE id=:t"), {"t": t["id"]})
            stats["deleted_units"] += 1
    for gname, d in db_divs.items():
        if gname not in groups:
            ref = (await db.execute(text("SELECT COUNT(*) FROM teams WHERE division_id=:d"), {"d": d["id"]})).scalar()
            if not ref:
                await db.execute(text("DELETE FROM divisions WHERE id=:d"), {"d": d["id"]})

    await db.commit()
    return {"ok": True, "stats": stats}


@router.get("/env-info")
async def get_env_info(auth: dict = Depends(require_system_admin)):
    """현재 실행 환경 정보 (개발/운영)"""
    return {
        "is_dev": IS_DEV,
        "schema": "dev" if IS_DEV else "public",
        "env": "개발" if IS_DEV else "운영",
    }


# ── 샘플 조직도 시드 (가상 인물) — 오픈소스/신규 인스턴스 온보딩용 ─────
# 실제 인원은 코드에 두지 않는다. 조직 데이터는 전부 DB(+ 조직도 CSV 업로드)로 관리.
# 이 시드는 처음 세팅 시 “구조를 눈으로 보고 시작”하기 위한 가상 예시 데이터일 뿐이다.
_SAMPLE_ORG = [
    {
        "slug": "sample-group-a", "name": "1그룹", "head": "홍길동",
        "teams": [
            {"slug": "sample-unit-dev", "name": "개발 유닛", "leader": "김철수",
             "members": [("김철수", "과장"), ("이영희", "대리"), ("박민수", "사원")]},
            {"slug": "sample-unit-plan", "name": "기획 유닛", "leader": "최지은",
             "members": [("최지은", "과장"), ("정도윤", "대리")]},
        ],
    },
    {
        "slug": "sample-group-b", "name": "2그룹", "head": "강감찬",
        "teams": [
            {"slug": "sample-unit-ops", "name": "운영 유닛", "leader": "윤서연",
             "members": [("윤서연", "차장"), ("임하준", "사원"), ("한지민", "사원")]},
        ],
    },
]


class SeedOrgRequest(BaseModel):
    confirm: str = ""   # 운영 환경에서는 'I-CONFIRM-SEED-PROD' 입력 필요


@router.post("/seed-sample-org")
async def seed_sample_org(
    body: SeedOrgRequest | None = None,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """
    샘플 조직도(가상 인물) 일괄 등록 — 신규 인스턴스 온보딩용.
    그룹/유닛/멤버를 slug/name 기준 UPSERT. 멤버는 (team_id, name) 충돌 시 skip
    → 기존 데이터(PIN/sort_order/이미 등록된 멤버)는 유지되고 누락된 인원만 추가됨.

    운영 환경에서는 안전을 위해 body 에 confirm='I-CONFIRM-SEED-PROD' 가 필요.
    """
    if not IS_DEV:
        confirm_val = (body.confirm if body else "")
        if confirm_val != "I-CONFIRM-SEED-PROD":
            raise HTTPException(
                400,
                "운영 환경에서 실행하려면 confirm='I-CONFIRM-SEED-PROD' 가 필요합니다."
            )

    # PostgreSQL SERIAL 시퀀스 동기화 (이전에 수동 INSERT 흔적이 있으면 PK 충돌 방지)
    if is_postgres:
        for tbl in ("divisions", "teams", "members"):
            try:
                await db.execute(text(f"""
                    SELECT setval(
                        pg_get_serial_sequence('{tbl}', 'id'),
                        COALESCE((SELECT MAX(id) FROM {tbl}), 1)
                    )
                """))
            except Exception:
                pass

    div_done = 0
    team_done = 0
    member_done = 0
    member_skip = 0

    for div in _SAMPLE_ORG:
        # 그룹(division) UPSERT (slug 기준)
        r = await db.execute(text("SELECT id FROM divisions WHERE slug=:s"), {"s": div["slug"]})
        row = r.mappings().first()
        if row:
            await db.execute(text(
                "UPDATE divisions SET name=:n, head_name=:h WHERE slug=:s"
            ), {"n": div["name"], "h": div["head"], "s": div["slug"]})
            div_id = row["id"]
        else:
            await db.execute(text(f"""
                INSERT INTO divisions (slug, name, head_name, created_at)
                VALUES (:s, :n, :h, {now_sql})
            """), {"s": div["slug"], "n": div["name"], "h": div["head"]})
            r2 = await db.execute(text("SELECT id FROM divisions WHERE slug=:s"), {"s": div["slug"]})
            div_id = r2.mappings().first()["id"]
        div_done += 1

        # 소속 팀 UPSERT
        for t in div.get("teams", []):
            r = await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": t["slug"]})
            row = r.mappings().first()
            if row:
                await db.execute(text("""
                    UPDATE teams SET name=:n, division_id=:did, leader_name=:l WHERE slug=:s
                """), {"n": t["name"], "did": div_id, "l": t.get("leader") or None, "s": t["slug"]})
                team_id = row["id"]
            else:
                await db.execute(text(f"""
                    INSERT INTO teams (slug, name, division_id, leader_name, created_at)
                    VALUES (:s, :n, :did, :l, {now_sql})
                """), {"s": t["slug"], "n": t["name"], "did": div_id, "l": t.get("leader") or None})
                r2 = await db.execute(text("SELECT id FROM teams WHERE slug=:s"), {"s": t["slug"]})
                team_id = r2.mappings().first()["id"]
            team_done += 1

            # 멤버 추가 (같은 team_id+name 있으면 skip, IntegrityError 도 skip 처리)
            for name, position in t.get("members", []):
                exists = await db.execute(text("""
                    SELECT 1 FROM members WHERE team_id=:tid AND name=:n
                """), {"tid": team_id, "n": name})
                if exists.scalar():
                    member_skip += 1
                    continue
                role = "etc"
                # SAVEPOINT 로 보호 — 옛 SQLite DB 의 name UNIQUE 제약 등 IntegrityError 시 트랜잭션 깨지지 않고 skip
                try:
                    async with db.begin_nested():
                        await db.execute(text(f"""
                            INSERT INTO members (name, role, position, team_id, created_at)
                            VALUES (:n, :r, :p, :tid, {now_sql})
                        """), {"n": name, "r": role, "p": position, "tid": team_id})
                    member_done += 1
                except Exception as ie:
                    # 무결성/제약 위반 등 → skip 처리
                    member_skip += 1

    await db.commit()
    return {
        "ok": True,
        "divisions": div_done,
        "teams": team_done,
        "members_inserted": member_done,
        "members_skipped": member_skip,
        "message": f"본부 {div_done}, 팀 {team_done}, 멤버 신규 {member_done} (중복 skip {member_skip})",
    }


# ── 내부 헬퍼 ─────────────────────────────────────────

def _parse_val(val: str):
    if val is None:
        return None
    try:
        return json.loads(val)
    except Exception:
        return val


# ═══════════════════════════════════════════════════════════
#  전사 구성원 마스터 (31차) — 조회 / 일괄 처리
#  단일 진실 공급원: 그룹장·유닛장·직속 구성원 지정 시 여기서 조회해 참조한다.
#  (자유 텍스트 입력은 오타로 매칭이 깨져 조직도 사고를 유발 — CHANGELOG 30차-b 참고)
# ═══════════════════════════════════════════════════════════
@router.get("/members")
async def list_all_members(
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """전사 구성원 목록 — 소속·직급·직책·PIN·재직상태·입사일. 겸직은 소속별 각 행으로 반환."""
    rows = (await db.execute(text("""
        SELECT m.id, m.name, m.role, COALESCE(m.position,'') AS position,
               COALESCE(m.title,'') AS title, COALESCE(m.project,'') AS project,
               COALESCE(m.sub_role,'') AS sub_role,
               COALESCE(m.join_date,'') AS join_date,
               COALESCE(m.is_active, TRUE) AS is_active,
               COALESCE(m.is_visible, TRUE) AS is_visible,
               COALESCE(m.is_report_target, TRUE) AS is_report_target,
               m.team_id, t.slug AS team_slug, t.name AS team_name,
               COALESCE(d.name, '') AS division_name,
               (p.pin_hash IS NOT NULL) AS has_pin,
               COALESCE(t.leader_name = m.name, FALSE) AS is_leader,
               EXISTS (SELECT 1 FROM divisions dd WHERE dd.head_name = m.name) AS is_division_head,
               (t.slug LIKE 'divhq-%') AS is_division_direct
          FROM members m
          JOIN teams t ON t.id = m.team_id
          LEFT JOIN divisions d ON d.id = t.division_id
          LEFT JOIN pins p ON p.member_name = m.name AND p.team_id = m.team_id
         ORDER BY COALESCE(d.id, 9999), t.id, COALESCE(m.sort_order, 0), m.id
    """))).mappings().all()
    members = [dict(r) for r in rows]
    from collections import Counter
    cnt = Counter(m["name"] for m in members)
    for m in members:
        m["is_dual"] = cnt[m["name"]] > 1
    return {"members": members, "total": len(members)}


class MemberBulkAction(BaseModel):
    member_ids: list[int]
    action: str                      # move|dual|deactivate|activate|reset_pin|set_target|set_visible|delete
    target_team_slug: str = ""       # move / dual 대상 유닛
    value: bool = True               # set_target / set_visible 값


@router.post("/members/bulk")
async def bulk_member_action(
    body: MemberBulkAction,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """구성원 일괄 처리 — 인사이동/겸직/퇴사/복직/PIN초기화/집계·노출 토글/삭제.

    ⚠️ 퇴사(deactivate)는 soft delete: 보고 이력을 보존하고 로그인·목록에서만 제외한다.
       실제 DELETE 는 오등록 정정용이며, 과거 보고서는 남는다(경고 반환).
    """
    if not body.member_ids:
        raise HTTPException(400, "대상 구성원을 선택해주세요")
    act = body.action
    ids = [int(i) for i in body.member_ids]
    _in = ",".join(str(i) for i in ids)
    result = {"ok": True, "action": act, "affected": 0, "skipped": [], "warnings": []}

    if act in ("move", "dual"):
        if not body.target_team_slug:
            raise HTTPException(400, "대상 조직을 선택해주세요")
        t = (await db.execute(text("SELECT id, name FROM teams WHERE slug = :s"),
                              {"s": body.target_team_slug})).mappings().first()
        if not t:
            raise HTTPException(404, "대상 조직을 찾을 수 없습니다")
        tid = t["id"]
        srcs = (await db.execute(text(
            f"SELECT id, name, team_id FROM members WHERE id IN ({_in})"
        ))).mappings().all()
        for m in srcs:
            dup = (await db.execute(text(
                "SELECT 1 FROM members WHERE name = :n AND team_id = :t"
            ), {"n": m["name"], "t": tid})).first()
            if dup:
                result["skipped"].append(f"{m['name']} (대상에 이미 존재)")
                continue
            if act == "move":
                await db.execute(text("UPDATE members SET team_id = :t WHERE id = :i"),
                                 {"t": tid, "i": m["id"]})
                await db.execute(text("""
                    UPDATE pins SET team_id = :t
                     WHERE member_name = :n AND team_id = :old
                       AND NOT EXISTS (SELECT 1 FROM pins p2
                                        WHERE p2.member_name = :n AND p2.team_id = :t)
                """), {"t": tid, "n": m["name"], "old": m["team_id"]})
            else:
                await db.execute(text(f"""
                    INSERT INTO members (name, role, position, title, project, sub_role,
                                         join_date, team_id, is_report_target, created_at)
                    SELECT name, role, position, '', project, sub_role,
                           COALESCE(join_date,''), :t, TRUE, {now_sql}
                      FROM members WHERE id = :i
                """), {"t": tid, "i": m["id"]})
            result["affected"] += 1
        if act == "dual":
            result["warnings"].append("겸직 추가된 조직에서는 최초 로그인 시 PIN 을 다시 등록해야 합니다")

    elif act in ("deactivate", "activate"):
        on = (act == "activate")
        await db.execute(text(
            f"UPDATE members SET is_active = :a, is_visible = :a, is_report_target = :a WHERE id IN ({_in})"
        ), {"a": on})
        result["affected"] = len(ids)
        if not on:
            result["warnings"].append("퇴사 처리했습니다. 작성한 주간보고 이력은 그대로 보존됩니다")

    elif act == "reset_pin":
        rows = (await db.execute(text(
            f"SELECT name, team_id FROM members WHERE id IN ({_in})"
        ))).mappings().all()
        for m in rows:
            await db.execute(text("DELETE FROM pins WHERE member_name = :n AND team_id = :t"),
                             {"n": m["name"], "t": m["team_id"]})
        result["affected"] = len(rows)

    elif act in ("set_target", "set_visible"):
        col = "is_report_target" if act == "set_target" else "is_visible"
        await db.execute(text(f"UPDATE members SET {col} = :v WHERE id IN ({_in})"),
                         {"v": bool(body.value)})
        result["affected"] = len(ids)

    elif act == "delete":
        rows = (await db.execute(text(
            f"SELECT name, team_id FROM members WHERE id IN ({_in})"
        ))).mappings().all()
        for m in rows:
            n = (await db.execute(text(
                "SELECT COUNT(*) FROM reports WHERE member_name = :n AND team_id = :t"
            ), {"n": m["name"], "t": m["team_id"]})).scalar()
            if n:
                result["warnings"].append(f"{m['name']}: 보고 {n}건이 남습니다(이력 보존). 퇴사 처리를 권장합니다")
            await db.execute(text("DELETE FROM pins WHERE member_name = :n AND team_id = :t"),
                             {"n": m["name"], "t": m["team_id"]})
        await db.execute(text(f"DELETE FROM members WHERE id IN ({_in})"))
        result["affected"] = len(rows)

    else:
        raise HTTPException(400, f"지원하지 않는 작업입니다: {act}")

    await db.commit()
    return result


class MemberProfileUpdate(BaseModel):
    join_date: str | None = None
    position: str | None = None
    title: str | None = None


@router.put("/members/{member_id}/profile")
async def update_member_profile(
    member_id: int,
    body: MemberProfileUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_system_admin),
):
    """구성원 프로필 단건 수정 (입사일·직급·직책) — 전사 목록 인라인 편집용."""
    fields, params = [], {"i": member_id}
    for col, val in (("join_date", body.join_date), ("position", body.position), ("title", body.title)):
        if val is not None:
            fields.append(f"{col} = :{col}")
            params[col] = val
    if not fields:
        return {"ok": True, "affected": 0}
    r = await db.execute(text(f"UPDATE members SET {', '.join(fields)} WHERE id = :i"), params)
    await db.commit()
    return {"ok": True, "affected": r.rowcount}
