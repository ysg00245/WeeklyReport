"""
주간보고 마감 관련 유틸리티
- 마감일 계산 (공휴일 고려)
- 마감 여부 판단
"""
import json
from datetime import datetime, timedelta, date, time


# ── 기본 설정값 ──
DEFAULT_DEADLINE_CONFIG = {
    "report_day": 4,          # 보고일: 금요일 (0=월, 4=금)
    "deadline_day_offset": -1, # 마감일 = 보고일 - 1일 (목요일)
    "deadline_time": "18:00",  # 마감 시각
    "holidays": [],            # 공휴일 목록 (YYYY-MM-DD 문자열 배열)
    "enabled": True            # 마감 기능 활성화 여부
}


def get_kst_now() -> datetime:
    """현재 KST 시각 반환"""
    return datetime.utcnow() + timedelta(hours=9)


def iso_week_to_monday(week_key: str) -> date:
    """ISO 주차 키(예: 2026-W19)를 해당 주 월요일 날짜로 변환"""
    year_str, w_str = week_key.split("-W")
    year = int(year_str)
    week = int(w_str)
    # ISO 8601: 1월 4일이 속한 주가 1주차
    jan4 = date(year, 1, 4)
    # 1주차 월요일
    week1_monday = jan4 - timedelta(days=jan4.weekday())
    # 원하는 주차의 월요일
    return week1_monday + timedelta(weeks=week - 1)


def get_deadline_for_week(week_key: str, config: dict) -> dict:
    """
    해당 주차의 마감 일시를 계산합니다.
    
    Returns:
        {
            "deadline_at": "2026-05-08 18:00:00",  # 실제 마감 일시
            "report_date": "2026-05-09",           # 보고일
            "original_report_date": "2026-05-09",  # 원래 보고일 (공휴일 전 조정 전)
            "is_holiday_adjusted": False,           # 공휴일로 인한 조정 여부
            "enabled": True
        }
    """
    if not config.get("enabled", True):
        return {
            "deadline_at": None,
            "report_date": None,
            "original_report_date": None,
            "is_holiday_adjusted": False,
            "enabled": False
        }
    
    monday = iso_week_to_monday(week_key)
    report_day_offset = config.get("report_day", 4)  # 금요일 = 4
    deadline_day_offset = config.get("deadline_day_offset", -1)
    deadline_time_str = config.get("deadline_time", "18:00")
    holidays = set(config.get("holidays", []))
    
    # 보고일 계산 (해당 주 월요일 + offset)
    report_date = monday + timedelta(days=report_day_offset)
    original_report_date = report_date
    
    # 공휴일 체크: 보고일이 공휴일이면 하루씩 앞당김
    is_holiday_adjusted = False
    while report_date.isoformat() in holidays:
        report_date = report_date - timedelta(days=1)
        is_holiday_adjusted = True
    
    # 마감일 계산 (보고일 + offset, 보통 -1일)
    deadline_date = report_date + timedelta(days=deadline_day_offset)
    
    # 마감 시각 파싱
    h, m = map(int, deadline_time_str.split(":"))
    deadline_dt = datetime.combine(deadline_date, time(h, m, 0))
    
    return {
        "deadline_at": deadline_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "report_date": report_date.isoformat(),
        "original_report_date": original_report_date.isoformat(),
        "is_holiday_adjusted": is_holiday_adjusted,
        "enabled": True
    }


def is_deadline_passed(week_key: str, config: dict) -> bool:
    """해당 주차의 마감이 지났는지 확인"""
    info = get_deadline_for_week(week_key, config)
    if not info["enabled"] or not info["deadline_at"]:
        return False
    
    deadline_dt = datetime.strptime(info["deadline_at"], "%Y-%m-%d %H:%M:%S")
    return get_kst_now() > deadline_dt


async def load_deadline_config(db, team_id: int | None = None) -> dict:
    """DB에서 마감 설정을 로드합니다. team_id 주면 해당 팀, 없으면 글로벌(team_id=1) fallback."""
    from sqlalchemy import text
    if team_id is not None:
        result = await db.execute(
            text("SELECT value FROM settings WHERE key = 'deadline_config' AND team_id = :tid"),
            {"tid": team_id},
        )
    else:
        result = await db.execute(
            text("SELECT value FROM settings WHERE key = 'deadline_config' LIMIT 1")
        )
    row = result.mappings().first()
    if not row:
        return DEFAULT_DEADLINE_CONFIG.copy()

    val = row["value"]
    if isinstance(val, dict):
        return val
    try:
        return json.loads(val)
    except:
        return DEFAULT_DEADLINE_CONFIG.copy()
