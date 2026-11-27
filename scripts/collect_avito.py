"""Hourly collector using the Chrome/Xvfb approach verified with avito-watch.

This is an independent adapter, not a copy of upstream AGPL application code.
"""
import asyncio
from datetime import datetime, timezone
import json
import os
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from patchright.async_api import async_playwright

BASE = os.environ['WORKER_URL'].rstrip('/')
TOKEN = os.environ['COLLECTOR_TOKEN']


def api(path, body=None):
    encoded = json.dumps(body).encode() if body is not None else None
    req = Request(BASE + path, data=encoded, headers={
        'X-Collector-Token': TOKEN, 'Content-Type': 'application/json',
    })
    with urlopen(req, timeout=75) as response:
        result = json.load(response)
    if not result.get('ok'):
        raise RuntimeError('Collector API rejected request')
    return result


EXTRACT = """cards => cards.map(c => {
  const link = c.querySelector('a[data-marker="item-title"]');
  const price = c.querySelector('[itemprop="price"]');
  const photo = c.querySelector('img');
  const place = c.querySelector('[data-marker="item-location"]');
  return {external_id: c.dataset.itemId, title: link?.textContent?.trim(),
    url: link?.href, price: Number(price?.getAttribute('content')),
    image_url: photo?.currentSrc || photo?.src || '', location: place?.textContent?.trim() || ''};
})"""


async def main():
    watches = api('/collector/watches')['watches']
    if not watches:
        print('No saved Avito searches; nothing to scan.')
        return
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            '/tmp/resale-radar-chrome', channel='chrome', headless=False,
            no_viewport=True, args=['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--lang=ru-RU', '--window-size=1600,1000'],
        )
        failed = 0
        try:
            for index, watch in enumerate(watches):
                if index:
                    await asyncio.sleep(30)
                page = await context.new_page()
                try:
                    url = watch['source_url']
                    host = urlsplit(url).hostname or ''
                    if urlsplit(url).scheme != 'https' or not (host == 'avito.ru' or host.endswith('.avito.ru')):
                        raise ValueError('Некорректная ссылка Avito')
                    await page.goto(url, wait_until='domcontentloaded', timeout=45000)
                    try:
                        await page.wait_for_selector('[data-marker="catalog-serp"]', timeout=30000)
                    except Exception:
                        raise RuntimeError((await page.title())[:150]) from None
                    rows = await page.locator('[data-marker="catalog-serp"] [data-marker="item"]').evaluate_all(EXTRACT)
                    items = []
                    for row in rows:
                        if not row.get('external_id') or not row.get('title') or not row.get('url') or row.get('price', 0) <= 0:
                            continue
                        row['category'] = 'Телефоны' if '/telefony' in url else (watch.get('category') or 'Другое')
                        row['published_at'] = datetime.now(timezone.utc).isoformat()
                        items.append(row)
                    if not items:
                        raise RuntimeError('В выдаче нет доступных карточек с ценами')
                    result = api('/collector/results', {'watch_id': watch['id'], 'items': items})
                    print(json.dumps({'watch_id': watch['id'], 'received': len(items), 'sent': result['sent']}), flush=True)
                except Exception as error:
                    failed += 1
                    api('/collector/results', {'watch_id': watch['id'], 'error': str(error)[:250]})
                    print(json.dumps({'watch_id': watch['id'], 'error': str(error)[:250]}, ensure_ascii=False), flush=True)
                finally:
                    await page.close()
        finally:
            await context.close()
        if failed:
            raise SystemExit(1)


asyncio.run(main())
