from __future__ import annotations

import html
import logging

from aiogram import Bot

from resale_bot.feed import JsonFeed
from resale_bot.models import DealScore, Listing
from resale_bot.scoring import matches_watch, score_listing
from resale_bot.storage import Storage

log = logging.getLogger(__name__)


def format_deal(listing: Listing, score: DealScore) -> str:
    title = html.escape(listing.title)
    location = html.escape(listing.location or "не указано")
    url = html.escape(str(listing.url), quote=True)
    return (
        f"🔥 <b>Возможная выгодная перепродажа</b>\n\n"
        f"<b>{title}</b>\n"
        f"Покупка: <b>{listing.price:,} ₽</b>\n"
        f"Оценка быстрой продажи: <b>{score.expected_sale_price:,} ₽</b>\n"
        f"Расходы: ≈ {score.estimated_costs:,} ₽\n"
        f"Чистая прибыль: <b>≈ {score.net_profit:,} ₽</b>\n"
        f"ROI: <b>{score.roi_percent:.1f}%</b>\n"
        f"Надёжность оценки: {score.confidence} ({score.comparable_count} аналогов)\n"
        f"Город: {location}\n\n"
        f'<a href="{url}">Открыть объявление</a>\n\n'
        f"⚠️ Проверьте состояние, комплектность, документы и продавца лично. "
        f"Расчёт — оценка, а не гарантия прибыли."
    ).replace(",", " ")


class Scanner:
    def __init__(self, storage: Storage, bot: Bot, feed: JsonFeed | None, min_comparables: int):
        self.storage = storage
        self.bot = bot
        self.feed = feed
        self.min_comparables = min_comparables

    async def scan(self, listings: list[Listing] | None = None) -> int:
        if listings is None:
            if self.feed is None:
                return 0
            listings = await self.feed.fetch()
        watches = await self.storage.list_watches()
        sent = 0
        for listing in listings:
            comparables = await self.storage.comparable_prices(listing)
            await self.storage.save_listing(listing)
            for watch in watches:
                if not matches_watch(listing, watch) or watch.id is None:
                    continue
                if await self.storage.was_notified(watch.id, listing.external_id):
                    continue
                if not watch.expected_sale_price and len(comparables) < self.min_comparables:
                    continue
                score = score_listing(listing, watch, comparables)
                if score is None:
                    continue
                try:
                    await self.bot.send_message(
                        watch.chat_id,
                        format_deal(listing, score),
                        parse_mode="HTML",
                        disable_web_page_preview=False,
                    )
                    await self.storage.mark_notified(watch.id, listing.external_id)
                    sent += 1
                except Exception:
                    log.exception(
                        "Could not send listing %s to chat %s", listing.external_id, watch.chat_id
                    )
        return sent
