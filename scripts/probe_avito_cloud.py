"""One-shot connectivity diagnostic; no login, proxy, or CAPTCHA bypass."""
import asyncio
import json
from playwright.async_api import async_playwright

SEARCH = 'https://www.avito.ru/all/telefony/mobile-ASgBAgICAUSwwQ2I_Dc?cd=1&d=1&f=ASgBAgECAUSwwQ2I_DcBRcaaDBV7ImZyb20iOjAsInRvIjoxNTAwMH0&s=104'


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(locale='ru-RU')
        try:
            response = await page.goto(SEARCH, wait_until='domcontentloaded', timeout=45000)
            await page.wait_for_timeout(5000)
            text = (await page.locator('body').inner_text())[:3000]
            result = {
                'http_status': response.status if response else None,
                'title': await page.title(),
                'listing_cards': await page.locator('[data-marker="item"]').count(),
                'structured_prices': await page.locator('[itemprop="price"]').count(),
                'blocked': any(s in text.lower() for s in ['доступ ограничен', 'слишком много запросов', 'проверка браузера', 'подтвердите, что вы', 'captcha']),
                'body_excerpt': text[:500],
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
        except Exception as error:
            print(json.dumps({'error': str(error)}, ensure_ascii=False))
            raise
        finally:
            await browser.close()


asyncio.run(main())
