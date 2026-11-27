"""Hourly collector using the Chrome/Xvfb approach verified with avito-watch.

This is an independent adapter, not a copy of upstream AGPL application code.
"""
import asyncio
import base64
from datetime import datetime, timezone
import json
import os
from urllib.parse import urlsplit
from urllib.parse import urlencode
import re
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from camoufox.async_api import AsyncCamoufox

BASE = os.environ['WORKER_URL'].strip().rstrip('/')
TOKEN = os.environ['COLLECTOR_TOKEN']


def api(path, body=None):
    encoded = json.dumps(body).encode() if body is not None else None
    req = Request(BASE + path, data=encoded, headers={
        'X-Collector-Token': TOKEN, 'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ResaleRadarCollector/1.0)',
    })
    try:
        with urlopen(req, timeout=75) as response:
            result = json.load(response)
    except HTTPError as error:
        detail = error.read(200).decode('utf-8', errors='replace')
        raise RuntimeError(f'Collector HTTP {error.code}: {detail}') from None
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
    image_url: photo?.srcset?.split(',').at(-1)?.trim()?.split(' ')[0] || photo?.currentSrc || photo?.src || '', location: place?.textContent?.trim() || ''};
})"""


def model_key(title):
    text = title.lower().replace('ё', 'е')
    model = re.sub(r'[^a-zа-я0-9]', '', text.split(',')[0])
    model = re.sub(r'^(?:(?:смартфон|мобильныйтелефон|телефон|apple))+', '', model)
    memory = re.search(r'(\d+)\s*(гб|gb|тб|tb)', text)
    ram = re.search(r'(\d+)\s*/\s*\d+\s*(?:гб|gb)',text)
    return model + '|' + (memory[1] + ('tb' if memory[2] in ('тб', 'tb') else 'gb') if memory else 'unknown') + ('|ram'+ram[1] if ram else '')


async def details(context, row):
    result = {**row, 'detail_status': 'pending', 'details_attempted_at':datetime.now(timezone.utc).isoformat()}
    parsed = urlsplit(row.get('url', ''))
    if parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.avito.ru'):
        return result
    page = await context.new_page()
    try:
        await page.goto(row['url'], wait_until='domcontentloaded', timeout=25000)
        description = page.locator('[data-marker="item-view/item-description"], [itemprop="description"]').first
        await description.wait_for(timeout=10000)
        text = (await description.inner_text()).strip()
        if len(text) < 15:
            return result
        result['description'] = text[:12000]
        params = page.locator('[data-marker="item-view/item-params"], [data-marker="item-view/item-params-list"]').first
        param_text = await params.inner_text() if await params.count() else ''
        condition = re.search(r'Состояние\s*:\s*([^\n]+)', param_text)
        if not condition:
            condition = re.search(r'Состояние\s*:\s*([^\n]+)', (await page.locator('body').inner_text())[:15000])
        result['condition'] = condition[1].strip() if condition else ''
        seller = page.locator('[data-marker="seller-info/name"], [data-marker="seller-info"]')
        seller_text = ' '.join(await seller.all_inner_texts())
        result['seller_type'] = 'private' if 'Частное лицо' in seller_text else 'business' if any(w in seller_text for w in ['Компания', 'Магазин']) else 'unknown'
        buy = page.get_by_text(re.compile(r'^Купить (?:с (?:Авито )?доставкой|с доставкой)$', re.I))
        result['delivery'] = True if await buy.count() else None
        result['detail_status'] = 'complete'
        result['details_checked_at'] = datetime.now(timezone.utc).isoformat()
        return result
    except Exception:
        return result
    finally:
        await page.close()


async def collect_market(context, rows, known_keys, cache):
    models = {}
    for row in rows:
        key = model_key(row['title'])
        if key not in known_keys:
            models.setdefault(key, row['title'])
    samples = []
    for key, title in list(models.items())[:2]:
        page = await context.new_page()
        try:
            query = ', '.join(title.split(',')[:2])
            url = 'https://www.avito.ru/all/telefony/mobile-ASgBAgICAUSwwQ2I_Dc?' + urlencode({'q':query, 's':'104'})
            await page.goto(url, wait_until='domcontentloaded', timeout=25000)
            await page.wait_for_selector('[data-marker="catalog-serp"]', timeout=15000)
            candidates = await page.locator('[data-marker="catalog-serp"] [data-marker="item"]').evaluate_all(EXTRACT)
            candidates = [r for r in candidates if r.get('title') and r.get('external_id') and r.get('price', 0) > 0 and model_key(r['title']) == key][:8]
            for candidate in candidates[:6]:
                candidate['category'] = 'Телефоны'
                candidate['published_at'] = datetime.now(timezone.utc).isoformat()
                cached = cache.get(str(candidate['external_id']))
                if cached and cached.get('detail_status') == 'complete':
                    candidate.update({k: cached.get(k) for k in ['description','detail_status','condition','delivery','seller_type','details_checked_at']})
                else:
                    await asyncio.sleep(2)
                    candidate = await details(context, candidate)
                if candidate.get('detail_status') == 'complete':
                    samples.append(candidate)
            await asyncio.sleep(3)
        except Exception:
            print(json.dumps({'market': 'unavailable'}), flush=True)
        finally:
            await page.close()
            api('/collector/market-status', {'model_key':key})
    for offset in range(0, len(samples), 5):
        api('/collector/market', {'items': samples[offset:offset+5]})
    return len(samples)


def upload(watch_id, items):
    sent=0
    for offset in range(0,len(items),3):
        sent += api('/collector/results',{'watch_id':watch_id,'items':items[offset:offset+3]})['sent']
    api('/collector/status',{'watch_id':watch_id,'count':len(items)})
    return sent


def recent_attempt(row):
    try:
        value=datetime.fromisoformat(row.get('details_attempted_at','').replace('Z','+00:00'))
        return (datetime.now(timezone.utc)-value).total_seconds()<1200
    except (ValueError,TypeError):
        return False


async def main():
    configuration = api('/collector/watches')
    watches = configuration['watches']
    cache = {str(row['external_id']): row for row in configuration.get('detail_cache', [])}
    if not watches:
        print('No saved Avito searches; nothing to scan.')
        return
    async with AsyncCamoufox(headless=False, humanize=True) as browser:
        context = await browser.new_context()
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
                    rows = rows[:20]
                    items = []
                    cards = page.locator('[data-marker="catalog-serp"] [data-marker="item"]')
                    for card_index, row in enumerate(rows):
                        if not row.get('external_id') or not row.get('title') or not row.get('url') or row.get('price', 0) <= 0:
                            continue
                        row['category'] = 'Телефоны' if '/telefony' in url else (watch.get('category') or 'Другое')
                        if not str(row.get('image_url', '')).startswith(('https://', 'http://')):
                            row['image_url'] = ''
                        card = cards.nth(card_index)
                        try:
                            await card.scroll_into_view_if_needed(timeout=1200)
                            await page.wait_for_timeout(200)
                            image = card.locator('img, [data-marker="item-photo"], [data-marker="item-gallery"]').first
                            if await image.count():
                                await page.wait_for_timeout(150)
                                picture = await image.screenshot(type='jpeg', quality=65, animations='disabled', timeout=1200)
                                if len(picture) < 100000:
                                    row['image_data'] = base64.b64encode(picture).decode('ascii')
                        except Exception:
                            pass
                        row['published_at'] = datetime.now(timezone.utc).isoformat()
                        cached = cache.get(str(row['external_id']))
                        if cached:
                            row['details_attempted_at']=cached.get('details_attempted_at')
                        if cached and cached.get('detail_status') == 'complete':
                            row.update({k:cached.get(k) for k in ['description','condition','delivery','seller_type','detail_status','details_checked_at']})
                        items.append(row)
                    if not items:
                        raise RuntimeError('В выдаче нет доступных карточек с ценами')
                    sent = upload(watch['id'],items)
                    enriched = 0
                    for i, row in enumerate(items):
                        if row.get('detail_status') != 'complete' and not recent_attempt(row) and enriched < 5:
                            items[i] = await details(context, row)
                            enriched += 1
                            await asyncio.sleep(2)
                    if enriched:
                        sent += upload(watch['id'],items)
                    market_count = await collect_market(context, items, set(configuration.get('market_keys', [])), cache)
                    if market_count:
                        sent += upload(watch['id'],items)
                    print(json.dumps({'watch_id': watch['id'], 'received': len(items), 'details':sum(i.get('detail_status') == 'complete' for i in items), 'market_samples':market_count, 'photos': sum(bool(i.get('image_data')) for i in items), 'sent': sent}), flush=True)
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
