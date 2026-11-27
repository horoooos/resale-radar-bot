const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.setHeaderColor("#090b0d");
tg?.setBackgroundColor("#090b0d");

const initData = tg?.initData || "";
const rubles = new Intl.NumberFormat("ru-RU");
const $ = (selector) => document.querySelector(selector);

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = error ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ""; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "X-Telegram-Init-Data": initData, ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Ошибка соединения");
  return result;
}

function renderWatches(watches) {
  const list = $("#watch-list");
  if (!watches.length) {
    list.innerHTML = '<div class="empty">Радар пока молчит.<br>Создайте первый фильтр поиска.</div>';
    return;
  }
  list.innerHTML = watches.map((watch) => `
    <article class="watch-card">
      <h3>${escapeHtml(watch.query)}</h3>
      <button class="delete" data-delete="${watch.id}" aria-label="Удалить фильтр">×</button>
      <div class="watch-meta">
        <span class="chip">до ${rubles.format(watch.max_buy_price)} ₽</span>
        <span class="chip">прибыль от ${rubles.format(watch.min_profit)} ₽</span>
        <span class="chip">ROI от ${watch.min_roi}%</span>
        <span class="chip">${watch.expected_sale_price ? `продажа ${rubles.format(watch.expected_sale_price)} ₽` : "автооценка"}</span>
      </div>
      ${watch.scanned_at ? `<p class="field-note" style="margin:12px 0 0">${watch.scan_error ? `Проверка не удалась: ${escapeHtml(watch.scan_error)}` : `Проверено: ${escapeHtml(watch.scanned_at)} UTC · ${watch.item_count} товаров`}</p>` : ""}
      ${watch.source_url ? `<button class="source-link" type="button" data-source-url="${escapeHtml(watch.source_url)}">Открыть поиск Avito ↗</button>` : ""}
    </article>`).join("");
}

function renderDeals(deals) {
  const list = $("#deal-list");
  if (!deals.length) {
    list.innerHTML = '<div class="empty">Пока выгодных предложений нет.<br>Подходящие сделки появятся здесь и придут в чат.</div>';
    return;
  }
  list.innerHTML = deals.map((deal) => `
    <article class="deal-card">
      ${deal.image_url ? `<img class="deal-photo" src="${escapeHtml(deal.image_url)}" alt="Фото товара" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="deal-photo deal-photo-fallback">Фото не предоставлено</div>'}
      <div class="deal-body">
        <h3>${escapeHtml(deal.title)}</h3>
        <div class="deal-price">${rubles.format(deal.price)} ₽</div>
        ${deal.profit != null ? `<div class="deal-profit"><span>≈ +${rubles.format(deal.profit)} ₽</span><span>ROI ${Number(deal.roi).toFixed(1)}%</span></div>` : '<div class="deal-details">Подходящая прибыль пока не подтверждена</div>'}
        <div class="deal-details">${deal.expected ? `Продажа ≈ ${rubles.format(deal.expected)} ₽<br>` : ""}${escapeHtml(deal.location || "Город не указан")}${deal.confidence ? ` · оценка: ${escapeHtml(deal.confidence)}` : ""}</div>
        <button class="deal-open" type="button" data-source-url="${escapeHtml(deal.url)}">Открыть объявление ↗</button>
      </div>
    </article>`).join("");
  list.querySelectorAll("img").forEach((img) => {
    img.addEventListener("error", () => {
      const fallback = document.createElement("div");
      fallback.className = "deal-photo deal-photo-fallback";
      fallback.textContent = "Фото недоступно";
      img.replaceWith(fallback);
    }, { once: true });
  });
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function load() {
  if (!initData) {
    $("#watch-list").innerHTML = '<div class="empty">Откройте приложение кнопкой внутри Telegram, чтобы увидеть свои фильтры.</div>';
    $("#welcome").textContent = "Интерфейс готов. Для защищённого входа откройте его из чата с ботом.";
    return;
  }
  try {
    const data = await api("/api/dashboard");
    if (data.user.first_name) $("#welcome").textContent = `${data.user.first_name}, настройте критерии — радар рассчитает маржу и пришлёт сигнал в Telegram.`;
    $("#watch-count").textContent = data.watches.length;
    $("#listing-count").textContent = data.stats.listings;
    $("#alert-count").textContent = data.stats.alerts;
    renderWatches(data.watches);
    renderDeals(data.deals || []);
    $("#source-status").textContent = data.source_connected
      ? "Источник подключён · проверка каждый час · уведомления в чат включены"
      : "Сохраните ссылку поиска Avito. Облачная проверка выполняется каждый час; результат появится на карточке фильтра.";
  } catch (error) {
    $("#watch-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const closer = event.target.closest("[data-close]");
  if (closer) {
    closer.closest("dialog")?.close();
    return;
  }

  const opener = event.target.closest("[data-open]");
  if (opener) {
    if (!initData) return toast("Откройте приложение внутри Telegram", true);
    $(`#${opener.dataset.open}`).showModal();
  }
  const sourceLink = event.target.closest("[data-source-url]");
  if (sourceLink) {
    const url = sourceLink.dataset.sourceUrl;
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const remove = event.target.closest("[data-delete]");
  if (remove) {
    if (!confirm("Удалить этот фильтр?")) return;
    try {
      await api(`/api/watches/${remove.dataset.delete}`, { method: "DELETE" });
      tg?.HapticFeedback?.notificationOccurred("success");
      toast("Фильтр удалён");
      await load();
    } catch (error) { toast(error.message, true); }
  }
});

$("#watch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    await api("/api/watches", { method: "POST", body: JSON.stringify(body) });
    form.closest("dialog").close();
    form.reset();
    tg?.HapticFeedback?.notificationOccurred("success");
    toast("Радар запущен");
    await load();
  } catch (error) { toast(error.message, true); }
});

$("#listing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/api/listings", { method: "POST", body: JSON.stringify(body) });
    form.closest("dialog").close();
    form.reset();
    tg?.HapticFeedback?.notificationOccurred("success");
    toast(result.sent ? "Нашлась потенциально выгодная сделка" : "Объявление проверено и сохранено");
    await load();
  } catch (error) { toast(error.message, true); }
});

load();
setInterval(() => { if (!document.hidden) load(); }, 60000);
