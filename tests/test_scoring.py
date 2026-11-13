from resale_bot.models import Listing, Watch
from resale_bot.scoring import conservative_market_price, matches_watch, score_listing


def listing(price: int = 30_000) -> Listing:
    return Listing(
        external_id="x1",
        title="Apple iPhone 13 128GB",
        price=price,
        url="https://example.com/x1",
        category="Телефоны",
        location="Астрахань",
    )


def watch(**changes) -> Watch:
    values = {
        "chat_id": 1,
        "query": "iphone 13",
        "max_buy_price": 35_000,
        "expected_sale_price": 45_000,
        "min_profit": 5_000,
        "min_roi": 15,
        "sale_fee_percent": 5,
        "fixed_costs": 500,
    }
    values.update(changes)
    return Watch(**values)


def test_matches_watch() -> None:
    assert matches_watch(listing(), watch())
    assert not matches_watch(listing(36_000), watch())
    assert not matches_watch(listing(), watch(query="samsung"))


def test_score_includes_costs() -> None:
    score = score_listing(listing(), watch(), [])
    assert score is not None
    assert score.expected_sale_price == 45_000
    assert score.estimated_costs == 2_750
    assert score.net_profit == 12_250
    assert score.roi_percent == 40.8


def test_rejects_weak_deal() -> None:
    assert score_listing(listing(42_000), watch(max_buy_price=50_000), []) is None


def test_market_price_is_resistant_to_outliers() -> None:
    estimate = conservative_market_price([40_000, 41_000, 42_000, 43_000, 200_000])
    assert estimate is not None
    assert 40_000 <= estimate <= 43_000
