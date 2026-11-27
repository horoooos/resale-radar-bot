const HELP = `<b>Resale Radar</b> оценивает объявления и помогает находить варианты с потенциальной маржой. Управление фильтрами и объявлениями находится в приложении.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function words(value) {
  return (String(value).toLowerCase().match(/[a-zа-яё0-9]+/giu) || []).filter(
    (word) => word.length > 1,
  );
}

function isAllowed(userId, env) {
  const ids = String(env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length === 0 || ids.includes(String(userId));
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  }
  return result.result;
}

async function answer(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: false },
    ...extra,
  });
}

function appKeyboard(env) {
  return {
    inline_keyboard: [[{ text: "Открыть Resale Radar", web_app: { url: env.APP_URL } }]],
  };
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

async function telegramUser(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  if (!initData) throw new Error("Откройте приложение из Telegram");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  params.delete("hash");
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error("Сессия Telegram устарела");
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(env.BOT_TOKEN));
  const validationKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const calculatedHash = hex(await crypto.subtle.sign("HMAC", validationKey, encoder.encode(checkString)));
  if (!safeEqual(calculatedHash, receivedHash)) throw new Error("Не удалось подтвердить вход через Telegram");
  const user = JSON.parse(params.get("user") || "{}");
  if (!user.id || !isAllowed(user.id, env)) throw new Error("У вас нет доступа к этому приложению");
  return user;
}

function numberField(value, name, { nullable = false, minimum = 0 } = {}) {
  if (nullable && (value === null || value === "" || value === undefined)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`Проверьте поле «${name}»`);
  return parsed;
}

function watchOptions(body = {}) {
  const flag = (key, fallback = false) => body[key] === undefined ? fallback : [true, 'true', 'on', 1, '1'].includes(body[key]);
  const num = (key, fallback, max = 1000000) => {
    const value = body[key] === '' || body[key] == null ? fallback : Number(body[key]);
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`Проверьте настройку ${key}`);
    return value;
  };
  return { min_buy_price: num('min_buy_price', 0), delivery_only: flag('delivery_only'), private_only: flag('private_only'),
    exclude_defects: flag('exclude_defects', true), require_details: flag('require_details', true),
    battery_min: num('battery_min', 0, 100), min_comparables: Math.max(3, num('min_comparables', 5, 50)),
    repair_costs: num('repair_costs', 0), delivery_costs: num('delivery_costs', 0), fixed_costs: num('fixed_costs', 500),
    sale_fee_percent: num('sale_fee_percent', 5, 100), reserve_percent: num('reserve_percent', 5, 100),
    stop_words: String(body.stop_words || '').trim().slice(0, 500),
    avito_price_filter:['below','market_or_below'].includes(body.avito_price_filter)?body.avito_price_filter:'any' };
}

function inspectListing(listing) {
  const text = `${listing.title}\n${listing.description || ''}\n${Object.entries(listing.specs||{}).map(([k,v])=>`${k}: ${v}`).join('\n')}`.toLowerCase().replaceAll('ё', 'е');
  const rules = [
    ['Блокировка / учётная запись', /(?:заблокирован|заблокирована|обход\s+icloud|на\s+icloud|не\s+помню\s+(?:пароль|apple)|mdm\s+lock)/iu],
    ['На запчасти / не работает', /(?:на\s+запчасти|не\s+включается|не\s+работает|неисправен|донор|не\s+ловит\s+сеть)/iu],
    ['Повреждения', /(?:разбит|треснут|трещин[аы]|дефект[а-я]*|полос[аы]\s+на\s+экране|пятн[ао]\s+на\s+экране|после\s+воды|утоплен)/iu],
    ['Ремонт / замена деталей', /(?:менял[аи]?\s+(?:экран|дисплей|аккумулятор)|замен[ае]\s+(?:экран|дисплей|акб)|неоригинальн|после\s+ремонта|требует\s+ремонта)/iu],
    ['Предоплата / условия сделки', /(?:только\s+предоплата|перевод\s+до\s+отправки|без\s+проверки)/iu],
  ];
  const risks = rules.flatMap(([label, regex]) => {
    const match = regex.exec(text);
    if (!match) return [];
    const before = text.slice(Math.max(0, match.index - 15), match.index);
    if (/(?:без|нет|не было|не)\s*$/iu.test(before) && !match[0].startsWith('не ')) return [];
    return [{ label, evidence: text.slice(Math.max(0, match.index - 25), match.index + match[0].length + 65).trim() }];
  });
  const battery = /(?:акб|аккумулятор|батаре[яи]|battery)[^\d\n]{0,25}(\d{2,3})\s*%/iu.exec(text);
  const batteryPercent = battery && Number(battery[1]) <= 100 && !/заряд/iu.test(text.slice(battery.index+battery[0].length,battery.index+battery[0].length+25)) ? Number(battery[1]) : null;
  if (batteryPercent !== null && batteryPercent < 80) risks.push({ label: 'Изношенный аккумулятор', evidence: `${batteryPercent}% по описанию` });
  let delivery = typeof listing.delivery === 'boolean' ? listing.delivery : null;
  if (/без\s+доставки|доставк[аи]\s+нет|не\s+отправляю|доставк[а-яё]*\s+не\s+(?:пользуюсь|занимаюсь|работаю)|только\s+самовывоз/iu.test(listing.description || '')) delivery = false;
  else if (delivery === null && /отправлю\s+авито|авито\s+доставк[аой]|отправляю\s+доставкой/iu.test(listing.description || '')) delivery = true;
  return { risks, battery: batteryPercent, delivery, condition: listing.condition || 'Не указано',
    details_checked: listing.detail_status === 'complete' && String(listing.description || '').trim().length >= 15,
    description_checked_at: listing.details_checked_at || null };
}

function assessListing(listing, watch, samples) {
  const options = watch.options || watchOptions();
  const inspection = inspectListing(listing);
  const reasons = [];
  if (watch.max_buy_price && listing.price > watch.max_buy_price) reasons.push('Цена выше бюджета');
  if (listing.price < options.min_buy_price) reasons.push('Цена ниже заданного диапазона');
  if (options.require_details && !inspection.details_checked) reasons.push('Полное описание ещё не проверено');
  if (options.delivery_only && inspection.delivery !== true) reasons.push('Доставка не подтверждена');
  if (options.private_only && listing.seller_type !== 'private') reasons.push('Частный продавец не подтверждён');
  if(options.avito_price_filter==='below' && listing.avito_price_status!=='below') reasons.push('Нет отметки Avito «Ниже рыночной»');
  if(options.avito_price_filter==='market_or_below' && !['market','below'].includes(listing.avito_price_status)) reasons.push('Оценка Avito не подтверждает цену не выше рынка');
  if (options.battery_min && (inspection.battery === null || inspection.battery < options.battery_min)) reasons.push('Зарядная ёмкость АКБ не подтверждена или ниже порога');
  if (options.exclude_defects && inspection.risks.length) reasons.push('Найдены признаки риска в описании');
  const haystack = `${listing.title} ${listing.description || ''}`.toLowerCase();
  for (const word of options.stop_words.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)) {
    if (haystack.includes(word)) reasons.push(`Стоп-слово: ${word}`);
  }
  const key = comparableKey(listing.title);
  const conditionGroup = item => {
    const state=String(item.condition||'').toLowerCase();
    const text=String(item.description||'').toLowerCase();
    if (/удовлетворительное/iu.test(state)) return 'used_fair';
    if (/хорошее/iu.test(state)) return 'used_good';
    if (/отличное/iu.test(state)) return 'used_excellent';
    if (/как\s+нов/iu.test(state)) return 'used_like_new';
    if (/б\s*\/\s*у|подержан/iu.test(state)) return 'used';
    if (/новый|новое/iu.test(state) && !/как\s+нов/iu.test(state)) return 'new';
    if (/не\s+(?:использовал|пользовал|вскрывал)|запечатан/iu.test(text)) return 'new';
    if (/б\s*\/\s*у|как\s+нов|пользовал|в\s+использовании/iu.test(text)) return 'used';
    return 'unknown';
  };
  const candidateCondition=conditionGroup(listing);
  if (!watch.expected_sale_price && candidateCondition==='unknown') reasons.push('Состояние телефона не подтверждено описанием или параметрами');
  const seen = new Set([String(listing.external_id)]);
  const comparable = samples.filter(sample => {
    if (seen.has(String(sample.external_id)) || comparableKey(sample.title) !== key) return false;
    seen.add(String(sample.external_id));
    return sample.detail_status === 'complete' && conditionGroup(sample) === candidateCondition && inspectListing(sample).risks.length === 0 && sample.price > 0;
  });
  const prices = comparable.map(s => s.price).sort((a,b) => a-b);
  const percentile = p => prices.length ? prices[Math.floor((prices.length-1)*p)] : null;
  const median = percentile(.5);
  const fair = prices.filter(p => p >= median * .5 && p <= median * 1.8);
  const memoryKnown = !key.endsWith('|unknown');
  const expected = watch.expected_sale_price || (memoryKnown && fair.length >= options.min_comparables ? marketPrice(fair) : null);
  if (!watch.expected_sale_price && !memoryKnown) reasons.push('Не подтверждён объём памяти для точного сравнения');
  if (!expected) reasons.push(`Недостаточно проверенных аналогов: ${fair.length}/${options.min_comparables}`);
  const costs = expected ? { commission: Math.round(expected * options.sale_fee_percent / 100), reserve: Math.round(expected * options.reserve_percent / 100),
    repair: options.repair_costs, delivery: options.delivery_costs, other: options.fixed_costs } : null;
  const totalCosts = costs ? Object.values(costs).reduce((a,b)=>a+b,0) : null;
  const profit = expected ? expected - listing.price - totalCosts : null;
  const roi = profit === null ? null : profit / listing.price * 100;
  if (profit !== null && profit < watch.min_profit) reasons.push('Прибыль ниже порога');
  if (roi !== null && roi < watch.min_roi) reasons.push('ROI ниже порога');
  return { ...inspection, model_key: key, expected, profit, roi, costs, total_costs: totalCosts,
    avito_price_status:listing.avito_price_status||'unknown', avito_price_label:listing.avito_price_label||'', specs:listing.specs||{}, recommendation_search:listing.recommendation_search||'',
    market: { count: fair.length, mean:fair.length?Math.round(fair.reduce((a,b)=>a+b,0)/fair.length):null, low: percentile(.25), median, high: percentile(.75), source: 'Цены предложений, не завершённых продаж',
      examples: comparable.filter(s => fair.includes(s.price)).slice(0,5).map(s => ({ title:s.title, price:s.price, url:s.url })) },
    confidence: watch.expected_sale_price ? 'цена задана вами' : fair.length >= 10 ? 'достаточная выборка' : fair.length >= options.min_comparables ? 'небольшая выборка' : 'мало данных',
    eligible: reasons.length === 0, reasons, checked_at: new Date().toISOString() };
}

function avitoSearchUrl(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Проверьте ссылку на поиск Avito");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "avito.ru" && !hostname.endsWith(".avito.ru"))) {
    throw new Error("Нужна HTTPS-ссылка на поиск с avito.ru");
  }
  if (input.length > 3000) throw new Error("Ссылка на поиск слишком длинная");
  return parsed.toString();
}

function tradeFields(body) {
  const title=String(body.title||'').trim().slice(0,200);
  if(title.length<2)throw new Error('Укажите название товара');
  const amount=(value,name,nullable=false)=>{
    const number=numberField(value,name,{nullable,minimum:nullable?1:0});
    if(number!==null&&number>100000000)throw new Error('Слишком большая сумма');
    return number===null?null:Math.round(number);
  };
  const purchase=amount(body.purchase_price,'Цена покупки');
  if(purchase<1)throw new Error('Цена покупки должна быть больше нуля');
  const sale=amount(body.sale_price,'Цена продажи',true);
  const date=(value,name)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))throw new Error(`Проверьте дату: ${name}`);
    const stamp=new Date(value+'T00:00:00Z');
    if(!Number.isFinite(stamp.getTime())||stamp.toISOString().slice(0,10)!==value)throw new Error('Некорректная дата');
    return value;
  };
  const purchased=date(body.purchased_at,'покупка');
  const sold=sale===null?null:date(body.sold_at,'продажа');
  if(sold&&sold<purchased)throw new Error('Продажа не может быть раньше покупки');
  const costs=Object.fromEntries(['repair','delivery','commission','other'].map(k=>[k,amount(body[k]||0,k)]));
  return {title,purchase,sale,costs,purchased,sold,profit:sale===null?null:sale-purchase-Object.values(costs).reduce((a,b)=>a+b,0)};
}

async function api(request, env, url) {
  let user;
  try {
    user = await telegramUser(request, env);
  } catch (error) {
    return json({ ok: false, error: error.message }, 401);
  }
  const chatId = user.id;
  try {
    if(request.method==='GET'&&url.pathname==='/api/trades'){
      const parts=new Intl.DateTimeFormat('en',{timeZone:'Europe/Astrakhan',year:'numeric',month:'2-digit'}).formatToParts(new Date());
      const month=parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;
      const [{results:trades},stats,{results:daily}]=await Promise.all([
        env.DB.prepare('SELECT * FROM trade_book WHERE chat_id=? ORDER BY id DESC LIMIT 100').bind(chatId).all(),
        env.DB.prepare('SELECT COUNT(*) AS sold_count, COALESCE(SUM(net_profit),0) AS profit FROM trade_book WHERE chat_id=? AND sold_at LIKE ?').bind(chatId,month+'%').first(),
        env.DB.prepare('SELECT sold_at AS day,SUM(net_profit) AS profit FROM trade_book WHERE chat_id=? AND sold_at LIKE ? GROUP BY sold_at ORDER BY sold_at').bind(chatId,month+'%').all(),
      ]);
      return json({ok:true,trades:trades.map(t=>({...t,costs:JSON.parse(t.costs_json),costs_json:undefined})),stats, daily});
    }
    const tradeMatch=url.pathname.match(/^\/api\/trades\/(\d+)$/);
    if((request.method==='POST'&&url.pathname==='/api/trades')||(request.method==='PATCH'&&tradeMatch)){
      const body=await request.json(), fields=tradeFields(body);
      const external=String(body.external_id||'').slice(0,100)||null;
      if(external&&!await env.DB.prepare('SELECT 1 FROM watch_listings wl JOIN watches w ON w.id=wl.watch_id WHERE w.chat_id=? AND wl.external_id=? LIMIT 1').bind(chatId,external).first())throw new Error('Объявление недоступно');
      if(tradeMatch){
        const result=await env.DB.prepare('UPDATE trade_book SET title=?,purchase_price=?,sale_price=?,costs_json=?,net_profit=?,purchased_at=?,sold_at=? WHERE id=? AND chat_id=?').bind(fields.title,fields.purchase,fields.sale,JSON.stringify(fields.costs),fields.profit,fields.purchased,fields.sold,Number(tradeMatch[1]),chatId).run();
        if(!result.meta.changes)return json({ok:false,error:'Сделка не найдена'},404);
      }else await env.DB.prepare('INSERT INTO trade_book(chat_id,title,external_id,purchase_price,sale_price,costs_json,net_profit,purchased_at,sold_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(chatId,fields.title,external,fields.purchase,fields.sale,JSON.stringify(fields.costs),fields.profit,fields.purchased,fields.sold).run();
      return json({ok:true});
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const [{ results: watches }, { results: deals }, listingCount, notificationCount] = await Promise.all([
        env.DB.prepare(
          `SELECT w.*, s.source_url, o.options_json, st.scanned_at, st.item_count, st.error AS scan_error
           FROM watches w LEFT JOIN watch_sources s ON s.watch_id = w.id
           LEFT JOIN watch_options o ON o.watch_id=w.id
           LEFT JOIN scan_status st ON st.watch_id = w.id
           WHERE w.chat_id = ? ORDER BY w.id DESC`,
        ).bind(chatId).all(),
        env.DB.prepare(
          `SELECT l.external_id, l.title, l.price, l.url, l.category, l.location, l.published_at,
                  json_remove(l.raw_json,'$.image_data') AS raw_json,
                  json_extract(l.raw_json,'$.image_data') != '' AS has_photo,
                  a.payload AS assessment_json, COALESCE(ls.favorite,0) AS favorite, COALESCE(ls.dismissed,0) AS dismissed,
                  d.expected, d.costs, d.profit, d.roi, d.confidence, wl.found_at AS created_at
           FROM watch_listings wl
           JOIN watches w ON w.id = wl.watch_id
           JOIN listings l ON l.external_id = wl.external_id
           LEFT JOIN deal_results_v2 d ON d.watch_id=wl.watch_id AND d.external_id=wl.external_id
           LEFT JOIN assessments a ON a.watch_id=wl.watch_id AND a.external_id=wl.external_id
           LEFT JOIN listing_states ls ON ls.chat_id=w.chat_id AND ls.external_id=wl.external_id
           WHERE w.chat_id = ?
           ORDER BY wl.found_at DESC LIMIT 80`,
        ).bind(chatId).all(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM listings").first(),
        env.DB.prepare(
          "SELECT COUNT(*) AS count FROM notifications n JOIN watches w ON w.id = n.watch_id WHERE w.chat_id = ?",
        ).bind(chatId).first(),
      ]);
      return json({
        ok: true,
        user: { id: user.id, first_name: user.first_name || "" },
        watches: watches.map(w=>({...w, options: watchOptions(JSON.parse(w.options_json || '{}')), options_json: undefined})),
        source_connected: Boolean(env.LISTINGS_FEED_URL) || watches.some(w => w.scanned_at && !w.scan_error),
        scan_interval: "каждые 5 минут",
        deals: deals.map((deal) => {
          const raw = JSON.parse(deal.raw_json || '{}');
          return { ...deal, description: raw.description || '', condition: raw.condition || '', seller_type: raw.seller_type || 'unknown', avito_price_status:raw.avito_price_status||'unknown', avito_price_label:raw.avito_price_label||'', specs:raw.specs||{},
            analysis: deal.assessment_json ? JSON.parse(deal.assessment_json) : null,
            image_url: deal.has_photo ? `${env.APP_URL}/photo?id=${encodeURIComponent(deal.external_id)}` : photoUrl(raw.image_url || '', env),
            raw_json: undefined, assessment_json: undefined };
        }),
        stats: { listings: Number(listingCount?.count || 0), alerts: Number(notificationCount?.count || 0) },
      });
    }
    const editMatch = url.pathname.match(/^\/api\/watches\/(\d+)$/);
    if (request.method === 'PATCH' && editMatch) {
      const change = await request.clone().json();
      if (typeof change.enabled === 'boolean') {
        await env.DB.prepare('UPDATE watches SET enabled=? WHERE id=? AND chat_id=?').bind(change.enabled ? 1 : 0, Number(editMatch[1]), chatId).run();
        return json({ok:true});
      }
    }
    if ((request.method === "POST" && url.pathname === "/api/watches") || (request.method === 'PATCH' && editMatch)) {
      const body = await request.json();
      const sourceUrl = avitoSearchUrl(body.source_url);
      const queryInput = String(body.query || "").trim();
      const query = queryInput || (sourceUrl ? "Поиск по ссылке Avito" : "");
      if (query.length < 2 || query.length > 100) throw new Error("Укажите товар для поиска");
      const maxPrice = numberField(body.max_buy_price, "Максимальная цена", { minimum: 1 });
      const expected = numberField(body.expected_sale_price, "Цена перепродажи", { nullable: true, minimum: 1 });
      const minProfit = numberField(body.min_profit, "Минимальная прибыль", { minimum: 0 });
      const minRoi = numberField(body.min_roi, "Минимальный ROI", { minimum: 0 });
      const options = watchOptions(body);
      if (options.min_buy_price > maxPrice) throw new Error('Минимальная цена больше максимальной');
      const watchId = editMatch ? Number(editMatch[1]) : null;
      if (watchId && !await env.DB.prepare('SELECT id FROM watches WHERE id=? AND chat_id=?').bind(watchId, chatId).first()) return json({ok:false},404);
      const result = watchId ? await env.DB.prepare(
        'UPDATE watches SET query=?,category=?,max_buy_price=?,expected_sale_price=?,min_profit=?,min_roi=?,sale_fee_percent=?,fixed_costs=? WHERE id=? AND chat_id=?',
      ).bind(query, String(body.category || '').trim() || null, Math.round(maxPrice), expected, minProfit, minRoi, options.sale_fee_percent, options.fixed_costs, watchId, chatId).run() : await env.DB.prepare(
        `INSERT INTO watches
         (chat_id, query, category, max_buy_price, expected_sale_price, min_profit, min_roi, sale_fee_percent, fixed_costs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        chatId,
        query,
        String(body.category || "").trim() || null,
        Math.round(maxPrice),
        expected === null ? null : Math.round(expected),
        Math.round(minProfit),
        minRoi,
        options.sale_fee_percent,
        options.fixed_costs,
      ).run();
      const savedId = watchId || result.meta.last_row_id;
      await env.DB.prepare('INSERT OR REPLACE INTO watch_options(watch_id,options_json) VALUES (?,?)').bind(savedId, JSON.stringify(options)).run();
      if (sourceUrl) {
        await env.DB.prepare("INSERT OR REPLACE INTO watch_sources (watch_id, source_url) VALUES (?, ?)")
          .bind(savedId, sourceUrl)
          .run();
      }
      return json({ ok: true, id: savedId }, watchId ? 200 : 201);
    }
    if (request.method === 'POST' && url.pathname === '/api/listing-state') {
      const body=await request.json();
      const owned=await env.DB.prepare('SELECT 1 FROM watch_listings wl JOIN watches w ON w.id=wl.watch_id WHERE w.chat_id=? AND wl.external_id=? LIMIT 1').bind(chatId,String(body.external_id)).first();
      if (!owned) return json({ok:false},404);
      const column = body.action === 'dismissed' ? 'dismissed' : 'favorite';
      await env.DB.prepare(`INSERT INTO listing_states(chat_id,external_id,${column}) VALUES (?,?,?) ON CONFLICT(chat_id,external_id) DO UPDATE SET ${column}=excluded.${column}`).bind(chatId,String(body.external_id),body.value?1:0).run();
      return json({ok:true});
    }
    const historyMatch=url.pathname.match(/^\/api\/history\/([^/]+)$/);
    if(request.method==='GET' && historyMatch){
      const {results}=await env.DB.prepare('SELECT price,checked_at FROM price_history WHERE external_id=? AND EXISTS (SELECT 1 FROM watch_listings wl JOIN watches w ON w.id=wl.watch_id WHERE wl.external_id=price_history.external_id AND w.chat_id=?) ORDER BY checked_at DESC LIMIT 20').bind(decodeURIComponent(historyMatch[1]),chatId).all();
      return json({ok:true,history:results});
    }
    const deleteMatch = url.pathname.match(/^\/api\/watches\/(\d+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const watchId = Number(deleteMatch[1]);
      await env.DB.prepare(
        "DELETE FROM watch_sources WHERE watch_id IN (SELECT id FROM watches WHERE id = ? AND chat_id = ?)",
      ).bind(watchId, chatId).run();
      await env.DB.prepare(
        "DELETE FROM deal_results WHERE watch_id IN (SELECT id FROM watches WHERE id = ? AND chat_id = ?)",
      ).bind(watchId, chatId).run();
      await env.DB.prepare(
        "DELETE FROM notifications WHERE watch_id IN (SELECT id FROM watches WHERE id = ? AND chat_id = ?)",
      ).bind(watchId, chatId).run();
      const result = await env.DB.prepare("DELETE FROM watches WHERE id = ? AND chat_id = ?")
        .bind(watchId, chatId)
        .run();
      return json({ ok: true, deleted: Boolean(result.meta.changes) });
    }
    if (request.method === "POST" && url.pathname === "/api/listings") {
      const body = await request.json();
      const listing = validateListing({
        ...body,
        external_id: body.external_id || `manual-${chatId}-${Date.now()}`,
      });
      const watch=await env.DB.prepare('SELECT * FROM watches WHERE id=? AND chat_id=? AND enabled=1').bind(Number(body.watch_id),chatId).first();
      if(!watch) throw new Error('Выберите активный радар для проверки');
      const stored=await env.DB.prepare('SELECT options_json FROM watch_options WHERE watch_id=?').bind(watch.id).first();
      watch.options=watchOptions(JSON.parse(stored?.options_json||'{}'));
      const sent = await processListings(env, [listing],watch);
      return json({ ok: true, sent }, 201);
    }
    return json({ ok: false, error: "Маршрут не найден" }, 404);
  } catch (error) {
    return json({ ok: false, error: error.message || "Не удалось выполнить запрос" }, 400);
  }
}

