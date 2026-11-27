"""Bounded cloud checks of three other upstream approaches; no user secrets."""
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import types

from test_open_source_parsers import SEARCH

ROOT = Path('.candidate').resolve()


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


async def case():
    settings = types.ModuleType('app.config')
    settings.settings = types.SimpleNamespace(profile_dir='/tmp/avito-case-diagnostic')
    sys.modules['app.config'] = settings
    logic = types.ModuleType('app.logic')
    class Listing:
        def __init__(self, **fields):
            self.__dict__.update(fields)
    logic.Listing = Listing
    sys.modules['app.logic'] = logic
    browser = load('app.browser', 'app/browser.py')
    avito = load('candidate_avito', 'app/avito.py')
    async with browser.browser() as context:
        statuses = []
        context.on('response', lambda r: statuses.append(r.status) if r.request.resource_type == 'document' else None)
        try:
            heading, total, listings = await avito.Avito(context).search(SEARCH)
            return {'cards': len(listings), 'heading': heading, 'total': total, 'statuses': statuses}
        except Exception as error:
            return {'cards': 0, 'error': str(error), 'statuses': statuses}


def camoufox():
    # Test this project's browser engine and extraction on the supplied URL.
    query = types.ModuleType('app.models.query')
    query.Query = types.SimpleNamespace
    sys.modules['app.models.query'] = query
    module = load('candidate_camoufox', 'app/parser/avito_parser.py')
    parser = module.AvitoParser(headless=False)
    from camoufox.sync_api import Camoufox
    with Camoufox(headless=False, humanize=True) as browser:
        page = browser.new_page()
        response = page.goto(SEARCH, wait_until='domcontentloaded', timeout=45000)
        page.wait_for_timeout(15000)
        return {'status': response.status if response else None, 'title': page.title(),
                'cards': page.locator('[data-marker="item"]').count(),
                'upstream_extracted': len(parser._parse_items(page, 'телефоны'))}


def egor():
    sys.path.insert(0, str(ROOT))
    import main
    from avito_client import CalmClient
    from bs4 import BeautifulSoup
    client = CalmClient(delay=30)
    client.referer = SEARCH
    client.session = main.requests.Session(impersonate=main.HTTP_IMPERSONATE_PROFILE, trust_env=False)
    main.set_session_headers(client.session, {**main.REQUEST_HEADERS, 'Referer': SEARCH})
    try:
        # One bounded session; never enter upstream's endless IP-block wait loop.
        kind, response = client._get(SEARCH, document=True)
        html = response.text if response is not None else ''
        soup = BeautifulSoup(html, 'html.parser')
        return {'kind': kind, 'status': response.status_code if response is not None else None,
                'title': soup.title.get_text() if soup.title else '',
                'cards': len(soup.select('[data-marker="item"]'))}
    finally:
        client.session.close()


def mobile():
    from urllib.parse import urlsplit
    from loguru import logger
    logger.remove()  # Do not log mobile URLs with application parameters.
    converter = load('candidate_converter', 'parser/url_converter.py')
    url = converter.AvitoUrlConverter(cache_path='/tmp/avito-url-diagnostic.json').convert(SEARCH)
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('m.avito.ru', 'www.avito.ru'):
        raise ValueError('Converter returned an unexpected host')
    base = types.ModuleType('parser.cookies.base')
    base.CookiesProvider = type('CookiesProvider', (), {})
    sys.modules['parser.cookies.base'] = base
    proxy = load('parser.proxies.proxy', 'parser/proxies/proxy.py')
    http = load('candidate_http', 'parser/http/client.py')
    client = http.HttpClient(proxy.NoProxy(), max_retries=1, retry_delay=0)
    statuses = []
    original = client._client.request
    def track(*args, **kwargs):
        response = original(*args, **kwargs)
        statuses.append(response.status_code)
        return response
    client._client.request = track
    try:
        payload = client.request('GET', url).json()
        def count(value):
            if isinstance(value, list):
                return sum(count(item) for item in value)
            if isinstance(value, dict):
                if value.get('title') and value.get('id') and ('price' in value or 'priceDetailed' in value):
                    return 1
                return sum(count(item) for item in value.values())
            return 0
        return {'cards': count(payload), 'statuses': statuses}
    except Exception as error:
        return {'cards': 0, 'statuses': statuses, 'error': type(error).__name__}
    finally:
        client._client.close()


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    backend = sys.argv[1]
    try:
        result = asyncio.run(case()) if backend == 'case' else camoufox() if backend == 'camoufox' else mobile() if backend == 'mobile' else egor()
        print(json.dumps({'backend': backend, **result}, ensure_ascii=False), flush=True)
        sys.exit(0 if result['cards'] > 0 else 2)
    except Exception as error:
        print(json.dumps({'backend': backend, 'error': str(error)}, ensure_ascii=False), flush=True)
        raise
