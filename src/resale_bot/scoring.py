from __future__ import annotations

import math
import re
import statistics
from collections.abc import Sequence

from resale_bot.models import DealScore, Listing, Watch

_WORD_RE = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)


def normalize_words(text: str) -> set[str]:
    return {word.lower() for word in _WORD_RE.findall(text) if len(word) > 1}


def matches_watch(listing: Listing, watch: Watch) -> bool:
    query_words = normalize_words(watch.query)
    title_words = normalize_words(listing.title)
    if query_words and not query_words.issubset(title_words):
        return False
    if watch.category and listing.category.casefold() != watch.category.casefold():
        return False
    return watch.max_buy_price is None or listing.price <= watch.max_buy_price


def conservative_market_price(prices: Sequence[int]) -> int | None:
    """Return a cautious resale estimate, resistant to a few extreme prices."""
    positive = sorted(price for price in prices if price > 0)
    if not positive:
        return None
    if len(positive) < 4:
        return int(statistics.median(positive))
    trim = max(1, math.floor(len(positive) * 0.1))
    trimmed = positive[trim:-trim] if len(positive) - 2 * trim >= 2 else positive
    # 40th percentile is deliberately below the median for a faster resale.
    index = (len(trimmed) - 1) * 0.4
    lo, hi = math.floor(index), math.ceil(index)
    value = trimmed[lo] if lo == hi else trimmed[lo] + (trimmed[hi] - trimmed[lo]) * (index - lo)
    return int(value)


def score_listing(
    listing: Listing, watch: Watch, comparable_prices: Sequence[int]
) -> DealScore | None:
    market_price = watch.expected_sale_price or conservative_market_price(comparable_prices)
    if market_price is None:
        return None
    fee = round(market_price * watch.sale_fee_percent / 100)
    estimated_costs = fee + watch.fixed_costs
    gross_spread = market_price - listing.price
    net_profit = gross_spread - estimated_costs
    roi = net_profit / listing.price * 100
    if net_profit < watch.min_profit or roi < watch.min_roi:
        return None

    count = len(comparable_prices)
    if watch.expected_sale_price:
        confidence = "задана пользователем"
    elif count >= 10:
        confidence = "высокая"
    elif count >= 5:
        confidence = "средняя"
    else:
        confidence = "низкая"
    return DealScore(
        expected_sale_price=market_price,
        gross_spread=gross_spread,
        estimated_costs=estimated_costs,
        net_profit=net_profit,
        roi_percent=round(roi, 1),
        confidence=confidence,
        comparable_count=count,
        reasons=[
            f"цена входа на {gross_spread:,} ₽ ниже оценки продажи".replace(",", " "),
            f"после расходов остаётся около {net_profit:,} ₽".replace(",", " "),
        ],
    )
