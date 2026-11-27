import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const { validateListing, sendDeal, collector, comparableKey, inspectListing, assessListing, watchOptions, tradeFields, deleteWatch } = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { validateListing, sendDeal, collector, comparableKey, inspectListing, assessListing, watchOptions, tradeFields, deleteWatch };').toString('base64')}`);
const listing = { external_id: 'test', title: 'Телефон', price: 10000, url: 'https://example.com/item', image_url: 'https://example.com/photo.jpg', description:'Полностью исправный телефон, всё проверено продавцом.', detail_status:'complete' };
const result = { expected: 15000, costs: 1000, profit: 4000, roi: 40, confidence: 'задана пользователем', count: 0 };

test('radar deletion is one owner-scoped transaction and preserves trade history', async()=>{
  let statements;
  const DB={prepare(sql){return {bind(...values){return {sql,values};}};},async batch(batch){statements=batch;return batch.map((_,i)=>({meta:{changes:i===batch.length-1?1:2}}));}};
  const result=await deleteWatch({DB},7,815803688);
  assert.equal(result.meta.changes,1);
  assert.equal(statements.length,9);
  for(const statement of statements){
    assert.match(statement.sql,/chat_id = \?/);
    assert.deepEqual(statement.values,[7,815803688]);
    assert.doesNotMatch(statement.sql,/trade_book|DELETE FROM listings|listing_states/);
  }
  assert.match(statements.at(-1).sql,/DELETE FROM watches /);
});

test('trade journal calculates actual net profit and leaves unsold stock unrealized',()=>{
  const body={title:'iPhone 11',purchase_price:10000,sale_price:15000,purchased_at:'2026-11-20',sold_at:'2026-11-27',repair:1000,delivery:300,commission:500,other:200};
  assert.equal(tradeFields(body).profit,3000);
  assert.equal(tradeFields({...body,sale_price:'',sold_at:''}).profit,null);
  assert.throws(()=>tradeFields({...body,sold_at:'2026-11-19'}));
  assert.throws(()=>tradeFields({...body,purchased_at:'2026-02-30'}));
  assert.throws(()=>tradeFields({...body,repair:-1}));
});

test('market comparisons distinguish phone model numbers and memory size', () => {
  assert.notEqual(comparableKey('iPhone 6, 32 ГБ'), comparableKey('iPhone 11, 32 ГБ'));
  assert.notEqual(comparableKey('iPhone 11, 64 ГБ'), comparableKey('iPhone 11, 128 ГБ'));
  assert.notEqual(comparableKey('iPhone 11 Pro, 128 ГБ'), comparableKey('iPhone 11, 128 ГБ'));
  assert.equal(comparableKey('iPhone 11, 128 ГБ, 1 SIM'), comparableKey('iPhone 11, 128 ГБ, SIM + eSIM'));
  assert.equal(comparableKey('Apple iPhone 11, 128 ГБ'), comparableKey('iPhone 11, 128 ГБ'));
  assert.notEqual(comparableKey('Xiaomi Redmi Note 8, 4/64 ГБ'), comparableKey('Xiaomi Redmi Note 8, 6/64 ГБ'));
});

test('description checks distinguish unknown delivery, negative delivery and seller claims', () => {
  assert.equal(inspectListing({...listing,description:'Исправный телефон.'}).delivery,null);
  assert.equal(inspectListing({...listing,description:'Отправлю Авито доставкой.'}).delivery,true);
  assert.equal(inspectListing({...listing,description:'Авито доставка есть, но только самовывоз.'}).delivery,false);
  assert.equal(inspectListing({...listing,description:'Аккумулятор 76%, есть трещина на стекле.'}).battery,76);
  assert.ok(inspectListing({...listing,description:'Не включается, на запчасти.'}).risks.length);
  assert.equal(inspectListing({...listing,description:'Телефон не заблокирован. Экран без трещин.'}).risks.length,0);
  assert.equal(inspectListing({...listing,description:'Авито доставкой не пользуюсь, только встреча.'}).delivery,false);
  assert.equal(inspectListing({...listing,description:'Батарея 100% заряда, телефон включён.'}).battery,null);
});

