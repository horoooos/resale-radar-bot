import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

spec = importlib.util.spec_from_file_location('browser_context', Path(__file__).resolve().parents[1] / 'scripts/browser_context.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.mark.asyncio
async def test_invalid_saved_state_recovers_with_same_mobile_settings():
    browser = AsyncMock()
    browser.new_context.side_effect = [ValueError('incompatible state'), 'new context']
    discard = AsyncMock()
    options = {'viewport': {'width': 390, 'height': 844}, 'has_touch': True}
    result = await module.open_context(browser, options, {'cookies': []}, discard)
    assert result == 'new context'
    discard.assert_awaited_once()
    assert browser.new_context.await_args_list[0].kwargs == {**options, 'storage_state': {'cookies': []}}
    assert browser.new_context.await_args_list[1].kwargs == options


@pytest.mark.asyncio
async def test_context_failure_without_saved_state_is_not_silenced():
    browser = AsyncMock()
    browser.new_context.side_effect = RuntimeError('browser unavailable')
    discard = AsyncMock()
    with pytest.raises(RuntimeError, match='browser unavailable'):
        await module.open_context(browser, {}, None, discard)
    discard.assert_not_awaited()
