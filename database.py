"""
데이터베이스 연결 및 테이블 초기화 (SQLite & PostgreSQL 지원)
"""
import os
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text, event

# ── 설정 ──
# 1. 우선순위: DATABASE_URL (PostgreSQL 등)
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("DB_URL")

# 2. DATABASE_URL이 없을 경우 DB_PATH(기존 SQLite 경로) 확인
if not DATABASE_URL:
    db_path = os.getenv("DB_PATH", "weekly_report.db")
    # SQLAlchemy용 SQLite URL 형식으로 변환 (sqlite+aiosqlite:///절대경로)
    if os.path.isabs(db_path):
        DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
    else:
        DATABASE_URL = f"sqlite+aiosqlite:///./{db_path}"

# PostgreSQL URL 호환성 처리 (postgres:// -> postgresql+asyncpg://)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "postgresql+asyncpg://" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# SQLite 경로 보정 (sqlite:/// -> sqlite+aiosqlite:///)
if DATABASE_URL.startswith("sqlite://") and "sqlite+aiosqlite://" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("sqlite://", "sqlite+aiosqlite://", 1)

# ── 환경 감지 ──
# RENDER 환경변수 있으면 운영(Render.com), 없으면 개발(로컬)
IS_PROD   = bool(os.getenv("RENDER")) or os.getenv("ENV", "").lower() in ("prod", "production")
IS_DEV    = not IS_PROD
DB_SCHEMA = "public" if IS_PROD else "dev"   # PostgreSQL 스키마

# DB 타입 판별
# ── 엔진 설정 ──
is_postgres = "postgresql" in DATABASE_URL
# URL 에 '-pooler' 가 있으면 Neon PgBouncer (transaction mode) 를 거치는 것 → 호환성 제약 적용 필요
is_pooler   = is_postgres and "-pooler" in DATABASE_URL
now_sql = "TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')" if is_postgres else "datetime('now','localtime')"

if "asyncpg" in DATABASE_URL:
    # Neon 등에서 제공하는 비표준 파라미터 제거 (asyncpg 호환성)
    for param in ["sslmode=require", "channel_binding=require"]:
        if param in DATABASE_URL:
            DATABASE_URL = DATABASE_URL.replace(param, "")
    # 연속된 &나 끝에 남은 ? 정리
    DATABASE_URL = DATABASE_URL.replace("&&", "&").replace("?&", "?").rstrip("?").rstrip("&")

# PostgreSQL asyncpg 연결 옵션
_pg_connect_args = {
    "ssl": "require",
    # search_path: 운영=public, 개발=dev (스키마 자동 분리)
    "server_settings": {"search_path": DB_SCHEMA},
}
# PgBouncer transaction mode 와 호환: prepared statement 캐시 비활성화 (Direct URL 이면 기본값 100 유지 → 빠름)
if is_pooler:
    _pg_connect_args["statement_cache_size"] = 0
    _pg_connect_args["prepared_statement_cache_size"] = 0

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args=_pg_connect_args if is_postgres else {},
    # 클라우드 DB(Neon) 최적화: 연결 풀링 설정
    pool_size=10,            # 미리 유지할 연결 수
    max_overflow=20,         # 필요 시 추가 생성할 연결 수
    pool_recycle=1800,       # 30분마다 연결 재생성
    # Neon 은 유휴 연결을 서버측에서 끊는다. pre_ping 은 checkout(실사용 직전)에만 1회 검사하므로
    # DB 를 깨우지 않으면서 죽은 연결을 잡아 재연결한다 (autosuspend 후 첫 요청 복구용 — 유지 필수).
    # ⚠️ keepalive(60s SELECT 1 상시 루프)는 30차에서 제거 — DB 를 24시간 깨워 Neon compute 한도를
    #    전부 소진시킨 원인(월 100 CU-hrs 초과, 2026-07-18 서비스 정지 사태). 다시 넣지 말 것.
    #    유휴 시 Neon autosuspend(5분)가 동작해야 과금이 멈춘다. 콜드스타트(첫 요청 수 초)는 감수.
    pool_pre_ping=True,
)


