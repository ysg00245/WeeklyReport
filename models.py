"""
Pydantic 요청/응답 모델
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


# ── 팀원 ──
class MemberCreate(BaseModel):
    name: str
    role: str = "etc"  # dev | ops | etc
    position: str = ""  # 사원 | 대리 | 과장 | 차장 | 부장
    project: str = ""   # 소속 프로젝트명
    sub_role: str = ""  # 설계자 | 개발자 등 세부 역할

class MemberUpdate(BaseModel):
    new_name: Optional[str] = None
    role: Optional[str] = None
    position: Optional[str] = None
    project: Optional[str] = None
    sub_role: Optional[str] = None
    is_visible: Optional[bool] = None   # 로그인 화면 노출 여부 (v3.1.0)

class MemberBatchItem(BaseModel):
    name: str
    update: MemberUpdate

class MemberBatchUpdate(BaseModel):
    items: List[MemberBatchItem]

class MemberOut(BaseModel):
    id: int
    name: str
    role: str
    position: str = ""
    title: str = ""    # 직책 (본부장/연구소장/이사/팀장 등) — 직급(position)과 별개
    project: str = ""
    sub_role: str = ""
    created_at: str
    has_pin: bool = False
    pin_set_at: Optional[str] = None
    sort_order: int = 0
    is_visible: bool = True   # 로그인 화면 노출 여부 (v3.1.0)
    is_report_target: bool = True   # 주간보고 집계 대상 여부 (팀 관리자 제어) — is_visible 과 별개
    avatar_config: str = ""   # 아바타 꾸미기 JSON {img,color,initial,border}
    # 팀 메타에서 파생 — 팀장 / 주보관리자(정·부) 배지 표시용
    is_leader: bool = False
    is_report_admin_primary: bool = False
    is_report_admin_secondary: bool = False
    is_division_head: bool = False   # divisions.head_name 매칭 — 그룹장(상위조직장) 콘솔 진입용

class ReorderRequest(BaseModel):
    names: List[str]


# ── 인증 ──
class LoginRequest(BaseModel):
    name: str
    pin: str = Field(..., min_length=4, max_length=4)

class LoginResponse(BaseModel):
    success: bool
    message: str
    is_new: bool = False  # 최초 등록 여부
    name: str = ""        # 서버가 검증한 정식 이름 (프론트에서 user 구성 시 이 값만 신뢰)
    token: str = ""       # 세션 토큰 (클라이언트가 X-Auth-Token 헤더로 전송)
    admin_pw_announcement: Optional[Dict[str, Any]] = None  # 주간보고 관리자 1회용 안내 (role: 정/부, password)

class AdminLoginRequest(BaseModel):
    password: str

class ResetPinRequest(BaseModel):
    name: str

class PermissionGrantRequest(BaseModel):
    member_name: str
    week_key: str
    starts_at: str
    expires_at: str

class PermissionOut(BaseModel):
    member_name: str
    week_key: str
    starts_at: str
    expires_at: str


# ── 주간보고 ──
class ReportSave(BaseModel):
    week_key: str
    done: str = ""
    plan: str = ""
    issue: str = ""
    note: str = ""
    sor_cnt: int = 0
    sop_cnt: int = 0
    chg_cnt: int = 0
    custom_data: dict = {}

class ReportOut(BaseModel):
    id: int
    member_name: str
    week_key: str
    done: str = ""
    plan: str = ""
    issue: str = ""
    note: str = ""
    sor_cnt: int = 0
    sop_cnt: int = 0
    chg_cnt: int = 0
    custom_data: Any = {}
    submitted_at: str
    role: str = "etc"       # 제출 시점 스냅샷
    position: str = ""      # 제출 시점 스냅샷
    project: str = ""       # 제출 시점 스냅샷
    sub_role: str = ""      # 제출 시점 스냅샷
    status: str = "submitted"


# ── AI 요약 ──
class SummarizeRequest(BaseModel):
    week_key: str
    summary_type: str = "all"  # all | project 등 구분용

class SummarizeResponse(BaseModel):
    summary: str


# ── 데이터 마이그레이션 (import) ──
class ImportData(BaseModel):
    members: List[str] = []
    roles: Dict[str, str] = {}
    positions: Dict[str, str] = {}  # name → 직급
    projects: Dict[str, str] = {}   # name → 프로젝트 (신규)
    sub_roles: Dict[str, str] = {}  # name → 상세역할 (신규)
    sort_orders: Dict[str, int] = {} # name → 정렬순서 (신규)
    pins: Dict[str, str] = {}       # 평문 PIN 또는 해시
    db: Dict[str, Dict[str, Any]] = {}  # { weekKey: { name: {...} } }
