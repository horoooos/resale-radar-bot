import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const { validateListing, sendDeal } = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { validateListing, sendDeal };').toString('base64')}`);
const listing = { external_id: 'test', title: 'Телефон', price: 10000, url: 'https://example.com/item', image_url: 'https://example.com/photo.jpg' };
const result = { expected: 15000, costs: 1000, profit: 4000, roi: 40, confidence: 'задана пользователем', count: 0 };

test('validates optional listing photo and rejects executable URLs', () => {
  assert.equal(validateListing(listing).image_url, listing.image_url);
  assert.equal(validateListing({ ...listing, image_url: '' }).image_url, '');
  assert.throws(() => validateListing({ ...listing, image_url: 'javascript:alert(1)' }));
});

test('sends photo with deal details, falls back to message if Telegram rejects photo', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const rejected = url.endsWith('/sendPhoto');
    return { ok: !rejected, json: async () => ({ ok: !rejected, description: 'photo unavailable', result: {} }) };
  };
  try {
    await sendDeal({ BOT_TOKEN: 'test-token' }, 123, validateListing(listing), result);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/sendPhoto'));
    assert.equal(calls[0].body.photo, listing.image_url);
    assert.ok(calls[1].url.endsWith('/sendMessage'));
    assert.ok(calls[1].body.text.includes('4 000'));
    assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].url, listing.url);
  } finally { globalThis.fetch = previousFetch; }
});