# ── search_path 강제 적용 (Neon Pooler 우회) ─────────────
# Neon의 PgBouncer transaction-mode pooler 는 connect_args 의 server_settings 를
# 무시하고, 매 transaction 마다 backend connection 이 바뀔 수 있어 SET 효과가 사라진다.
# 그래서 두 단계 hook 으로 search_path 를 보장한다:
#   1) connect    : 새 backend connection 생성 시 (1회)
#   2) checkout   : pool 에서 connection 을 꺼낼 때마다 (매 요청 직전)
# checkout 시 SET 은 그 직후 시작되는 transaction 안에서 효과를 가진다.
if is_postgres:
    def _apply_search_path(dbapi_conn):
        cursor = dbapi_conn.cursor()
        try:
            cursor.execute(f"SET search_path TO {DB_SCHEMA}")
        finally:
            cursor.close()

    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _record):
        _apply_search_path(dbapi_conn)

    # ⚠️ checkout SET 은 Pooler/Direct 무관하게 '항상' 적용한다.
    #    과거(ecdbc8d)에 'Direct URL 은 connect + server_settings 로 충분'이라 판단해 Direct 는 제외했으나,
    #    pool_pre_ping(재연결)·Neon 유휴 연결 끊김 등과 얽히면서 풀 안의 일부 커넥션이 search_path 를
    #    기본값(public)으로 잃어버려, 개발기(dev)가 운영 스키마(public)를 읽고 쓰는 심각한 회귀가 발생했다.
    #    (예: 로그인 토큰이 public.sessions 에 INSERT 되고 이후 dev.sessions 를 SELECT → 401 + 운영 데이터 노출)
    #    매 checkout 왕복 1회(<1ms)의 비용보다 스키마 오염 방지가 절대 우선이며,
    #    checkout 은 pre_ping/재연결 직후 '사용 직전' 마지막에 실행되므로 스키마를 확정 보장한다.
    @event.listens_for(engine.sync_engine, "checkout")
    def _on_checkout(dbapi_conn, _record, _proxy):
        _apply_search_path(dbapi_conn)


