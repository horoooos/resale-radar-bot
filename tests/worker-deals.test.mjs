import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const { validateListing, sendDeal, collector, comparableKey } = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { validateListing, sendDeal, collector, comparableKey };').toString('base64')}`);
const listing = { external_id: 'test', title: 'Телефон', price: 10000, url: 'https://example.com/item', image_url: 'https://example.com/photo.jpg' };
const result = { expected: 15000, costs: 1000, profit: 4000, roi: 40, confidence: 'задана пользователем', count: 0 };

test('market comparisons distinguish phone model numbers and memory size', () => {
  assert.notEqual(comparableKey('iPhone 6, 32 ГБ'), comparableKey('iPhone 11, 32 ГБ'));
  assert.notEqual(comparableKey('iPhone 11, 64 ГБ'), comparableKey('iPhone 11, 128 ГБ'));
  assert.notEqual(comparableKey('iPhone 11 Pro, 128 ГБ'), comparableKey('iPhone 11, 128 ГБ'));
  assert.equal(comparableKey('iPhone 11, 128 ГБ, 1 SIM'), comparableKey('iPhone 11, 128 ГБ, SIM + eSIM'));
});

test('validates optional listing photo and rejects executable URLs', () => {
  assert.equal(validateListing(listing).image_url, listing.image_url);
  assert.equal(validateListing({ ...listing, image_url: '' }).image_url, '');
  assert.throws(() => validateListing({ ...listing, image_url: 'javascript:alert(1)' }));
});

test('collector rejects requests without its secret before reading database', async () => {
  const response = await collector(new Request('https://app/collector/watches'), { TELEGRAM_WEBHOOK_SECRET: 'test-secret' }, new URL('https://app/collector/watches'));
  assert.equal(response.status, 401);
});

test('source-search results are scoped to their owner and use price filters rather than radar label', async () => {
  const watch = { id: 7, chat_id: 123, query: 'Мой поиск телефонов', max_buy_price: 15000, expected_sale_price: 20000, min_profit: 5000, min_roi: 15, sale_fee_percent: 5, fixed_costs: 500 };
  let queries = 0;
  const env = { BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', ALLOWED_USER_IDS: '123', DB: {
    prepare(sql) {
      queries++;
      return { bind() { return this; },
        async first() { return sql.includes('SELECT * FROM watches') ? watch : null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  } };
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
  try {
    const request = new Request('https://app/collector/results', { method: 'POST', headers: { 'X-Collector-Token': 'test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ watch_id: 7, items: [{ ...listing, image_url: '' }] }) });
    const response = await collector(request, env, new URL(request.url));
    assert.equal((await response.json()).sent, 1);
    assert.equal(calls[0].chat_id, 123);
    assert.ok(queries < 50);
  } finally { globalThis.fetch = previous; }
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
