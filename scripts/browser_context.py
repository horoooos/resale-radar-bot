"""Recover an anonymous browser context if saved state is incompatible."""


async def open_context(browser, options, stored, discard_state):
    if not stored:
        return await browser.new_context(**options)
    try:
        return await browser.new_context(**options, storage_state=stored)
    except Exception:
        # Reset only the collector's own state; never use personal browser data.
        await discard_state()
        return await browser.new_context(**options)
