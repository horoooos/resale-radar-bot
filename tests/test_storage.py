from pathlib import Path

import pytest

from resale_bot.models import Listing, Watch
from resale_bot.storage import Storage


@pytest.mark.asyncio
async def test_storage_round_trip(tmp_path: Path) -> None:
    storage = Storage(tmp_path / "db.sqlite")
    await storage.init()
    watch_id = await storage.add_watch(Watch(chat_id=7, query="iphone"))
    watches = await storage.list_watches(7)
    assert watches[0].id == watch_id
    item = Listing(external_id="1", title="iPhone 13", price=30_000, url="https://example.com/1")
    await storage.save_listing(item)
    assert await storage.was_notified(watch_id, "1") is False
    await storage.mark_notified(watch_id, "1")
    assert await storage.was_notified(watch_id, "1") is True
