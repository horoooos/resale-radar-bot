from __future__ import annotations

import asyncio
import contextlib
import logging

from aiogram import Bot, Dispatcher

from resale_bot.config import Settings
from resale_bot.feed import JsonFeed
from resale_bot.handlers import build_router
from resale_bot.service import Scanner
from resale_bot.storage import Storage

log = logging.getLogger(__name__)


async def scan_loop(scanner: Scanner, interval: int) -> None:
    while True:
        try:
            await scanner.scan()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Listing scan failed")
        await asyncio.sleep(interval)


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    settings = Settings()
    storage = Storage(settings.database_path)
    await storage.init()
    bot = Bot(settings.bot_token)
    feed = JsonFeed(settings.listings_feed_url) if settings.listings_feed_url else None
    scanner = Scanner(storage, bot, feed, settings.min_comparables)
    dispatcher = Dispatcher()
    dispatcher.include_router(build_router(storage, scanner, settings))
    task = asyncio.create_task(scan_loop(scanner, settings.scan_interval_seconds))
    try:
        await dispatcher.start_polling(bot)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await bot.session.close()


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
