from __future__ import annotations

from typing import Any

import httpx

from resale_bot.models import Listing


class JsonFeed:
    """Read normalized listings from an authorized HTTP JSON source."""

    def __init__(self, url: str, timeout: float = 20.0):
        self.url = url
        self.timeout = timeout

    async def fetch(self) -> list[Listing]:
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            response = await client.get(self.url, headers={"Accept": "application/json"})
            response.raise_for_status()
        payload: Any = response.json()
        items = payload.get("items", []) if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise TypeError("JSON feed must be an array or an object with an 'items' array")
        return [Listing.model_validate(item) for item in items]
