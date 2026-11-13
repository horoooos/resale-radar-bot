from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    bot_token: str = Field(min_length=10)
    database_path: Path = Path("data/resale_radar.db")
    listings_feed_url: str | None = None
    scan_interval_seconds: int = Field(default=300, ge=30)
    allowed_user_ids: frozenset[int] = frozenset()
    default_sale_fee_percent: float = Field(default=5.0, ge=0, le=100)
    default_fixed_costs: int = Field(default=500, ge=0)
    min_comparables: int = Field(default=3, ge=1)

    @field_validator("allowed_user_ids", mode="before")
    @classmethod
    def parse_user_ids(cls, value: object) -> object:
        if value in (None, ""):
            return frozenset()
        if isinstance(value, str):
            return frozenset(int(item.strip()) for item in value.split(",") if item.strip())
        return value
