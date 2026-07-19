"""
조직 호칭(org_labels) 공용 헬퍼 — 백엔드 사용자 노출 메시지용.

프론트는 static/js/utils.js 의 ORG_LABELS / orgLabel() / data-ol 로 처리하고,
백엔드는 HTTPException detail 처럼 프론트가 그대로 toast 로 띄우는 문자열에만 사용한다.

저장 위치: settings 테이블의 (team_id=0, key='org_labels') JSON.
기본값은 static/js/utils.js:ORG_LABELS 및 routers/settings.py 의 landing-config 기본값과
반드시 동일하게 유지할 것 (세 곳이 어긋나면 화면마다 호칭이 달라진다).
"""
import json
from sqlalchemy import text

DEFAULT_ORG_LABELS = {
    "division": "본부",
    "team": "팀",
    "member": "팀원",
    "leader": "팀장",
    "division_head": "본부장",
}


_JOSA_PAIRS = [("을", "를"), ("이", "가"), ("은", "는"), ("과", "와"), ("으로", "로"), ("이라", "라")]


def josa(word: str, j: str) -> str:
    """받침에 맞는 조사를 붙인다. josa('유닛','을')→'유닛을', josa('본부','을')→'본부를'.

    호칭이 설정으로 바뀌므로 조사를 하드코딩하면 어느 한쪽은 반드시 틀린다.
    """
    w = (word or "").strip()
    if not w:
        return j or ""
    pair = next((p for p in _JOSA_PAIRS if j in p), None)
    if not pair:
        return w + (j or "")
    c = ord(w[-1])
    has_batchim = 0xAC00 <= c <= 0xD7A3 and (c - 0xAC00) % 28 != 0
    return w + (pair[0] if has_batchim else pair[1])


async def get_org_labels(db) -> dict:
    """현재 조직 호칭 5종. 조회 실패·미설정 시 기본값으로 폴백(예외를 밖으로 던지지 않는다)."""
    labels = dict(DEFAULT_ORG_LABELS)
    try:
        r = await db.execute(text("SELECT value FROM settings WHERE team_id=0 AND key='org_labels'"))
        row = r.mappings().first()
        if row and row["value"]:
            v = row["value"]
            d = json.loads(v) if isinstance(v, str) else v
            if isinstance(d, dict):
                for k in labels:
                    if isinstance(d.get(k), str) and d[k].strip():
                        labels[k] = d[k].strip()
    except Exception:
        pass
    return labels
