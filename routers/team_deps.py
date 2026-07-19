"""팀 컨텍스트 의존성"""
from fastapi import Request, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from database import get_db


async def get_team_id(request: Request, db: AsyncSession = Depends(get_db)) -> int:
    """X-Team-Slug 헤더로 team_id 조회. 없으면 1(기본팀)."""
    slug = request.headers.get("X-Team-Slug", "default")
    result = await db.execute(text("SELECT id FROM teams WHERE slug = :slug"), {"slug": slug})
    row = result.mappings().first()
    if not row:
        # slug가 없으면 default 팀 사용
        result2 = await db.execute(text("SELECT id FROM teams WHERE slug = 'default'"))
        row2 = result2.mappings().first()
        return row2["id"] if row2 else 1
    return row["id"]
