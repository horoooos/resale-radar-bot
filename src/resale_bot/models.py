from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field, HttpUrl, field_validator


class Listing(BaseModel):
    external_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=2, max_length=500)
    price: int = Field(gt=0)
    url: HttpUrl
    category: str = Field(default="Другое", max_length=100)
    location: str = Field(default="", max_length=200)
    published_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("published_at")
    @classmethod
    def ensure_timezone(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class Watch(BaseModel):
    id: int | None = None
    chat_id: int
    query: str
    category: str | None = None
    max_buy_price: int | None = None
    expected_sale_price: int | None = None
    min_profit: int = 3_000
    min_roi: float = 20.0
    sale_fee_percent: float = 5.0
    fixed_costs: int = 500
    enabled: bool = True


class DealScore(BaseModel):
    expected_sale_price: int
    gross_spread: int
    estimated_costs: int
    net_profit: int
    roi_percent: float
    confidence: str
    comparable_count: int
    reasons: list[str]