function validateListing(item) {
  if (!item || typeof item !== "object") throw new Error("ожидался JSON-объект");
  const listing = {
    external_id: String(item.external_id || "").trim(),
    title: String(item.title || "").trim(),
    price: Number(item.price),
    url: String(item.url || "").trim(),
    category: String(item.category || "Другое").trim(),
    location: String(item.location || "").trim(),
    image_url: String(item.image_url || "").trim(),
    image_data: String(item.image_data || ""),
    description: String(item.description || '').trim().slice(0,12000),
    condition: String(item.condition || '').slice(0,150),
    delivery: typeof item.delivery === 'boolean' ? item.delivery : null,
    seller_type: ['private','business'].includes(item.seller_type) ? item.seller_type : 'unknown',
    detail_status: item.detail_status === 'complete' ? 'complete' : 'pending',
    details_checked_at: item.details_checked_at || (item.detail_status==='complete' ? new Date().toISOString() : null),
    details_attempted_at: item.details_attempted_at || null,
    avito_price_status:['above','market','below'].includes(item.avito_price_status)?item.avito_price_status:'unknown',
    avito_price_label:({above:'Цена выше рыночной',market:'Рыночная цена',below:'Цена ниже рыночной'})[item.avito_price_status]||'',
    specs: Object.fromEntries(['screen','body','kit','manufacturer','model','storage','ram','color','sim'].filter(k=>typeof item.specs?.[k]==='string').map(k=>[k,item.specs[k].slice(0,150)])),
    recommendation_search:String(item.recommendation_search||'').slice(0,200),
    mobile_fields_version:item.mobile_fields_version===1?1:0,
    published_at: String(item.published_at || new Date().toISOString()),
  };
  if (!listing.external_id || listing.title.length < 2) throw new Error("нет external_id или title");
  if (!Number.isInteger(listing.price) || listing.price <= 0) throw new Error("price должен быть целым числом > 0");
  const parsedUrl = new URL(listing.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error("url должен быть HTTP(S)-ссылкой");
  if (listing.image_url) {
    const imageUrl = new URL(listing.image_url);
    if (!['http:', 'https:'].includes(imageUrl.protocol)) throw new Error("image_url должен быть HTTP(S)-ссылкой");
  }
  if (listing.image_data && (listing.image_data.length > 140000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(listing.image_data))) throw new Error("Некорректное фото");
  return listing;
}

async function saveListing(env, listing) {
  await env.DB.prepare('INSERT INTO price_history(external_id,price) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM listings WHERE external_id=? AND price=?)')
    .bind(listing.external_id, listing.price, listing.external_id, listing.price).run();
  await env.DB.prepare(
    `INSERT INTO listings
      (external_id, title, price, url, category, location, published_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET
      title=excluded.title, price=excluded.price, url=excluded.url,
      category=excluded.category, location=excluded.location,
      published_at=excluded.published_at,
      raw_json=CASE WHEN json_extract(excluded.raw_json,'$.image_data') != '' THEN excluded.raw_json
        ELSE json_set(excluded.raw_json,'$.image_data',COALESCE(json_extract(listings.raw_json,'$.image_data'),'')) END`,
  )
    .bind(
      listing.external_id,
      listing.title,
      listing.price,
      listing.url,
      listing.category,
      listing.location,
      listing.published_at,
      JSON.stringify(listing),
    )
    .run();
}

function matches(listing, watch) {
  const titleWords = new Set(words(listing.title));
  if (!words(watch.query).every((word) => titleWords.has(word))) return false;
  if (watch.category && listing.category.toLowerCase() !== watch.category.toLowerCase()) return false;
  return watch.max_buy_price == null || listing.price <= watch.max_buy_price;
}

function marketPrice(prices) {
  const sorted = prices.filter((price) => price > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length < 4) {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
  }
  const trim = Math.max(1, Math.floor(sorted.length * 0.1));
  const values = sorted.length - trim * 2 >= 2 ? sorted.slice(trim, -trim) : sorted;
  const index = (values.length - 1) * 0.4;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return Math.floor(values[low] + (values[high] - values[low]) * (index - low));
}

function score(listing, watch, prices) {
  const expected = watch.expected_sale_price || marketPrice(prices);
  if (!expected) return null;
  const costs = Math.round((expected * watch.sale_fee_percent) / 100) + watch.fixed_costs;
  const profit = expected - listing.price - costs;
  const roi = (profit / listing.price) * 100;
  if (profit < watch.min_profit || roi < watch.min_roi) return null;
  const confidence = watch.expected_sale_price
    ? "задана пользователем"
    : prices.length >= 10
      ? "высокая"
      : prices.length >= 5
        ? "средняя"
        : "низкая";
  return { expected, costs, profit, roi, confidence, count: prices.length };
}

function formatRubles(value) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatDeal(listing, result) {
  return `🔥 <b>Возможная выгодная перепродажа</b>

<b>${escapeHtml(listing.title)}</b>
Покупка: <b>${formatRubles(listing.price)} ₽</b>
Оценка быстрой продажи: <b>${formatRubles(result.expected)} ₽</b>
Расходы: ≈ ${formatRubles(result.costs)} ₽
Чистая прибыль: <b>≈ ${formatRubles(result.profit)} ₽</b>
ROI: <b>${result.roi.toFixed(1)}%</b>
Надёжность оценки: ${result.confidence} (${result.count} аналогов)
Город: ${escapeHtml(listing.location || "не указано")}

${escapeHtml(listing.analysis_caption || '')}

<a href="${escapeHtml(listing.url)}">Открыть объявление</a>

⚠️ Проверьте состояние, комплектность, документы и продавца лично. Расчёт — оценка, а не гарантия прибыли.`;
}

async function sendDeal(env, chatId, listing, result) {
  const text = formatDeal(listing, result);
  const replyMarkup = { inline_keyboard: [[{ text: "Открыть объявление", url: listing.url }]] };
  if (listing.image_url || listing.image_data) {
    try {
      return await telegram(env, "sendPhoto", {
        chat_id: chatId,
        photo: listing.image_data ? `${env.APP_URL}/photo?id=${encodeURIComponent(listing.external_id)}` : photoUrl(listing.image_url, env),
        caption: text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
    } catch {
      // Если источник не разрешает Telegram загрузить фото, отправляем обычное сообщение.
    }
  }
  return answer(env, chatId, text, { reply_markup: replyMarkup });
}

function comparableKey(title) {
  const text = String(title).toLowerCase().replaceAll("ё", "е");
  const model = text.split(",")[0].replace(/[^a-zа-я0-9]/gu, "").replace(/^(?:(?:смартфон|мобильныйтелефон|телефон|apple))+/u,'');
  const memory = text.match(/(\d+)\s*(гб|gb|тб|tb)/iu);
  const ram=text.match(/(\d+)\s*\/\s*\d+\s*(?:гб|gb)/iu);
  return `${model}|${memory ? memory[1] + (/тб|tb/iu.test(memory[2]) ? "tb" : "gb") : "unknown"}${ram?'|ram'+ram[1]:''}`;
}

async function comparablePrices(env, listing) {
  const { results } = await env.DB.prepare(
    "SELECT title, price FROM listings WHERE external_id != ? AND category = ? ORDER BY published_at DESC LIMIT 200",
  ).bind(listing.external_id, listing.category).all();
  const key = comparableKey(listing.title);
  return results.filter(row => comparableKey(row.title) === key).map(row => Number(row.price));
}

async function marketSamples(env, listing) {
  const {results} = await env.DB.prepare("SELECT payload FROM market_samples WHERE model_key=? AND checked_at > datetime('now','-7 days') ORDER BY checked_at DESC LIMIT 100").bind(comparableKey(listing.title)).all();
  return results.map(row=>JSON.parse(row.payload));
}

async function processListings(env, input, sourceWatch = null) {
  const watches = sourceWatch ? [sourceWatch] : (await env.DB.prepare("SELECT w.*,o.options_json FROM watches w LEFT JOIN watch_options o ON o.watch_id=w.id WHERE w.enabled=1").all()).results.map(w=>({...w,options:watchOptions(JSON.parse(w.options_json||'{}'))}));
  const validated = input.map(validateListing);
  for (const listing of validated) {
    await saveListing(env, listing);
    if (sourceWatch) await env.DB.prepare("INSERT OR IGNORE INTO watch_listings(watch_id,external_id) VALUES (?,?)")
      .bind(sourceWatch.id, listing.external_id).run();
  }
  let sent = 0;
  for (const listing of validated) {
    const samples = await marketSamples(env, listing);
    for (const watch of watches) {
      if (!sourceWatch && !matches(listing, watch)) continue;
      const analysis = assessListing(listing, watch, samples);
      await env.DB.prepare('INSERT OR REPLACE INTO assessments(watch_id,external_id,payload) VALUES (?,?,?)')
        .bind(watch.id,listing.external_id,JSON.stringify(analysis)).run();
      if (!analysis.eligible) continue;
      const alreadySent = await env.DB.prepare(
        "SELECT 1 AS found FROM notifications WHERE watch_id = ? AND external_id = ?",
      )
        .bind(watch.id, listing.external_id)
        .first();
      if (alreadySent) continue;
      const result = { expected:analysis.expected, costs:analysis.total_costs, profit:analysis.profit, roi:analysis.roi, confidence:analysis.confidence, count:analysis.market.count };
      if (!sourceWatch) await env.DB.prepare("INSERT OR IGNORE INTO watch_listings(watch_id,external_id) VALUES (?,?)")
        .bind(watch.id, listing.external_id).run();
      const deliveryLabel = analysis.delivery === true ? 'доступна по карточке/описанию' : analysis.delivery === false ? 'нет' : 'не подтверждена';
      const enhanced = { ...listing, title:listing.title, analysis_caption: `Доставка: ${deliveryLabel}\nСостояние по продавцу: ${listing.condition || 'не указано'}\nРиски: ${analysis.risks.map(r=>r.label).join(', ') || 'по проверенному тексту не выявлены'}\nРезерв расходов включён.` };
      await sendDeal(env, watch.chat_id, enhanced, result);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO deal_results_v2
         (watch_id, external_id, expected, costs, profit, roi, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(
        watch.id,
        listing.external_id,
        result.expected,
        result.costs,
        result.profit,
        result.roi,
        result.confidence,
      ).run();
      await env.DB.prepare("INSERT OR IGNORE INTO notifications (watch_id, external_id) VALUES (?, ?)")
        .bind(watch.id, listing.external_id)
        .run();
      sent += 1;
    }
  }
  return sent;
}

async function command(env, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = String(message.text || "").trim();
  if (!isAllowed(userId, env)) {
    await answer(env, chatId, "У вас нет доступа к этому боту.");
    return;
  }
  const name = text.split(/\s/, 1)[0].split("@")[0].toLowerCase();
  const body = text.slice(text.indexOf(" ") + 1).trim();
  if (["/start", "/help"].includes(name)) {
    await answer(env, chatId, `${HELP}\n\nНажмите кнопку ниже, чтобы открыть приложение.`, {
      reply_markup: appKeyboard(env),
    });
    return;
  }
  if (name === "/watch") {
    const parts = body.split("|").map((part) => part.trim());
    if (parts.length !== 5) {
      await answer(env, chatId, "Формат: /watch запрос | макс_цена | цена_перепродажи/auto | мин_прибыль | мин_ROI");
      return;
    }
    const maxPrice = Number(parts[1].replaceAll(" ", ""));
    const expected = parts[2].toLowerCase() === "auto" ? null : Number(parts[2].replaceAll(" ", ""));
    const minProfit = Number(parts[3].replaceAll(" ", ""));
    const minRoi = Number(parts[4].replace(",", "."));
    if (!parts[0] || ![maxPrice, minProfit, minRoi].every(Number.isFinite) || (expected !== null && !Number.isFinite(expected))) {
      await answer(env, chatId, "Не удалось разобрать параметры фильтра. Проверьте числа.");
      return;
    }
    const result = await env.DB.prepare(
      `INSERT INTO watches
       (chat_id, query, max_buy_price, expected_sale_price, min_profit, min_roi, sale_fee_percent, fixed_costs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        chatId,
        parts[0],
        maxPrice,
        expected,
        minProfit,
        minRoi,
        Number(env.DEFAULT_SALE_FEE_PERCENT || 5),
        Number(env.DEFAULT_FIXED_COSTS || 500),
      )
      .run();
    await answer(env, chatId, `✅ Фильтр #${result.meta.last_row_id} создан.`);
    return;
  }
  if (name === "/watches") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM watches WHERE chat_id = ? AND enabled = 1 ORDER BY id",
    )
      .bind(chatId)
      .all();
    if (!results.length) {
      await answer(env, chatId, "Фильтров пока нет. Создайте первый командой /watch.");
      return;
    }
    const lines = ["<b>Ваши фильтры</b>"];
    for (const watch of results) {
      const sale = watch.expected_sale_price ? `${formatRubles(watch.expected_sale_price)} ₽` : "автооценка";
      lines.push(
        `#${watch.id}: <b>${escapeHtml(watch.query)}</b> · до ${formatRubles(watch.max_buy_price)} ₽ · ` +
          `продажа ${sale} · прибыль от ${formatRubles(watch.min_profit)} ₽ · ROI от ${watch.min_roi}%`,
      );
    }
    await answer(env, chatId, lines.join("\n"));
    return;
  }
  if (name === "/delwatch") {
    const id = Number(body);
    if (!Number.isInteger(id)) {
      await answer(env, chatId, "Формат: /delwatch ID");
      return;
    }
    const result = await env.DB.prepare("DELETE FROM watches WHERE id = ? AND chat_id = ?")
      .bind(id, chatId)
      .run();
    await answer(env, chatId, result.meta.changes ? "Удалено." : "Такой фильтр не найден.");
    return;
  }
  if (name === "/add") {
    try {
      const listing = validateListing(JSON.parse(body));
      const sent = await processListings(env, [listing]);
      await answer(env, chatId, `✅ Объявление сохранено. Подходящих уведомлений: ${sent}.`);
    } catch (error) {
      await answer(env, chatId, `Некорректное объявление: ${escapeHtml(error.message)}`);
    }
    return;
  }
  await answer(env, chatId, "Неизвестная команда. Используйте /help.");
}

async function webhook(request, env, ctx) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = await request.json();
  if (update.message?.text) ctx.waitUntil(command(env, update.message));
  return json({ ok: true });
}

async function scanFeed(env) {
  if (!env.LISTINGS_FEED_URL) return;
  const response = await fetch(env.LISTINGS_FEED_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error("Feed must contain an items array");
  await processListings(env, items);
}

function avitoImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname.endsWith(".avito.st") || parsed.hostname.endsWith(".avito.ru"));
  } catch { return false; }
}

