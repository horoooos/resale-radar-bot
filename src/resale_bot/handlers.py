from __future__ import annotations

import shlex

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message
from pydantic import ValidationError

from resale_bot.config import Settings
from resale_bot.models import Listing, Watch
from resale_bot.service import Scanner
from resale_bot.storage import Storage

HELP = """<b>Resale Radar</b> ищет объявления с потенциальной маржой.

Команды:
<code>/watch запрос | макс_цена | цена_перепродажи | мин_прибыль | мин_ROI</code>
Пример:
<code>/watch iphone 13 128 | 35000 | 45000 | 5000 | 15</code>

Цена перепродажи может быть <code>auto</code> — тогда оценка строится по накопленным аналогам:
<code>/watch playstation 5 | 40000 | auto | 5000 | 20</code>

<code>/watches</code> — мои фильтры
<code>/delwatch ID</code> — удалить фильтр
<code>/add JSON</code> — вручную добавить объявление и сразу проверить его
<code>/help</code> — эта справка

JSON для /add:
<code>{"external_id":"a1","title":"iPhone 13 128GB","price":32000,"url":"https://example.com/1","category":"Телефоны","location":"Москва"}</code>"""


def build_router(storage: Storage, scanner: Scanner, settings: Settings) -> Router:
    router = Router()

    def allowed(message: Message) -> bool:
        return not settings.allowed_user_ids or (
            message.from_user is not None and message.from_user.id in settings.allowed_user_ids
        )

    async def deny_if_needed(message: Message) -> bool:
        if allowed(message):
            return False
        await message.answer("У вас нет доступа к этому боту.")
        return True

    @router.message(CommandStart())
    @router.message(Command("help"))
    async def help_handler(message: Message) -> None:
        if not await deny_if_needed(message):
            await message.answer(HELP, parse_mode="HTML")

    @router.message(Command("watch"))
    async def watch_handler(message: Message) -> None:
        if await deny_if_needed(message):
            return
        raw = (message.text or "").partition(" ")[2]
        parts = [part.strip() for part in raw.split("|")]
        if len(parts) != 5:
            await message.answer(
                "Формат: /watch запрос | макс_цена | цена_перепродажи/auto | мин_прибыль | мин_ROI"
            )
            return
        try:
            max_price = int(parts[1].replace(" ", ""))
            expected = None if parts[2].casefold() == "auto" else int(parts[2].replace(" ", ""))
            min_profit = int(parts[3].replace(" ", ""))
            min_roi = float(parts[4].replace(",", "."))
            watch = Watch(
                chat_id=message.chat.id,
                query=parts[0],
                max_buy_price=max_price,
                expected_sale_price=expected,
                min_profit=min_profit,
                min_roi=min_roi,
                sale_fee_percent=settings.default_sale_fee_percent,
                fixed_costs=settings.default_fixed_costs,
            )
        except (ValueError, TypeError) as exc:
            await message.answer(f"Не удалось разобрать числа: {exc}")
            return
        watch_id = await storage.add_watch(watch)
        await message.answer(
            f"✅ Фильтр #{watch_id} создан. Буду присылать только новые подходящие варианты."
        )

    @router.message(Command("watches"))
    async def watches_handler(message: Message) -> None:
        if await deny_if_needed(message):
            return
        watches = await storage.list_watches(message.chat.id)
        if not watches:
            await message.answer("Фильтров пока нет. Создайте первый командой /watch.")
            return
        lines = ["<b>Ваши фильтры</b>"]
        for watch in watches:
            sale = f"{watch.expected_sale_price:,} ₽" if watch.expected_sale_price else "автооценка"
            lines.append(
                f"#{watch.id}: <b>{watch.query}</b> · до {watch.max_buy_price:,} ₽ · "
                f"продажа {sale} · прибыль от {watch.min_profit:,} ₽ · ROI от {watch.min_roi:g}%"
            )
        await message.answer("\n".join(lines).replace(",", " "), parse_mode="HTML")

    @router.message(Command("delwatch"))
    async def delete_handler(message: Message) -> None:
        if await deny_if_needed(message):
            return
        try:
            watch_id = int(shlex.split(message.text or "")[1])
        except (ValueError, IndexError):
            await message.answer("Формат: /delwatch ID")
            return
        deleted = await storage.delete_watch(watch_id, message.chat.id)
        await message.answer("Удалено." if deleted else "Такой фильтр не найден.")

    @router.message(Command("add"))
    async def add_handler(message: Message) -> None:
        if await deny_if_needed(message):
            return
        raw = (message.text or "").partition(" ")[2]
        try:
            listing = Listing.model_validate_json(raw)
        except (ValidationError, ValueError) as exc:
            await message.answer(f"Некорректный JSON объявления: {exc}")
            return
        sent = await scanner.scan([listing])
        await message.answer(f"✅ Объявление сохранено. Подходящих уведомлений: {sent}.")

    return router
