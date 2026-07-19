from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import json
from database import get_db
from pydantic import BaseModel
from routers.auth import require_auth
from routers.team_deps import get_team_id

router = APIRouter(prefix="/api/settings", tags=["settings"])

class SettingsUpdate(BaseModel):
    key: str
    value: str


@router.get("/public-config")
async def get_public_config(db: AsyncSession = Depends(get_db)):
    """인증 없이 접근 가능한 공개 전역 설정 (멀티팀 활성화 여부 등)"""
    res = await db.execute(text(
        "SELECT key, value FROM settings WHERE team_id = 0 AND key IN ('multi_team_enabled')"
    ))
    rows = {r["key"]: r["value"] for r in res.mappings().all()}
    # 기본값: 비활성화
    multi_team = rows.get("multi_team_enabled", "false")
    if isinstance(multi_team, str):
        multi_team = multi_team.lower() in ("true", "1", "yes")
    return {"multi_team_enabled": multi_team}


def _parse_setting_value(val):
    """settings.value 가 JSON 문자열이면 파싱, 아니면 원본 반환"""
    if val is None:
        return None
    if isinstance(val, (dict, list, bool, int)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            return val
    return val


@router.get("/landing-config")
async def get_landing_config(db: AsyncSession = Depends(get_db)):
    """
    인증 없이 접근 가능한 랜딩(/) 화면 통합 설정.
    multi_team_enabled / default_team_slug / 노출 본부·팀 ID 화이트리스트 / 배너 override·nonce.
    """
    keys = (
        "multi_team_enabled", "default_team_slug",
        "visible_division_ids", "visible_team_ids",
        "banner_override", "banner_nonce",
        "pwa_install_enabled",   # PWA 앱 설치 기능 활성화 (시스템 관리자가 토글)
        "org_labels",            # 조직 호칭 커스터마이즈 (본부/팀/팀원/팀장/본부장 → 임의)
        "brand",                 # 브랜드(제품명/회사명/태그라인) — 미설정 시 회사명 없이 제품명만 노출
    )
    placeholders = ",".join(f"'{k}'" for k in keys)
    res = await db.execute(text(
        f"SELECT key, value FROM settings WHERE team_id = 0 AND key IN ({placeholders})"
    ))
    raw = {r["key"]: r["value"] for r in res.mappings().all()}

    # multi_team_enabled: bool
    mt = raw.get("multi_team_enabled", "false")
    if isinstance(mt, str):
        mt = mt.lower() in ("true", "1", "yes")
    elif not isinstance(mt, bool):
        mt = bool(mt)

    # default_team_slug: str (기본값 'default')
    dts = _parse_setting_value(raw.get("default_team_slug"))
    if not dts or not isinstance(dts, str):
        dts = "default"

    # visible_*_ids: list[int] (없으면 빈 배열 → "모두 표시" 의미)
    def _as_int_list(v):
        if not v:
            return []
        if isinstance(v, list):
            try:
                return [int(x) for x in v]
            except Exception:
                return []
        return []

    vis_div = _as_int_list(_parse_setting_value(raw.get("visible_division_ids")))
    vis_team = _as_int_list(_parse_setting_value(raw.get("visible_team_ids")))

    # 배너 override / nonce
    banner_override = _parse_setting_value(raw.get("banner_override")) or {}
    banner_nonce = raw.get("banner_nonce") or ""
    if isinstance(banner_nonce, (dict, list)):
        banner_nonce = ""

    # picker 렌더용 — teams / divisions 한 번에 동봉 (한 번의 fetch 로 완성)
    # member_count: 그룹 직속(divhq-*) 카드가 '1인=사람 카드 / 2인 이상=소속 카드' 를 판단하는 데 사용
    teams_res = await db.execute(text("""
        SELECT t.id, t.slug, t.name, t.division_id, t.leader_name,
               (SELECT COUNT(*) FROM members m
                 WHERE m.team_id = t.id AND COALESCE(m.is_visible, TRUE) = TRUE) AS member_count
          FROM teams t
         ORDER BY COALESCE(t.division_id, 9999), t.id
    """))
    teams_list = [dict(r) for r in teams_res.mappings().all()]

    divs_res = await db.execute(text("SELECT id, slug, name, head_name FROM divisions ORDER BY id"))
    divs_list = [dict(r) for r in divs_res.mappings().all()]

    # default_team_slug 자동 보정 — settings 의 값이 실제 teams 에 없으면 **id 가 가장 작은 팀**으로 fallback.
    # (teams_list 는 picker 표시용 본부 그룹 정렬이라 첫 항목이 "id=1" 이 아닐 수 있음.
    # id=1 은 보통 최초 시드된 default 팀이라 사용자 기대와 일치.)
    if teams_list:
        available_slugs = {t["slug"] for t in teams_list}
        if dts not in available_slugs:
            # id 오름차순 첫 팀 (보통 id=1 = 최초 시드 팀 = 사용자 기대 default)
            fallback = min(teams_list, key=lambda t: t["id"])
            dts = fallback["slug"]

    # pwa_install_enabled (default True) — false 면 클라이언트가 설치 promo + 설치 버튼 비활성화
    pwa_install = raw.get("pwa_install_enabled", "true")
    if isinstance(pwa_install, str):
        pwa_install = pwa_install.lower() in ("true", "1", "yes")
    elif not isinstance(pwa_install, bool):
        pwa_install = bool(pwa_install)

    # org_labels — 조직 호칭. 기본값 위에 사용자 설정을 덮어씀(부분 지정 허용).
    org_labels = {"division": "본부", "team": "팀", "member": "팀원", "leader": "팀장", "division_head": "본부장"}
    _ol = _parse_setting_value(raw.get("org_labels"))
    if isinstance(_ol, dict):
        for k, v in _ol.items():
            if k in org_labels and isinstance(v, str) and v.strip():
                org_labels[k] = v.strip()

    # brand — 배포처마다 다른 제품명/회사명/태그라인. 기본은 회사명 없이 제품명만(오픈소스 기본값).
    brand = {"product": "Weekly Report", "company": "", "tagline": ""}
    _b = _parse_setting_value(raw.get("brand"))
    if isinstance(_b, dict):
        for k in brand:
            if isinstance(_b.get(k), str):
                brand[k] = _b[k].strip()

    return {
        "multi_team_enabled":   mt,
        "default_team_slug":    dts,
        "visible_division_ids": vis_div,
        "visible_team_ids":     vis_team,
        "banner_override":      banner_override,
        "banner_nonce":         banner_nonce,
        "pwa_install_enabled":  pwa_install,
        "org_labels":           org_labels,
        "brand":                brand,
        "teams":                teams_list,
        "divisions":            divs_list,
    }


@router.get("")
async def get_all_settings(db: AsyncSession = Depends(get_db), tid: int = Depends(get_team_id)):
    """모든 설정 값 조회 (JSON parsing 후 반환)"""
    result = await db.execute(text("SELECT key, value FROM settings WHERE team_id = :tid"), {"tid": tid})
    rows = result.mappings().all()

    settings = {}
    for r in rows:
        val = r["value"]
        if val is None:
            settings[r["key"]] = None
            continue

        # PostgreSQL은 이미 dict/list 형태로 반환할 수도 있고, 문자열일 수도 있음
        if isinstance(val, (dict, list)):
            settings[r["key"]] = val
        else:
            try:
                settings[r["key"]] = json.loads(val)
            except:
                settings[r["key"]] = val

    # 기본값이 없는 경우 초기화
    if "locations_schema" not in settings:
        settings["locations_schema"] = ["본사", "고객사 상주", "재택"]
    if "projects_schema" not in settings:
        settings["projects_schema"] = ["프로젝트 A", "프로젝트 B", "기타"]
    if "project_roles_schema" not in settings:
        settings["project_roles_schema"] = ["설계자", "개발자", "PL", "PM"]

    return settings

# ═══════════════════════════════════════════════════════════
#  부트스트랩 (32차 최적화) — 초기 진입에 필요한 3종을 한 번에
#  기존: landing-config + /api/members + /api/settings = DB 왕복 3회(각 ~1.3s)
#  변경: 한 커넥션에서 순차 조회 → 왕복 1회. 응답 형태는 기존 각 API 와 동일해
#        프론트가 그대로 소비할 수 있다(폴백 유지).
# ═══════════════════════════════════════════════════════════
@router.get("/bootstrap")
async def get_bootstrap(
    request: Request,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
):
    """landing-config + members + settings 통합 응답 (인증 여부에 따라 members 범위 자동 조정)"""
    landing = await get_landing_config(db)

    # settings — get_all_settings 와 동일 로직
    rows = (await db.execute(
        text("SELECT key, value FROM settings WHERE team_id = :tid"), {"tid": tid}
    )).mappings().all()
    settings = {}
    for r in rows:
        val = r["value"]
        if val is None:
            settings[r["key"]] = None
        elif isinstance(val, (dict, list)):
            settings[r["key"]] = val
        else:
            try:
                settings[r["key"]] = json.loads(val)
            except Exception:
                settings[r["key"]] = val
    settings.setdefault("locations_schema", ["본사", "고객사 상주", "재택"])
    settings.setdefault("projects_schema", ["프로젝트 A", "프로젝트 B", "기타"])
    settings.setdefault("project_roles_schema", ["설계자", "개발자", "PL", "PM"])

    # members — members 라우터와 동일한 정렬/필드. 인증 세션이면 PIN 상태까지 포함.
    # 실패를 여기서 삼키면 빈 명부가 '정상 응답'으로 나가 프론트 폴백이 못 탄다 — 그대로 raise.
    from routers.members import list_members
    members = await list_members(request=request, db=db, tid=tid)

    return {"landing": landing, "settings": settings, "members": members}


@router.get("/{key}")
async def get_setting(key: str, db: AsyncSession = Depends(get_db), tid: int = Depends(get_team_id)):
    """단일 설정 값 조회"""
    result = await db.execute(text("SELECT value FROM settings WHERE team_id = :tid AND key = :key"), {"tid": tid, "key": key})
    row = result.mappings().first()
    if not row:
        # Default fallbacks
        if key == "locations_schema": return ["본사", "고객사 상주", "재택"]
        if key == "projects_schema": return ["프로젝트 A", "프로젝트 B", "기타"]
        if key == "project_roles_schema": return ["설계자", "개발자", "PL", "PM"]
        return None

    val = row["value"]
    if val is None: return None

    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except:
        return val

@router.put("/{key}")
async def update_setting(
    key: str,
    body: SettingsUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """설정 값 업데이트 (관리자 전용, JSON string 형태로 전달)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 설정을 변경할 수 있습니다")
    # 유효한 JSON인지 검증
    try:
        json.loads(body.value)
    except Exception as e:
        raise HTTPException(400, "유효한 JSON 문자열이 아닙니다.")

    await db.execute(
        text("""INSERT INTO settings (key, value, team_id) VALUES (:key, :val, :tid)
                ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value"""),
        {"key": key, "val": body.value, "tid": tid}
    )
    await db.commit()
    return {"status": "ok"}


# ═══════════════════════════════════════
#  마감 설정 API
# ═══════════════════════════════════════

@router.get("/deadline/info")
async def get_deadline_info(
    week: str = None,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
):
    """해당 주차의 마감 정보 조회 (프론트엔드 배너용)"""
    from deadline import load_deadline_config, get_deadline_for_week, get_kst_now

    if not week:
        # 현재 주차 자동 계산
        from routers.reports import get_current_week_key
        week = get_current_week_key()

    config = await load_deadline_config(db)
    info = get_deadline_for_week(week, config)

    # 마감 경과 여부 추가
    if info["enabled"] and info["deadline_at"]:
        from datetime import datetime
        deadline_dt = datetime.strptime(info["deadline_at"], "%Y-%m-%d %H:%M:%S")
        now = get_kst_now()
        info["is_passed"] = now > deadline_dt
        info["remaining_seconds"] = max(0, int((deadline_dt - now).total_seconds()))
    else:
        info["is_passed"] = False
        info["remaining_seconds"] = -1  # 무제한

    info["week_key"] = week
    return info


@router.get("/deadline/config")
async def get_deadline_config(db: AsyncSession = Depends(get_db)):
    """마감 설정 전체 조회 (관리자용)"""
    from deadline import load_deadline_config
    return await load_deadline_config(db)


@router.put("/deadline/config")
async def update_deadline_config(
    body: SettingsUpdate,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """마감 설정 저장 (관리자 전용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 마감 설정을 변경할 수 있습니다")
    try:
        config = json.loads(body.value)
    except:
        raise HTTPException(400, "유효한 JSON이 아닙니다.")

    # 필수 필드 검증
    required = ["report_day", "deadline_day_offset", "deadline_time", "holidays", "enabled"]
    for field in required:
        if field not in config:
            raise HTTPException(400, f"필수 필드 누락: {field}")

    await db.execute(
        text("""INSERT INTO settings (key, value, team_id) VALUES ('deadline_config', :val, :tid)
                ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value"""),
        {"val": json.dumps(config, ensure_ascii=False), "tid": tid}
    )
    await db.commit()
    return {"status": "ok"}
