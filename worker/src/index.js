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

async function api(request, env, url) {
  let user;
  try {
    user = await telegramUser(request, env);
  } catch (error) {
    return json({ ok: false, error: error.message }, 401);
  }
  const chatId = user.id;
  try {
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const [{ results: watches }, listingCount, notificationCount] = await Promise.all([
        env.DB.prepare("SELECT * FROM watches WHERE chat_id = ? AND enabled = 1 ORDER BY id DESC").bind(chatId).all(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM listings").first(),
        env.DB.prepare(
          "SELECT COUNT(*) AS count FROM notifications n JOIN watches w ON w.id = n.watch_id WHERE w.chat_id = ?",
        ).bind(chatId).first(),
      ]);
      return json({
        ok: true,
        user: { id: user.id, first_name: user.first_name || "" },
        watches,
        stats: { listings: Number(listingCount?.count || 0), alerts: Number(notificationCount?.count || 0) },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/watches") {
      const body = await request.json();
      const query = String(body.query || "").trim();
      if (query.length < 2 || query.length > 100) throw new Error("Укажите товар для поиска");
      const maxPrice = numberField(body.max_buy_price, "Максимальная цена", { minimum: 1 });
      const expected = numberField(body.expected_sale_price, "Цена перепродажи", { nullable: true, minimum: 1 });
      const minProfit = numberField(body.min_profit, "Минимальная прибыль", { minimum: 0 });
      const minRoi = numberField(body.min_roi, "Минимальный ROI", { minimum: 0 });
      const result = await env.DB.prepare(
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
        Number(env.DEFAULT_SALE_FEE_PERCENT || 5),
        Number(env.DEFAULT_FIXED_COSTS || 500),
      ).run();
      return json({ ok: true, id: result.meta.last_row_id }, 201);
    }
    const deleteMatch = url.pathname.match(/^\/api\/watches\/(\d+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const result = await env.DB.prepare("DELETE FROM watches WHERE id = ? AND chat_id = ?")
        .bind(Number(deleteMatch[1]), chatId)
        .run();
      return json({ ok: true, deleted: Boolean(result.meta.changes) });
    }
    if (request.method === "POST" && url.pathname === "/api/listings") {
      const body = await request.json();
      const listing = validateListing({
        ...body,
        external_id: body.external_id || `manual-${chatId}-${Date.now()}`,
      });
      const sent = await processListings(env, [listing]);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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