function photoUrl(url, env) {
  return env.APP_URL && avitoImage(url) ? `${env.APP_URL}/photo?url=${encodeURIComponent(url)}` : url;
}

async function photo(requestUrl, env) {
  const id = requestUrl.searchParams.get("id");
  if (id) {
    const row = await env.DB.prepare("SELECT raw_json FROM listings WHERE external_id=?").bind(id).first();
    const data = row ? JSON.parse(row.raw_json).image_data : null;
    if (!data) return new Response("Image unavailable", { status: 404 });
    return new Response(Uint8Array.from(atob(data), c => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
  }
  const url = requestUrl.searchParams.get("url") || "";
  if (!avitoImage(url)) return new Response("Invalid image", { status: 400 });
  const response = await fetch(url, { headers: { Referer: "https://www.avito.ru/" }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return new Response("Image unavailable", { status: 404 });
  return new Response(response.body, { headers: { "content-type": response.headers.get("content-type"), "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
}

async function collector(request, env, url) {
  const token = request.headers.get("X-Collector-Token") || "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(token, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false }, 401);
  }
  if (request.method === "GET" && url.pathname === "/collector/watches") {
    const { results } = await env.DB.prepare(
      `SELECT w.*, s.source_url, o.options_json FROM watches w JOIN watch_sources s ON s.watch_id=w.id
       LEFT JOIN watch_options o ON o.watch_id=w.id
       LEFT JOIN scan_status st ON st.watch_id=w.id
       WHERE w.enabled=1 ORDER BY COALESCE(st.scanned_at, '1970-01-01') ASC, w.id LIMIT 1`,
    ).all();
    const allowed=results.filter(w => isAllowed(w.chat_id, env));
    const cache=allowed.length ? await env.DB.prepare("SELECT l.external_id,json_remove(l.raw_json,'$.image_data') AS payload FROM listings l JOIN watch_listings wl ON wl.external_id=l.external_id WHERE wl.watch_id=? ORDER BY wl.found_at DESC LIMIT 100").bind(allowed[0].id).all() : {results:[]};
    const keys=await env.DB.prepare("SELECT model_key,payload FROM market_samples WHERE checked_at > datetime('now','-6 hours') LIMIT 300").all();
    const counts={};
    for(const row of keys.results){const sample=JSON.parse(row.payload);if(sample.detail_status==='complete'&&!inspectListing(sample).risks.length) counts[row.model_key]=(counts[row.model_key]||0)+1;}
    const attempts=await env.DB.prepare("SELECT model_key FROM market_attempts WHERE checked_at > datetime('now','-20 minutes')").all();
    return json({ ok: true, watches: allowed.map(w=>({...w,options:watchOptions(JSON.parse(w.options_json||'{}'))})), detail_cache: cache.results.map(r=>JSON.parse(r.payload)), market_keys: [...new Set([...Object.keys(counts).filter(k=>counts[k]>=6),...attempts.results.map(r=>r.model_key)])] });
  }
  if(request.method==='POST' && url.pathname==='/collector/market-status'){
    const body=await request.json();
    const key=String(body.model_key||'').slice(0,200);
    if(!key)return json({ok:false},400);
    await env.DB.prepare('INSERT OR REPLACE INTO market_attempts(model_key,checked_at) VALUES (?,CURRENT_TIMESTAMP)').bind(key).run();
    return json({ok:true});
  }
  if (request.method === 'POST' && url.pathname === '/collector/market') {
    const body=await request.json();
    const items=(Array.isArray(body.items)?body.items:[]).slice(0,5).map(validateListing);
    for (const item of items) {
      item.image_data='';
      await env.DB.prepare('INSERT OR REPLACE INTO market_samples(external_id,model_key,payload,checked_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
        .bind(item.external_id,comparableKey(item.title),JSON.stringify(item)).run();
    }
    return json({ok:true,count:items.length});
  }
  if (request.method === "POST" && ["/collector/results", "/collector/status"].includes(url.pathname)) {
    const body = await request.json();
    const watch = await env.DB.prepare("SELECT * FROM watches WHERE id=? AND enabled=1")
      .bind(Number(body.watch_id)).first();
    if (!watch || !isAllowed(watch.chat_id, env)) return json({ ok: false }, 404);
    const storedOptions=await env.DB.prepare('SELECT options_json FROM watch_options WHERE watch_id=?').bind(watch.id).first();
    watch.options=watchOptions(JSON.parse(storedOptions?.options_json||'{}'));
    const items = Array.isArray(body.items) ? body.items.slice(0, 3) : [];
    let sent = 0;
    if (!body.error) sent = await processListings(env, items, watch);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO scan_status(watch_id, scanned_at, item_count, error)
       VALUES (?, CURRENT_TIMESTAMP, ?, ?)`,
    ).bind(watch.id, url.pathname === "/collector/status" ? Math.min(60, Math.max(0, Number(body.count) || 0)) : items.length, body.error ? String(body.error).slice(0, 300) : null).run();
    return json({ ok: true, count: items.length, sent });
  }
  return json({ ok: false }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/photo") return photo(url, env);
    if (url.pathname.startsWith("/collector/")) return collector(request, env, url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return webhook(request, env, ctx);
    }
    if (url.pathname === "/health") return json({ ok: true, service: "resale-radar" });
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scanFeed(env));
  },
};

