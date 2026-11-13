const HELP = `<b>Resale Radar</b> ищет объявления с потенциальной маржой.

<code>/watch запрос | макс_цена | цена_перепродажи | мин_прибыль | мин_ROI</code>
Пример: <code>/watch iphone 13 128 | 35000 | 45000 | 5000 | 15</code>

Вместо цены перепродажи можно указать <code>auto</code>.
<code>/watches</code> — мои фильтры
<code>/delwatch ID</code> — удалить фильтр
<code>/add JSON</code> — добавить и проверить объявление
<code>/help</code> — справка`;

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

function validateListing(item) {
  if (!item || typeof item !== "object") throw new Error("ожидался JSON-объект");
  const listing = {
    external_id: String(item.external_id || "").trim(),
    title: String(item.title || "").trim(),
    price: Number(item.price),
    url: String(item.url || "").trim(),
    category: String(item.category || "Другое").trim(),
    location: String(item.location || "").trim(),
    published_at: String(item.published_at || new Date().toISOString()),
  };
  if (!listing.external_id || listing.title.length < 2) throw new Error("нет external_id или title");
  if (!Number.isInteger(listing.price) || listing.price <= 0) throw new Error("price должен быть целым числом > 0");
  const parsedUrl = new URL(listing.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error("url должен быть HTTP(S)-ссылкой");
  return listing;
}

async function saveListing(env, listing) {
  await env.DB.prepare(
    `INSERT INTO listings
      (external_id, title, price, url, category, location, published_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET
      title=excluded.title, price=excluded.price, url=excluded.url,
      category=excluded.category, location=excluded.location,
      published_at=excluded.published_at, raw_json=excluded.raw_json`,
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

<a href="${escapeHtml(listing.url)}">Открыть объявление</a>

⚠️ Проверьте состояние, комплектность, документы и продавца лично. Расчёт — оценка, а не гарантия прибыли.`;
}

async function comparablePrices(env, listing) {
  const tokens = words(listing.title).filter((word) => word.length > 2).slice(0, 4);
  const clauses = tokens.map(() => "lower(title) LIKE ?").join(" AND ") || "1=1";
  const statement = env.DB.prepare(
    `SELECT price FROM listings WHERE ${clauses} AND external_id != ? AND category = ? LIMIT 100`,
  );
  const bindings = [...tokens.map((word) => `%${word}%`), listing.external_id, listing.category];
  const { results } = await statement.bind(...bindings).all();
  return results.map((row) => Number(row.price));
}

async function processListings(env, input) {
  const { results: watches } = await env.DB.prepare("SELECT * FROM watches WHERE enabled = 1").all();
  let sent = 0;
  for (const raw of input) {
    const listing = validateListing(raw);
    const prices = await comparablePrices(env, listing);
    await saveListing(env, listing);
    for (const watch of watches) {
      if (!matches(listing, watch)) continue;
      const alreadySent = await env.DB.prepare(
        "SELECT 1 AS found FROM notifications WHERE watch_id = ? AND external_id = ?",
      )
        .bind(watch.id, listing.external_id)
        .first();
      if (alreadySent) continue;
      if (!watch.expected_sale_price && prices.length < Number(env.MIN_COMPARABLES || 3)) continue;
      const result = score(listing, watch, prices);
      if (!result) continue;
      await answer(env, watch.chat_id, formatDeal(listing, result));
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
    await answer(env, chatId, HELP);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return webhook(request, env, ctx);
    }
    if (url.pathname === "/health") return json({ ok: true, service: "resale-radar" });
    return new Response("Resale Radar is running", { status: 200 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scanFeed(env));
  },
};