print(f"[DB] 환경: {'운영(public)' if IS_PROD else '개발(dev)'} | {'PostgreSQL' if is_postgres else 'SQLite'}")
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """요청 당 DB 세션을 생성하는 의존성"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()

async def init_db():
    """서버 시작 시 테이블 생성 및 마이그레이션"""

    async with engine.begin() as conn:
        # ── 개발 환경: dev 스키마 자동 생성 ──────────────
        if is_postgres and IS_DEV:
            await conn.execute(text("CREATE SCHEMA IF NOT EXISTS dev"))
            print("[DB] dev 스키마 확인/생성 완료")

        # 0-a. divisions 테이블 (본부 — teams 보다 먼저 생성)
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS divisions (
                id            {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                slug          TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                admin_pw_hash TEXT,
                created_at    TEXT NOT NULL DEFAULT ({now_sql})
            )
        """))

        # 0-b. teams 테이블 (멀티팀 지원)
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS teams (
                id            {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                slug          TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                admin_pw_hash TEXT,
                division_id   INTEGER,
                created_at    TEXT NOT NULL DEFAULT ({now_sql})
            )
        """))
        # 기본팀 삽입 (teams가 비어있을 때만) — 신규 설치용 범용 이름. 시스템관리자가 콘솔에서 변경 가능.
        res = await conn.execute(text("SELECT COUNT(*) FROM teams"))
        if res.scalar() == 0:
            await conn.execute(text(
                "INSERT INTO teams (slug, name) VALUES ('default', '기본팀')"
            ))

        # NOTE: 기존 테이블 마이그레이션 ALTER 들은 모든 CREATE TABLE 뒤로 이동했다.
        #       (CREATE 전에 ALTER 하면 테이블 없음 오류로 PostgreSQL transaction 이 abort 됨)

        # 1. members 테이블
        # v3.0.0+ 멀티팀에서 동명이인 팀간 공존 허용 → inline UNIQUE 제거.
        # (team_id, name) 복합 unique 는 아래 마이그레이션 섹션에서 인덱스로 추가.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS members (
                id          {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                name        TEXT    NOT NULL,
                role        TEXT    NOT NULL DEFAULT 'etc',
                sub_role    TEXT    NOT NULL DEFAULT '',
                position    TEXT    NOT NULL DEFAULT '',
                title       TEXT    NOT NULL DEFAULT '',
                project     TEXT    NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT ({now_sql}),
                updated_at  TEXT    NOT NULL DEFAULT ({now_sql})
            )
        """))
        
        # 2. pins 테이블
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS pins (
                member_name TEXT PRIMARY KEY,
                pin_hash    TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT ({now_sql})
            )
        """))

        # 3. late_permissions 테이블
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS late_permissions (
                id          {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                member_name TEXT    NOT NULL,
                week_key    TEXT    NOT NULL,
                starts_at   TEXT    NOT NULL DEFAULT ({now_sql}),
                expires_at  TEXT    NOT NULL
            )
        """))

        # 4. settings 테이블 (team_id 추가, 기존 PK는 유지하고 index로 복합키 처리)
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL
            )
        """))

        # 4-b. sessions 테이블 — 구형 스키마(member_name) 감지 시 재생성
        if is_postgres:
            old_col = await conn.execute(text("""
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'sessions'
                  AND column_name = 'member_name'
            """))
            if old_col.fetchone():
                await conn.execute(text("DROP TABLE IF EXISTS sessions"))
                print("[DB] sessions 테이블 구형 스키마 감지 → 재생성")
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS sessions (
                token           TEXT PRIMARY KEY,
                identity        TEXT NOT NULL DEFAULT '',
                team_id         INTEGER,
                is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
                is_system_admin BOOLEAN NOT NULL DEFAULT FALSE,
                created_at      TEXT NOT NULL DEFAULT ({now_sql}),
                expires_at      TEXT NOT NULL DEFAULT ''
            )
        """))

        # 5. push_subscriptions 테이블 (Web Push 구독 정보)
        # env: 'prod' (운영 서버에서 등록한 구독) / 'dev' (개발 서버에서 등록한 구독)
        # 운영기에서 발송 시 env='prod' 만, 개발기 발송 시 env='dev' 만 → 환경별 알림 분리.
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id          {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                member_name TEXT NOT NULL,
                endpoint    TEXT NOT NULL UNIQUE,
                p256dh      TEXT NOT NULL,
                auth        TEXT NOT NULL,
                env         TEXT NOT NULL DEFAULT 'prod',
                created_at  TEXT NOT NULL DEFAULT ({now_sql})
            )
        """))

        # 6. summaries 테이블 (AI 요약 저장용 - 주차별/유형별 다중 저장 지원)
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS summaries (
                id           {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                week_key     TEXT NOT NULL,
                summary_type TEXT NOT NULL DEFAULT 'all',
                content      TEXT NOT NULL,
                created_at   TEXT NOT NULL DEFAULT ({now_sql}),
                updated_at   TEXT NOT NULL DEFAULT ({now_sql}),
                UNIQUE(week_key, summary_type)
            )
        """))

        # 6-b. final_reports 테이블 — 유닛장(결재권자) 최종 취합 '보고' 제출본 + 그룹장 결재
        # status: submitted(결재 대기) | approved(승인) | needs_revision(보완요청)
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS final_reports (
                id             {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                team_id        INTEGER NOT NULL,
                week_key       TEXT NOT NULL,
                content        TEXT NOT NULL,
                base_type      TEXT NOT NULL DEFAULT '',
                submitted_by   TEXT NOT NULL DEFAULT '',
                submitted_at   TEXT NOT NULL DEFAULT ({now_sql}),
                status         TEXT NOT NULL DEFAULT 'submitted',
                review_comment TEXT NOT NULL DEFAULT '',
                reviewed_by    TEXT NOT NULL DEFAULT '',
                reviewed_at    TEXT,
                UNIQUE(team_id, week_key)
            )
        """))
        # 30차 중 결재 컬럼 후행 추가 — 기존 final_reports 마이그레이션
        for _col, _ddl in [
            ("status",         "TEXT NOT NULL DEFAULT 'submitted'"),
            ("review_comment", "TEXT NOT NULL DEFAULT ''"),
            ("reviewed_by",    "TEXT NOT NULL DEFAULT ''"),
            ("reviewed_at",    "TEXT"),
        ]:
            try:
                if is_postgres:
                    await conn.execute(text(f"ALTER TABLE final_reports ADD COLUMN IF NOT EXISTS {_col} {_ddl}"))
                else:
                    await conn.execute(text(f"ALTER TABLE final_reports ADD COLUMN {_col} {_ddl}"))
            except Exception:
                pass  # SQLite: 이미 존재하면 실패 — 무시

        # 6. reports 테이블
        await conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS reports (
                id          {"SERIAL" if is_postgres else "INTEGER"} PRIMARY KEY {"" if is_postgres else "AUTOINCREMENT"},
                member_name TEXT    NOT NULL,
                week_key    TEXT    NOT NULL,
                done        TEXT    NOT NULL DEFAULT '',
                plan        TEXT    NOT NULL DEFAULT '',
                issue       TEXT    NOT NULL DEFAULT '',
                note        TEXT    NOT NULL DEFAULT '',
                sor_cnt     INTEGER NOT NULL DEFAULT 0,
                sop_cnt     INTEGER NOT NULL DEFAULT 0,
                chg_cnt     INTEGER NOT NULL DEFAULT 0,
                custom_data TEXT    NOT NULL DEFAULT '{{}}',
                role        TEXT    NOT NULL DEFAULT 'etc',
                sub_role    TEXT    NOT NULL DEFAULT '',
                position    TEXT    NOT NULL DEFAULT '',
                project     TEXT    NOT NULL DEFAULT '',
                status      TEXT    NOT NULL DEFAULT 'submitted',
                submitted_at TEXT   NOT NULL DEFAULT ({now_sql}),
                updated_at   TEXT   NOT NULL DEFAULT ({now_sql}),
                UNIQUE(member_name, week_key)
            )
        """))
        
        # ── 마이그레이션 (기존 테이블에 컬럼 추가) ──
        # PostgreSQL은 ADD COLUMN IF NOT EXISTS를 지원함
        if is_postgres:
            migrations = [
                ("members", "sub_role", "TEXT NOT NULL DEFAULT ''"),
                ("members", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
                ("members", "project", "TEXT NOT NULL DEFAULT ''"),
                ("members", "position", "TEXT NOT NULL DEFAULT ''"),
                ("members", "updated_at", "TEXT"),
                ("members", "team_id", "INTEGER NOT NULL DEFAULT 1"),   # 멀티팀 준비 (기존 팀원 = 1팀)
                ("members", "is_visible", "BOOLEAN NOT NULL DEFAULT TRUE"),  # 로그인 화면 노출 여부 (v3.1.0)
                ("members", "is_report_target", "BOOLEAN NOT NULL DEFAULT TRUE"),  # 주간보고 집계 대상 여부 (팀 관리자 제어) — is_visible(목록 노출)과 별개
                ("members", "avatar_config", "TEXT NOT NULL DEFAULT ''"),  # 아바타 꾸미기 JSON {img,color,initial,border} — 본인이 환경설정에서 설정
                ("members", "title", "TEXT NOT NULL DEFAULT ''"),   # 직책 (본부장/연구소장/이사/팀장 등) — 직급(position)과 별개
                ("push_subscriptions", "env", "TEXT NOT NULL DEFAULT 'prod'"),  # 환경 ('prod'/'dev') — 환경별 알림 분리
                ("reports", "sub_role", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "updated_at", "TEXT"),
                ("reports", "custom_data", "TEXT NOT NULL DEFAULT '{}'"),
                ("reports", "status", "TEXT NOT NULL DEFAULT 'submitted'"),
                ("pins", "created_at", "TEXT"),
                ("late_permissions", "starts_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
                ("reports", "done", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "plan", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "issue", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "note", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "sor_cnt", "INTEGER NOT NULL DEFAULT 0"),
                ("reports", "sop_cnt", "INTEGER NOT NULL DEFAULT 0"),
                ("reports", "chg_cnt", "INTEGER NOT NULL DEFAULT 0"),
                ("summaries", "created_at", "TEXT"),
                ("summaries", "updated_at", "TEXT"),
                # multi-team: team_id columns
                ("members", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("reports", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("summaries", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("settings", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("pins", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("late_permissions", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                # divisions 지원
                ("teams", "division_id", "INTEGER"),
                # 팀 책임자 / 주간보고 관리자 (정·부)
                ("teams", "leader_name", "TEXT"),
                ("teams", "report_admin_primary", "TEXT"),
                ("teams", "report_admin_secondary", "TEXT"),
                # 주간보고 관리자 1회용 평문 비밀번호 (로그인 시 안내 후 NULL 처리)
                ("teams", "pending_admin_pw_primary", "TEXT"),
                ("teams", "pending_admin_pw_secondary", "TEXT"),
                # divisions 본부장
                ("divisions", "head_name", "TEXT"),
                # 구성원 재직 관리 (31차) — 퇴사해도 보고 이력은 보존, 로그인·목록에서만 제외
                #   is_active=FALSE : 퇴사/비활성(soft delete). 실제 DELETE 는 오등록 정정에만 사용.
                #   join_date       : 입사일 'YYYY-MM-DD' (입사년도·연차 산출용, 빈 값 허용)
                ("members", "is_active", "BOOLEAN NOT NULL DEFAULT TRUE"),
                ("members", "join_date", "TEXT NOT NULL DEFAULT ''"),
                # sessions 테이블 신규 컬럼 (토큰 인증 지원)
                ("sessions", "identity", "TEXT NOT NULL DEFAULT ''"),
                ("sessions", "team_id", "INTEGER"),
                ("sessions", "is_admin", "INTEGER NOT NULL DEFAULT 0"),
                ("sessions", "is_system_admin", "INTEGER NOT NULL DEFAULT 0"),
                ("sessions", "expires_at", "TEXT NOT NULL DEFAULT ''"),
            ]
            for table, col, typ in migrations:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {typ}"))
            # summaries UNIQUE 제약 변경 (week_key, summary_type) → (team_id, week_key, summary_type)
            try:
                await conn.execute(text("ALTER TABLE summaries DROP CONSTRAINT IF EXISTS summaries_week_key_summary_type_key"))
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS summaries_team_week_type ON summaries(team_id, week_key, summary_type)"))
            except: pass
            # settings PK 변경 → (team_id, key) 복합 유니크 인덱스
            try:
                await conn.execute(text("ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey"))
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS settings_team_key ON settings(team_id, key)"))
            except: pass
            # late_permissions 팀별 upsert용 복합 유니크 인덱스
            try:
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS late_permissions_team_member_week ON late_permissions(team_id, member_name, week_key)"))
            except: pass
            # reports UNIQUE 확장: team_id 포함 (동명이인 팀간 충돌 방지)
            try:
                await conn.execute(text("ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_member_name_week_key_key"))
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS reports_team_member_week ON reports(team_id, member_name, week_key)"))
            except: pass
            # members 의 옛 'name UNIQUE' 제약 제거 + (team_id, name) 복합 unique 로 전환
            # (멀티팀에서 동일 인물이 여러 팀에 소속 가능 — 예: 겸임 임원)
            try:
                await conn.execute(text("ALTER TABLE members DROP CONSTRAINT IF EXISTS members_name_key"))
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS members_team_name ON members(team_id, name)"))
            except Exception:
                pass

            # 운영 데이터 마이그레이션 대응: created_at/updated_at 의 NOT NULL 제약 해제
            # (운영기 일부 row 가 ALTER ADD COLUMN 으로 추가돼 NULL 인 경우 sync-from-prod 실패 방지)
            for _t, _c in [
                ("members", "updated_at"),
                ("reports", "updated_at"),
                ("summaries", "created_at"),
                ("summaries", "updated_at"),
            ]:
                try:
                    await conn.execute(text(f"ALTER TABLE {_t} ALTER COLUMN {_c} DROP NOT NULL"))
                except: pass
        else:
            # SQLite는 IF NOT EXISTS를 지원하지 않으므로 try-except 유지
            # ⚠️ 위 PostgreSQL 목록과 항목이 어긋나면, 구버전 DB 를 업그레이드할 때 한쪽 엔진에만
            #    컬럼이 안 생긴다(신규 설치는 CREATE TABLE 이 덮으므로 증상이 안 보여 발견이 늦다).
            #    양쪽 목록을 함께 수정할 것 — 정합성은 scratchpad/migration_parity.py 로 검증 가능.
            migrations = [
                ("members", "sub_role", "TEXT NOT NULL DEFAULT ''"),
                ("members", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
                ("members", "updated_at", "TEXT"),
                ("reports", "updated_at", "TEXT"),
                ("summaries", "created_at", "TEXT"),
                ("summaries", "updated_at", "TEXT"),
                ("members", "project", "TEXT NOT NULL DEFAULT ''"),
                ("members", "position", "TEXT NOT NULL DEFAULT ''"),
                ("members", "team_id", "INTEGER NOT NULL DEFAULT 1"),   # 멀티팀 준비 (기존 팀원 = 1팀)
                ("members", "is_visible", "INTEGER NOT NULL DEFAULT 1"),  # SQLite (BOOLEAN 미지원) — 1=visible
                ("members", "is_report_target", "INTEGER NOT NULL DEFAULT 1"),  # 주간보고 집계 대상 (1=대상) — 팀 관리자 제어
                ("members", "avatar_config", "TEXT NOT NULL DEFAULT ''"),  # 아바타 꾸미기 JSON
                ("members", "title", "TEXT NOT NULL DEFAULT ''"),   # 직책 (본부장/연구소장/이사/팀장 등)
                ("push_subscriptions", "env", "TEXT NOT NULL DEFAULT 'prod'"),  # 환경 분리
                ("reports", "sub_role", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "custom_data", "TEXT NOT NULL DEFAULT '{}'"),
                ("reports", "status", "TEXT NOT NULL DEFAULT 'submitted'"),
                ("pins", "created_at", "TEXT"),
                ("late_permissions", "starts_at", "TEXT NOT NULL DEFAULT datetime('now','localtime')"),
                ("reports", "done", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "plan", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "issue", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "note", "TEXT NOT NULL DEFAULT ''"),
                ("reports", "sor_cnt", "INTEGER NOT NULL DEFAULT 0"),
                ("reports", "sop_cnt", "INTEGER NOT NULL DEFAULT 0"),
                ("reports", "chg_cnt", "INTEGER NOT NULL DEFAULT 0"),
                # multi-team: team_id columns
                ("members", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("reports", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("summaries", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("settings", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("pins", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                ("late_permissions", "team_id", "INTEGER NOT NULL DEFAULT 1"),
                # divisions 지원
                ("teams", "division_id", "INTEGER"),
                # 팀 책임자 / 주간보고 관리자 (정·부)
                ("teams", "leader_name", "TEXT"),
                ("teams", "report_admin_primary", "TEXT"),
                ("teams", "report_admin_secondary", "TEXT"),
                # 주간보고 관리자 1회용 평문 비밀번호 (로그인 시 안내 후 NULL 처리)
                ("teams", "pending_admin_pw_primary", "TEXT"),
                ("teams", "pending_admin_pw_secondary", "TEXT"),
                # divisions 본부장
                ("divisions", "head_name", "TEXT"),
                # 구성원 재직 관리 (31차) — 퇴사해도 보고 이력은 보존, 로그인·목록에서만 제외
                #   is_active=FALSE : 퇴사/비활성(soft delete). 실제 DELETE 는 오등록 정정에만 사용.
                #   join_date       : 입사일 'YYYY-MM-DD' (입사년도·연차 산출용, 빈 값 허용)
                ("members", "is_active", "BOOLEAN NOT NULL DEFAULT TRUE"),
                ("members", "join_date", "TEXT NOT NULL DEFAULT ''"),
                # sessions 테이블 신규 컬럼 (토큰 인증 지원)
                ("sessions", "identity", "TEXT NOT NULL DEFAULT ''"),
                ("sessions", "team_id", "INTEGER"),
                ("sessions", "is_admin", "INTEGER NOT NULL DEFAULT 0"),
                ("sessions", "is_system_admin", "INTEGER NOT NULL DEFAULT 0"),
                ("sessions", "expires_at", "TEXT NOT NULL DEFAULT ''"),
            ]
            for table, col, typ in migrations:
                try: await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {typ}"))
                except: pass

            # SQLite: 옛 'members.name UNIQUE' 인라인 제약이 살아있으면 테이블 재생성
            # (멀티팀에서 동명이인 팀간 공존 허용 — 예: 겸임 임원)
            try:
                row = (await conn.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'"))).fetchone()
                if row and 'UNIQUE' in (row[0] or '').upper() and 'name' in (row[0] or ''):
                    # 옛 스키마 → 백업 → 새 스키마로 재생성 → 데이터 복사
                    await conn.execute(text("ALTER TABLE members RENAME TO members_old_v2"))
                    await conn.execute(text(f"""
                        CREATE TABLE members (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL,
                            role TEXT NOT NULL DEFAULT 'etc',
                            sub_role TEXT NOT NULL DEFAULT '',
                            position TEXT NOT NULL DEFAULT '',
                            project TEXT NOT NULL DEFAULT '',
                            sort_order INTEGER NOT NULL DEFAULT 0,
                            created_at TEXT NOT NULL DEFAULT ({now_sql}),
                            updated_at TEXT,
                            team_id INTEGER NOT NULL DEFAULT 1,
                            is_visible INTEGER NOT NULL DEFAULT 1,
                            is_report_target INTEGER NOT NULL DEFAULT 1
                        )
                    """))
                    # 기존 컬럼만 골라서 복사 (옛 DB 에 없는 컬럼은 기본값 사용)
                    old_cols = [c[1] for c in (await conn.execute(text("PRAGMA table_info(members_old_v2)"))).fetchall()]
                    common = [c for c in ['id','name','role','sub_role','position','project','sort_order','created_at','updated_at','team_id','is_visible','is_report_target'] if c in old_cols]
                    col_list = ', '.join(common)
                    await conn.execute(text(f"INSERT INTO members ({col_list}) SELECT {col_list} FROM members_old_v2"))
                    await conn.execute(text("DROP TABLE members_old_v2"))
                    print("[DB] SQLite: members.name UNIQUE 제약 제거 (멀티팀 호환)")
            except Exception as e:
                print(f"[DB] members 마이그레이션 skip: {e}")

            # SQLite: 멀티팀 복합 유니크 인덱스 (PostgreSQL 섹션과 동일)
            try: await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS members_team_name ON members(team_id, name)"))
            except: pass
            try: await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS late_permissions_team_member_week ON late_permissions(team_id, member_name, week_key)"))
            except: pass
            try: await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS reports_team_member_week ON reports(team_id, member_name, week_key)"))
            except: pass
            try: await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS settings_team_key ON settings(team_id, key)"))
            except: pass
            try: await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS summaries_team_week_type ON summaries(team_id, week_key, summary_type)"))
            except: pass

        # ── 기본 설정값 (roles_schema) 초기화 ──
        res = await conn.execute(text("SELECT value FROM settings WHERE key = 'roles_schema' AND team_id = 1"))
        if not res.fetchone():
            default_schema = '[{"id": "dev", "name": "개발", "fields": [{"id": "done", "type": "textarea", "label": "이번 주 완료", "placeholder": "완료한 업무를 입력하세요", "optional": false}, {"id": "plan", "type": "textarea", "label": "다음 주 계획", "placeholder": "다음 주 업무 계획", "optional": false}, {"id": "issue", "type": "textarea", "label": "이슈/요청", "placeholder": "이슈 또는 협조 요청", "optional": true}, {"id": "note", "type": "textarea", "label": "특이사항", "placeholder": "특이사항", "optional": true}]}, {"id": "ops", "name": "운영", "fields": [{"id": "sor_cnt", "type": "counter", "label": "접수 건수", "color": "#a78bfa"}, {"id": "sop_cnt", "type": "counter", "label": "처리 건수", "color": "#f472b6"}, {"id": "chg_cnt", "type": "counter", "label": "변경 건수", "color": "#2dd4bf"}, {"id": "done", "type": "textarea", "label": "이번 주 완료", "placeholder": "완료한 업무를 입력하세요", "optional": false}, {"id": "plan", "type": "textarea", "label": "다음 주 계획", "placeholder": "다음 주 업무 계획", "optional": false}, {"id": "issue", "type": "textarea", "label": "이슈/요청", "placeholder": "이슈 또는 협조 요청", "optional": true}, {"id": "note", "type": "textarea", "label": "특이사항", "placeholder": "특이사항", "optional": true}]}, {"id": "etc", "name": "기타", "fields": [{"id": "done", "type": "textarea", "label": "이번 주 완료", "placeholder": "완료한 업무를 입력하세요", "optional": false}, {"id": "plan", "type": "textarea", "label": "다음 주 계획", "placeholder": "다음 주 업무 계획", "optional": false}, {"id": "issue", "type": "textarea", "label": "이슈/요청", "placeholder": "이슈 또는 협조 요청", "optional": true}, {"id": "note", "type": "textarea", "label": "특이사항", "placeholder": "특이사항", "optional": true}]}]'
            await conn.execute(text("INSERT INTO settings (key, value, team_id) VALUES ('roles_schema', :val, 1)"), {"val": default_schema})

        # ── VAPID 키 자동 생성 (Push 알림용) ──
        vapid_res = await conn.execute(text("SELECT value FROM settings WHERE key='vapid_public_key' AND team_id = 1"))
        if not vapid_res.fetchone():
            try:
                from py_vapid import Vapid
                from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
                import base64

                vapid = Vapid()
                vapid.generate_keys()
                private_key_pem  = vapid.private_pem().decode("utf-8")
                pub_bytes        = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
                public_key_b64   = base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode("utf-8")

                await conn.execute(text("INSERT INTO settings (key, value, team_id) VALUES ('vapid_private_key', :val, 1)"), {"val": private_key_pem})
                await conn.execute(text("INSERT INTO settings (key, value, team_id) VALUES ('vapid_public_key',  :val, 1)"), {"val": public_key_b64})
                print("[VAPID] 키 자동 생성 완료")
            except Exception as e:
                print(f"[VAPID] 키 생성 실패 (pywebpush 설치 필요): {e}")
