"""
Web Push 알림 API
- VAPID 공개키 제공
- 구독 관리 (저장/취소)
- 알림 발송 유틸 (마감 전날 스케줄러 + 보완요청 트리거에서 호출)
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from database import get_db, is_postgres
from routers.auth import require_auth
from routers.team_deps import get_team_id
import json
import os

router = APIRouter(prefix="/api/push", tags=["push"])

# 현재 서버 환경 — 'prod' or 'dev'. subscribe 시 어느 환경 구독인지 마킹하고,
# send 시 같은 환경의 endpoint 에만 발송 → 운영/개발 PWA 알림 분리.
_PUSH_ENV = 'prod' if (os.getenv("RENDER") is not None or os.getenv("ENV", "").lower() in ("prod", "production")) else 'dev'


class PushSubscription(BaseModel):
    subscription: dict  # {endpoint, keys: {p256dh, auth}}


# ── VAPID 공개키 제공 ──────────────────────────────
@router.get("/vapid-public")
async def get_vapid_public(db: AsyncSession = Depends(get_db)):
    """클라이언트 Push 구독 시 사용할 VAPID 공개키 반환"""
    res = await db.execute(text("SELECT value FROM settings WHERE key='vapid_public_key'"))
    row = res.fetchone()
    if not row:
        raise HTTPException(500, "VAPID 키가 초기화되지 않았습니다. 서버를 재시작해주세요.")
    return {"public_key": row[0]}


# ── 구독 저장 ──────────────────────────────────────
@router.post("/subscribe")
async def subscribe_push(data: PushSubscription, db: AsyncSession = Depends(get_db),
                         auth: dict = Depends(require_auth)):
    """Push 구독 정보 저장 / 갱신 (세션 토큰의 identity 강제 사용)"""
    # v3.0.0 sessions 스키마: member_name → identity 로 컬럼명 변경됨
    name = auth.get("identity") or ""
    # 관리자/시스템관리자 식별자 (__admin__:N, __sysadmin__) 는 구독 불가
    if not name or name.startswith("__") or auth.get("is_admin") or auth.get("is_system_admin"):
        raise HTTPException(403, "본인 세션으로만 구독 가능합니다")

    sub      = data.subscription
    endpoint = sub.get("endpoint", "")
    p256dh   = sub.get("keys", {}).get("p256dh", "")
    auth_key = sub.get("keys", {}).get("auth", "")

    if not endpoint or not p256dh or not auth_key:
        raise HTTPException(400, "구독 정보가 올바르지 않습니다")

    if is_postgres:
        await db.execute(text("""
            INSERT INTO push_subscriptions (member_name, endpoint, p256dh, auth, env)
            VALUES (:name, :ep, :p256dh, :auth, :env)
            ON CONFLICT(endpoint) DO UPDATE SET
                member_name = EXCLUDED.member_name,
                p256dh      = EXCLUDED.p256dh,
                auth        = EXCLUDED.auth,
                env         = EXCLUDED.env
        """), {"name": name, "ep": endpoint, "p256dh": p256dh, "auth": auth_key, "env": _PUSH_ENV})
    else:
        await db.execute(text("""
            INSERT OR REPLACE INTO push_subscriptions (member_name, endpoint, p256dh, auth, env)
            VALUES (:name, :ep, :p256dh, :auth, :env)
        """), {"name": name, "ep": endpoint, "p256dh": p256dh, "auth": auth_key, "env": _PUSH_ENV})

    await db.commit()
    return {"status": "ok"}


# ── 구독 취소 ──────────────────────────────────────
@router.delete("/subscribe")
async def unsubscribe_push(endpoint: str = Query(...), db: AsyncSession = Depends(get_db),
                           auth: dict = Depends(require_auth)):
    """Push 구독 취소 — 본인 endpoint만 삭제 가능"""
    name = auth.get("identity") or ""
    if not name or name.startswith("__") or auth.get("is_admin") or auth.get("is_system_admin"):
        raise HTTPException(403, "본인 세션으로만 취소 가능합니다")
    # 본인 소유 endpoint만 삭제
    await db.execute(text(
        "DELETE FROM push_subscriptions WHERE endpoint=:ep AND member_name=:name"
    ), {"ep": endpoint, "name": name})
    await db.commit()
    return {"status": "ok"}


# ── 마감 알림 수동 트리거 (관리자/시스템관리자 전용) ────────────
class DeadlineSendNowRequest(BaseModel):
    team_id: int | None = None

@router.post("/send-deadline-now")
async def send_deadline_now(
    body: DeadlineSendNowRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict = Depends(require_auth),
):
    """관리자가 마감 알림 발송을 수동 트리거. 시간 범위(12~36h) 무시하고 즉시 발송.
    Body 옵션: {"team_id": int}  → 해당 팀만. 없으면 모든 팀.
    """
    if not (auth.get("is_admin") or auth.get("is_system_admin")):
        raise HTTPException(403, "관리자만 마감 알림을 수동 발송할 수 있습니다")

    target_team_id = body.team_id

    # main 의 함수 import (순환 import 회피 위해 함수 안에서)
    from main import _send_deadline_for_team, send_deadline_push_notifications

    if target_team_id:
        # 특정 팀만
        team_r = await db.execute(text("SELECT id, name FROM teams WHERE id = :tid"), {"tid": target_team_id})
        team = team_r.mappings().first()
        if not team:
            raise HTTPException(404, "해당 조직을 찾을 수 없습니다")
        r = await _send_deadline_for_team(db, team["id"], team["name"], force=True)
        return {"mode": "single_team", "result": r}
    else:
        # 전체 팀
        summary = await send_deadline_push_notifications(force=True)
        return {"mode": "all_teams", "summary": summary}


# ── 푸시 진단 (관리자/시스템관리자 전용) ────────────
@router.get("/diagnostics")
async def push_diagnostics(
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """푸시 시스템 상태 진단 — 운영 트러블슈팅용. 관리자/시스템 관리자만."""
    if not (auth.get("is_admin") or auth.get("is_system_admin")):
        raise HTTPException(403, "관리자만 접근 가능합니다")

    # VAPID 키 존재 여부
    pub_r  = await db.execute(text("SELECT value FROM settings WHERE key='vapid_public_key'"))
    priv_r = await db.execute(text("SELECT value FROM settings WHERE key='vapid_private_key'"))
    pub  = pub_r.fetchone()
    priv = priv_r.fetchone()

    # 현재 팀의 구독 수 + 멤버별 분포 (현재 서버 환경에 한정)
    sub_count_r = await db.execute(text("""
        SELECT m.name, COUNT(s.id) as cnt
          FROM members m
          LEFT JOIN push_subscriptions s
                 ON s.member_name = m.name AND COALESCE(s.env, 'prod') = :env
         WHERE m.team_id = :tid
           AND COALESCE(m.is_visible, TRUE) = TRUE
         GROUP BY m.name
         ORDER BY m.name
    """), {"tid": tid, "env": _PUSH_ENV})
    rows = sub_count_r.mappings().all()

    # 현재 팀 합산 — 멤버 매칭 기준 (push_subscriptions 는 team_id 컬럼 없으므로 member_name 으로 JOIN)
    # 변경 이력 (2026-05-14): 이전엔 모든 팀의 전체 카운트 노출 → 다른 팀 멤버 구독이 현재 팀 진단에 섞여
    # 표시되어 사용자가 자기 팀 구독을 잘못 해석하는 버그. 현재 팀의 visible 멤버 구독만 카운트.
    # 모든 환경(prod+dev) 합산
    team_total_r = await db.execute(text("""
        SELECT COUNT(*) FROM push_subscriptions s
        JOIN members m ON m.name = s.member_name
        WHERE m.team_id = :tid AND COALESCE(m.is_visible, TRUE) = TRUE
    """), {"tid": tid})
    team_total = team_total_r.scalar() or 0
    # 이 팀 + 현재 환경(env) 만
    team_env_r = await db.execute(text("""
        SELECT COUNT(*) FROM push_subscriptions s
        JOIN members m ON m.name = s.member_name
        WHERE m.team_id = :tid
          AND COALESCE(m.is_visible, TRUE) = TRUE
          AND COALESCE(s.env, 'prod') = :env
    """), {"tid": tid, "env": _PUSH_ENV})
    team_env = team_env_r.scalar() or 0
    # 전역 (모든 팀, 모든 환경) — 시스템 관리자 진단용 (orphan stale 구독 발견 가능)
    global_total_r = await db.execute(text("SELECT COUNT(*) FROM push_subscriptions"))
    global_total = global_total_r.scalar() or 0

    # pywebpush 설치 여부
    try:
        from pywebpush import webpush  # noqa: F401
        pywebpush_ok = True
    except ImportError:
        pywebpush_ok = False

    vapid_sub_env = os.getenv("VAPID_SUB", "").strip()
    vapid_email = os.getenv("VAPID_EMAIL", "admin@weekly-report.local")
    apple_sub = vapid_sub_env if vapid_sub_env else f"mailto:{vapid_email}"
    fcm_sub = f"mailto:{vapid_email}"
    return {
        "vapid_public_key_set":  bool(pub),
        "vapid_private_key_set": bool(priv),
        "vapid_email":           vapid_email,
        "vapid_sub_apple":       apple_sub,   # Apple 발송 시 sub (엄격 형식)
        "vapid_sub_fcm":         fcm_sub,     # FCM/기타 발송 시 sub (옛 호환 형식)
        "pywebpush_installed":   pywebpush_ok,
        "env":                   _PUSH_ENV,
        "team_id":               tid,
        # 이 팀 한정 카운트 (멤버 매칭 기준) — 일반 표시용
        "env_subscriptions":     team_env,   # 이 팀 + 현재 환경. 기존 키 호환성 유지 (의미 변경)
        "team_total":            team_total, # 이 팀 + 모든 환경 합산
        # 전역 (모든 팀, 모든 환경) — 시스템 관리자 진단용 (orphan stale 발견)
        "total_subscriptions_global": global_total,
        "members": [{"name": r["name"], "subscription_count": r["cnt"]} for r in rows],
    }


# ── 테스트 푸시 발송 (관리자용) ────────────────────
class PushTestRequest(BaseModel):
    target: str  # 팀원 이름 또는 '__all__' (전체)

@router.post("/test")
async def send_test_push(
    body: PushTestRequest,
    db: AsyncSession = Depends(get_db),
    tid: int = Depends(get_team_id),
    auth: dict = Depends(require_auth),
):
    """관리자 테스트 푸시 발송 — 특정 팀원 또는 전체 (관리자 전용)"""
    if not auth.get("is_admin"):
        raise HTTPException(403, "관리자만 테스트 푸시를 발송할 수 있습니다")
    if body.target == "__all__":
        res = await db.execute(text("SELECT name FROM members WHERE team_id = :tid ORDER BY name"), {"tid": tid})
        names = [r[0] for r in res.fetchall()]
    else:
        names = [body.target]

    sent_total, no_sub, failed_total, cleaned_total = 0, 0, 0, 0
    error_samples = []  # 진짜 발송 실패 (만료 정리 제외)
    for name in names:
        # 현재 서버 환경(env) 의 구독만 카운트
        check = await db.execute(
            text("SELECT COUNT(*) FROM push_subscriptions "
                 "WHERE member_name = :n AND COALESCE(env, 'prod') = :env"),
            {"n": name, "env": _PUSH_ENV}
        )
        if (check.scalar() or 0) == 0:
            no_sub += 1
            continue
        try:
            r = await send_push_to_member(
                member_name=name,
                title="🔔 테스트 알림",
                body="관리자가 발송한 테스트 푸시 알림입니다.",
                url="/",
                db=db,
                tag="test-push",
            )
            # r = {"sent": int, "dead": int, "errors": [str], "total": int}
            sent_total    += r.get("sent", 0)
            cleaned_total += r.get("dead", 0)   # HTTP 404/410 → 만료 구독 자동 정리됨 (실패와 별개)
            failed_total  += len(r.get("errors") or [])
            for err in (r.get("errors") or [])[:3]:
                error_samples.append(f"[{name}] {err}")
        except Exception as e:
            failed_total += 1
            error_samples.append(f"[{name}] 호출 예외: {str(e)[:200]}")
            print(f"[Push] 테스트 발송 실패 ({name}): {e}")

    return {
        "sent":    sent_total,
        "failed":  failed_total,
        "cleaned": cleaned_total,   # 만료 구독 자동 정리 건수
        "no_sub":  no_sub,
        "total":   len(names),
        "errors":  error_samples[:5],
    }


# ═══════════════════════════════════════════════════
#  내부 유틸 — 다른 라우터에서 import해서 사용
# ═══════════════════════════════════════════════════

async def send_push_to_member(
    member_name: str,
    title: str,
    body: str,
    url: str,
    db: AsyncSession,
    tag: str = "weekly-report",
):
    """특정 팀원에게 Push 발송. 만료된 구독은 자동 정리.

    구현 노트: pywebpush 의 webpush() 함수가 PEM 형식 VAPID 키를
    base64url 로 잘못 디코딩 시도하는 ASN.1 호환성 문제 때문에 py_vapid +
    WebPusher 를 직접 조합한 우회 경로 사용. (재현: pywebpush 2.3 + py-vapid 1.9
    + pywebpush 1.14 둘 다 동일 증상.)

    Returns:
        dict: {"sent": int, "dead": int, "errors": [str], "total": int}
    """
    import time
    result = {"sent": 0, "dead": 0, "errors": [], "total": 0}

    try:
        from py_vapid import Vapid
        from pywebpush import WebPusher
    except ImportError:
        result["errors"].append("pywebpush/py-vapid 미설치")
        print("[Push] pywebpush 또는 py-vapid 미설치")
        return result

    # 구독 목록 조회 — 현재 서버 환경(env)에 해당하는 endpoint 만.
    # 운영 서버에서 발송 시 'prod' 구독만, 개발 서버는 'dev' 구독만 → 환경별 알림 분리.
    res = await db.execute(text(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions "
        "WHERE member_name = :name AND COALESCE(env, 'prod') = :env"
    ), {"name": member_name, "env": _PUSH_ENV})
    rows = res.fetchall()
    result["total"] = len(rows)
    if not rows:
        return result

    # VAPID 비공개키 조회 + Vapid 객체 생성 (PEM 형식 유지)
    priv_res = await db.execute(text("SELECT value FROM settings WHERE key='vapid_private_key'"))
    priv_row = priv_res.fetchone()
    if not priv_row:
        result["errors"].append("VAPID 비공개키 없음")
        print("[Push] VAPID 비공개키 없음")
        return result

    try:
        vapid = Vapid.from_pem(priv_row[0].encode())
    except Exception as e:
        result["errors"].append(f"VAPID 키 파싱 실패: {e}")
        print(f"[Push] VAPID 키 파싱 실패: {e}")
        return result

    # VAPID sub — Push Service 별 형식 요구가 다름:
    #  - FCM (fcm.googleapis.com): mailto: 또는 https://. 표준 형식이면 받음. exp 24h 까지 OK
    #  - Apple (web.push.apple.com): 더 엄격. .local 같은 invalid TLD 거부, exp 1h 이내 권장,
    #    iat 누락 시 가끔 거부
    # → endpoint 가 Apple 이면 새 엄격 형식, 아니면 옛 호환 형식 사용.
    vapid_sub_env = os.getenv("VAPID_SUB", "").strip()
    vapid_email = os.getenv("VAPID_EMAIL", "admin@weekly-report.local")
    apple_sub = vapid_sub_env if vapid_sub_env else f"mailto:{vapid_email}"
    fcm_sub = f"mailto:{vapid_email}"   # FCM 은 옛 형식 그대로
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    dead_endpoints = []

    for endpoint, p256dh, auth_key in rows:
        try:
            endpoint_origin = "/".join(endpoint.split("/")[:3])
            now_ts = int(time.time())
            is_apple = "web.push.apple.com" in endpoint
            if is_apple:
                # Apple Push Service — 엄격 검증 대응
                claims = {
                    "sub": apple_sub,
                    "aud": endpoint_origin,
                    "iat": now_ts,
                    "exp": now_ts + 3000,           # 50분
                }
            else:
                # FCM / Mozilla autopush / 기타 — 이전(작동하던) 형식 유지
                claims = {
                    "sub": fcm_sub,
                    "aud": endpoint_origin,
                    "exp": now_ts + 12 * 3600,      # 12시간
                }
            headers = vapid.sign(claims)

            pusher = WebPusher({
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth_key},
            })
            resp = pusher.send(payload, headers=headers, ttl=60)
            if resp.status_code in (200, 201, 202, 204):
                result["sent"] += 1
            elif resp.status_code in (404, 410):
                dead_endpoints.append(endpoint)
                result["dead"] += 1
            else:
                short = f"HTTP {resp.status_code}: {resp.text[:120]}"
                result["errors"].append(f"{endpoint[:50]}... → {short}")
                print(f"[Push] 발송 오류 ({endpoint[:40]}...): {short}")
        except Exception as exc:
            short_err = str(exc).split("\n")[0][:200]
            result["errors"].append(f"{endpoint[:50]}... → {short_err}")
            print(f"[Push] 발송 예외 ({endpoint[:40]}...): {exc}")

    # 만료 구독 정리
    for ep in dead_endpoints:
        await db.execute(text("DELETE FROM push_subscriptions WHERE endpoint=:ep"), {"ep": ep})
    if dead_endpoints:
        await db.commit()

    return result
