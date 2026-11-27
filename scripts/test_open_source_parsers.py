"""Run pinned, reviewed upstream collectors without bot credentials or paid services."""
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import types

SEARCH = 'https://www.avito.ru/all/telefony/mobile-ASgBAgICAUSwwQ2I_Dc?cd=1&context=H4sIAAAAAAAA_wFUAKv_YTozOntzOjg6ImZyb21QYWdlIjtzOjU6InNzZmF2IjtzOjk6ImZyb21fcGFnZSI7czo1OiJzc2ZhdiI7czo3OiJyZWZlcmVyIjtzOjI6InNwIjt9zaGOM1QAAAA&d=1&f=ASgBAgECAUSwwQ2I_DcBRcaaDBV7ImZyb20iOjAsInRvIjoxNTAwMH0&s=104'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def settings():
    # Do not import upstream configuration: diagnostic uses no Telegram tokens.
    module = types.ModuleType('config.settings')
    logger = logging.getLogger('parser-diagnostic')
    logger.success = logger.info
    module.logger = logger
    module.BROWSER_ARGS = ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--start-maximized']
    module.settings = types.SimpleNamespace(use_antibot_tricks=False)
    sys.modules['config.settings'] = module


async def browser_test():
    root = Path('.upstream-browser')
    load('models.ad', root / 'models/ad.py')
    browser_module = load('upstream_browser', root / 'core/browser.py')
    parser_module = load('upstream_parser', root / 'services/parser.py')
    browser = browser_module.BrowserManager()
    statuses = []
    try:
        await browser.init_browser()
        browser.context.on('response', lambda response: statuses.append(response.status) if response.request.resource_type == 'document' else None)
        ads, total = await parser_module.AvitoParser(browser).parse_ads(SEARCH)
        return {'parser': 'sc0urged/avito_parser', 'document_statuses': statuses, 'cards': len(ads), 'reported_total': total}
    finally:
        await browser.shutdown()


def curl_test():
    root = Path('.upstream-curl')
    # curl_parser imports this object but never calls it. Avoid importing unrelated services.
    toolkit = types.ModuleType('services.antibot_toolkit')
    toolkit.antibot_toolkit = None
    sys.modules['services.antibot_toolkit'] = toolkit
    load('core.base_parser', root / 'core/base_parser.py')
    load('services.browser_profiles_2025', root / 'services/browser_profiles_2025.py')
    parser_module = load('upstream_curl', root / 'core/curl_parser.py')
    parser = parser_module.CurlParser()
    statuses = []
    original_get = parser.session.get
    def tracked_get(*args, **kwargs):
        response = original_get(*args, **kwargs)
        statuses.append(response.status_code)
        return response
    parser.session.get = tracked_get
    try:
        html = parser.parse(SEARCH) or ''
        # Upstream can return error-page HTML: count actual cards, not response bytes.
        from bs4 import BeautifulSoup
        cards = len(BeautifulSoup(html, 'html.parser').select('[data-marker="item"]'))
        return {'parser': 'ergon73/avito-parser', 'document_statuses': statuses, 'cards': cards}
    finally:
        parser.session.close()


if __name__ == '__main__':
    settings()
    try:
        result = asyncio.run(browser_test()) if sys.argv[1] == 'browser' else curl_test()
        print(json.dumps(result, ensure_ascii=False), flush=True)
        sys.exit(0 if result['cards'] > 0 else 2)
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), flush=True)
        raise
