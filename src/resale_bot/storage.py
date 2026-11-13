from __future__ import annotations

import json
from pathlib import Path

import aiosqlite

from resale_bot.models import Listing, Watch

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  category TEXT,
  max_buy_price INTEGER,
  expected_sale_price INTEGER,
  min_profit INTEGER NOT NULL,
  min_roi REAL NOT NULL,
  sale_fee_percent REAL NOT NULL,
  fixed_costs INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS listings (
  external_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  published_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  watch_id INTEGER NOT NULL,
  external_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (watch_id, external_id)
);
"""


class Storage:
    def __init__(self, path: Path):
        self.path = path

    async def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.executescript(SCHEMA)
            await db.commit()

    async def add_watch(self, watch: Watch) -> int:
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """INSERT INTO watches
                (chat_id, query, category, max_buy_price, expected_sale_price, min_profit,
                 min_roi, sale_fee_percent, fixed_costs, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    watch.chat_id,
                    watch.query,
                    watch.category,
                    watch.max_buy_price,
                    watch.expected_sale_price,
                    watch.min_profit,
                    watch.min_roi,
                    watch.sale_fee_percent,
                    watch.fixed_costs,
                    int(watch.enabled),
                ),
            )
            await db.commit()
            return int(cursor.lastrowid)

    async def list_watches(self, chat_id: int | None = None) -> list[Watch]:
        query = "SELECT * FROM watches WHERE enabled = 1"
        params: tuple[int, ...] = ()
        if chat_id is not None:
            query += " AND chat_id = ?"
            params = (chat_id,)
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            rows = await (await db.execute(query, params)).fetchall()
        return [Watch(**dict(row)) for row in rows]

    async def delete_watch(self, watch_id: int, chat_id: int) -> bool:
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                "DELETE FROM watches WHERE id = ? AND chat_id = ?", (watch_id, chat_id)
            )
            await db.commit()
            return cursor.rowcount > 0

    async def save_listing(self, listing: Listing) -> None:
        payload = listing.model_dump(mode="json")
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(external_id) DO UPDATE SET
                title=excluded.title, price=excluded.price, url=excluded.url,
                category=excluded.category, location=excluded.location,
                published_at=excluded.published_at, raw_json=excluded.raw_json""",
                (
                    listing.external_id,
                    listing.title,
                    listing.price,
                    str(listing.url),
                    listing.category,
                    listing.location,
                    listing.published_at.isoformat(),
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            await db.commit()

    async def comparable_prices(self, listing: Listing, limit: int = 100) -> list[int]:
        words = [word for word in listing.title.lower().split() if len(word) > 2][:4]
        clauses = " AND ".join("lower(title) LIKE ?" for _ in words) or "1=1"
        params = tuple(f"%{word}%" for word in words) + (
            listing.external_id,
            listing.category,
            limit,
        )
        async with aiosqlite.connect(self.path) as db:
            rows = await (
                await db.execute(
                    f"SELECT price FROM listings WHERE {clauses} AND external_id != ? AND category = ? LIMIT ?",
                    params,
                )
            ).fetchall()
        return [int(row[0]) for row in rows]

    async def was_notified(self, watch_id: int, external_id: str) -> bool:
        async with aiosqlite.connect(self.path) as db:
            row = await (
                await db.execute(
                    "SELECT 1 FROM notifications WHERE watch_id = ? AND external_id = ?",
                    (watch_id, external_id),
                )
            ).fetchone()
        return row is not None

    async def mark_notified(self, watch_id: int, external_id: str) -> None:
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "INSERT OR IGNORE INTO notifications (watch_id, external_id) VALUES (?, ?)",
                (watch_id, external_id),
            )
            await db.commit()