const phone={...listing,title:'iPhone 11, 128 ГБ',price:10000,category:'Телефоны',delivery:true,condition:'Б/у'};
const market=Array.from({length:6},(_,i)=>({...phone,external_id:`market-${i}`,price:20000+i*500}));
const radar={min_profit:2000,min_roi:15,max_buy_price:15000,expected_sale_price:null,options:watchOptions({min_comparables:5})};

test('profit uses exact checked market samples and includes each cost', () => {
  const a=assessListing(phone,radar,market);
  assert.equal(a.market.count,6);
  assert.equal(a.eligible,true);
  assert.equal(a.profit,a.expected-phone.price-Object.values(a.costs).reduce((x,y)=>x+y,0));
  assert.ok(a.costs.reserve>0);
});

test('wrong models, damaged analogues and the candidate itself do not create a market', () => {
  const invalid=[phone,...market.map(m=>({...m,title:'iPhone 13, 128 ГБ'})),...market.map(m=>({...m,external_id:m.external_id+'broken',description:'Не включается, на запчасти.'}))];
  const a=assessListing(phone,radar,invalid);
  assert.equal(a.expected,null);
  assert.equal(a.eligible,false);
});

test('unknown descriptions and unconfirmed delivery suppress notifications even when price is low', () => {
  assert.equal(assessListing({...phone,detail_status:'pending'},radar,market).eligible,false);
  assert.equal(assessListing({...phone,delivery:null},{...radar,options:watchOptions({delivery_only:true})},market).eligible,false);
  assert.equal(assessListing({...phone,description:'Разбит экран, требует ремонта.'},radar,market).eligible,false);
});

test('stop words, battery and repair allowance affect decisions', () => {
  assert.equal(assessListing({...phone,description:'Телефон продаётся только в рассрочку.'},{...radar,options:watchOptions({stop_words:'рассрочку'})},market).eligible,false);
  assert.equal(assessListing(phone,{...radar,options:watchOptions({battery_min:85})},market).eligible,false);
  const normal=assessListing(phone,radar,market), repair=assessListing(phone,{...radar,options:watchOptions({repair_costs:3000})},market);
  assert.equal(normal.profit-repair.profit,3000);
});

test('Avito rating is independent and absence never means below market', () => {
  const options=watchOptions({avito_price_filter:'below'});
  assert.equal(assessListing(phone,{...radar,options},market).eligible,false);
  assert.equal(assessListing({...phone,avito_price_status:'above'},{...radar,options},market).eligible,false);
  assert.equal(assessListing({...phone,avito_price_status:'below'},{...radar,options},market).eligible,true);
  assert.equal(assessListing(phone,radar,market).market.mean,21250);
  assert.ok(inspectListing({...phone,specs:{screen:'Есть дефекты'}}).risks.length);
  assert.equal(inspectListing({...phone,specs:{screen:'Без дефектов'}}).risks.length,0);
});

test('validates optional listing photo and rejects executable URLs', () => {
  assert.equal(validateListing(listing).image_url, listing.image_url);
  assert.equal(validateListing({ ...listing, image_url: '' }).image_url, '');
  assert.throws(() => validateListing({ ...listing, image_url: 'javascript:alert(1)' }));
});

test('collector rejects requests without its secret before reading database', async () => {
  const response = await collector(new Request('https://app/collector/watches'), { TELEGRAM_WEBHOOK_SECRET: 'test-secret' }, new URL('https://app/collector/watches'));
  assert.equal(response.status, 401);
  const session=await collector(new Request('https://app/collector/session?engine=chrome'),{TELEGRAM_WEBHOOK_SECRET:'test-secret'},new URL('https://app/collector/session?engine=chrome'));
  assert.equal(session.status,401);
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
