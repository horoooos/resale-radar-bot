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
    </article>`).join("");
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
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
