const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.setHeaderColor("#090b0d");
tg?.setBackgroundColor("#090b0d");

const initData = tg?.initData || "";
const rubles = new Intl.NumberFormat("ru-RU");
const $ = (selector) => document.querySelector(selector);
let dashboard = { watches: [], deals: [] };

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
      <div class="watch-actions"><button type="button" class="small-button" data-edit="${watch.id}">Настроить</button><button type="button" class="small-button" data-toggle="${watch.id}">${watch.enabled ? 'Пауза' : 'Возобновить'}</button>${!watch.enabled ? '<span class="chip">На паузе</span>' : ''}</div>
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
  const mode = $('#feed-mode').value;
  const query = $('#feed-search').value.toLowerCase().trim();
  const min = Number($('#feed-min').value || 0);
  const max = Number($('#feed-max').value || Infinity);
  deals = deals.filter(d => (mode==='hidden'?d.dismissed:!d.dismissed) && d.price >= min && d.price <= max && `${d.title} ${d.description}`.toLowerCase().includes(query)
    && (mode === 'all' || mode==='hidden' || mode === 'eligible' && d.analysis?.eligible || mode === 'favorite' && d.favorite || mode === 'delivery' && d.analysis?.delivery === true || mode === 'clean' && d.analysis?.details_checked && !d.analysis.risks.length || mode === 'pending' && !d.analysis?.details_checked));
  const sort = $('#feed-sort').value;
  deals = [...deals].sort((a,b)=>sort==='price'?a.price-b.price:sort==='profit'?(b.analysis?.profit??-Infinity)-(a.analysis?.profit??-Infinity):sort==='roi'?(b.analysis?.roi??-Infinity)-(a.analysis?.roi??-Infinity):0);
  if (!deals.length) {
    list.innerHTML = '<div class="empty">Нет объявлений по выбранным условиям.<br>Новые данные появятся после облачной проверки.</div>';
    return;
  }
  list.innerHTML = deals.map((deal) => `
    <article class="deal-card">
      ${deal.image_url ? `<img class="deal-photo" src="${escapeHtml(deal.image_url)}" alt="Фото товара" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="deal-photo deal-photo-fallback">Фото не предоставлено</div>'}
      <div class="deal-body">
        <h3>${escapeHtml(deal.title)}</h3>
        <div class="deal-price">${rubles.format(deal.price)} ₽</div>
        <div class="fact-chips"><span>${deal.analysis?.details_checked ? 'Описание прочитано' : 'Ожидает проверки'}</span><span>${deal.analysis?.delivery === true ? 'Есть доставка' : deal.analysis?.delivery === false ? 'Без доставки' : 'Доставка: нет данных'}</span></div>
        <div class="${deal.analysis?.eligible?'status-good':'status-neutral'}" style="font-size:.75rem;margin:8px 0">${deal.analysis?.eligible?'Прошло фильтры радара':'Сигнал не подтверждён'}</div>
        ${deal.analysis?.profit != null ? `<div class="deal-profit"><span>${deal.analysis.profit>=0?'+':''}${rubles.format(deal.analysis.profit)} ₽</span><span>ROI ${Number(deal.analysis.roi).toFixed(1)}%</span></div>` : '<div class="deal-details">Пока недостаточно данных для прибыли</div>'}
        <div class="deal-details ${deal.analysis?.risks.length ? 'status-bad' : ''}">${deal.analysis?.risks.length ? escapeHtml(deal.analysis.risks.map(r=>r.label).join(' · ')) : escapeHtml(deal.location || 'Город не указан')}</div>
        <div class="deal-actions"><button class="small-button" type="button" data-detail="${escapeHtml(deal.external_id)}">Разбор и аналоги</button><button class="small-button ${deal.favorite?'active':''}" type="button" data-favorite="${escapeHtml(deal.external_id)}">${deal.favorite?'★':'☆'}</button><button class="small-button" type="button" data-dismiss="${escapeHtml(deal.external_id)}">${deal.dismissed?'Вернуть':'Скрыть'}</button></div>
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

async function openAnalysis(id) {
  const deal=dashboard.deals.find(d=>d.external_id===id);
  if (!deal) return;
  const a=deal.analysis;
  const line=(name,value)=>`<div class="analysis-line"><span>${escapeHtml(name)}</span><b>${escapeHtml(value)}</b></div>`;
  const money=value=>value==null?'Недостаточно данных':`${rubles.format(value)} ₽`;
  $('#deal-content').innerHTML=`<h3>${escapeHtml(deal.title)}</h3>${line('Покупка',money(deal.price))}
    ${line('Состояние по продавцу',a?.condition||deal.condition||'Не указано')}
    ${line('Доставка',a?.delivery===true?'Доступна по карточке/описанию':a?.delivery===false?'Не предусмотрена':'Не удалось определить')}
    ${line('АКБ по описанию',a?.battery!=null?`${a.battery}%`:'Не указано')}
    ${line('Описание проверено',a?.description_checked_at?new Date(a.description_checked_at).toLocaleString('ru-RU'):'Пока не проверено')}
    <h3>Расчёт перепродажи</h3>${line('Быстрая продажа, оценка',money(a?.expected))}
    ${a?.costs?Object.entries(a.costs).map(([k,v])=>line(({commission:'Комиссия',reserve:'Резерв',repair:'Ремонт',delivery:'Доставка',other:'Прочие расходы'})[k],money(v))).join(''):''}
    ${line('Потенциальная прибыль',money(a?.profit))}
    <div class="note-panel">${a?.eligible?'Прошло ваши фильтры. Проверьте товар лично.':escapeHtml(a?.reasons?.join(' · ')||'Полная проверка ещё не выполнена')}</div>
    <h3>Рынок и аналоги</h3>${line('Проверенных аналогов',a?.market.count??0)}${line('Медиана цен',money(a?.market.median))}${line('Диапазон 25–75%',`${money(a?.market.low)} — ${money(a?.market.high)}`)}
    <p>Отдельная выборка предложений по России без потолка цены покупки. Не является статистикой завершённых продаж. Состояние и комплектацию аналогов нужно проверить.</p>
    ${(a?.market.examples||[]).map(s=>`<button class="market-example small-button" type="button" data-source-url="${escapeHtml(s.url)}">${escapeHtml(s.title)} · ${money(s.price)} ↗</button>`).join('')}
    <h3>Риски по тексту</h3>${a?.risks.length?a.risks.map(r=>`<p class="status-bad">${escapeHtml(r.label)}</p><p class="risk-evidence">«${escapeHtml(r.evidence)}»</p>`).join(''):'<p>В проверенном тексте признаки не найдены либо описание ещё не проверено. Это не подтверждает исправность телефона.</p>'}
    <h3>Описание продавца</h3><p class="description">${escapeHtml(deal.description||'Полное описание пока не получено.')}</p><h3>История наблюдаемых цен</h3><div id="price-history">Загрузка…</div>`;
  $('#deal-modal').showModal();
  try { const data=await api('/api/history/'+encodeURIComponent(id)); const history=$('#price-history'); if(history)history.innerHTML=data.history.length?data.history.map(h=>line(h.checked_at+' UTC',money(h.price))).join(''):'История пока не накоплена.'; }catch { const history=$('#price-history'); if(history)history.textContent='Не удалось загрузить историю.'; }
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
    dashboard=data;
    if (data.user.first_name) $("#welcome").textContent = `${data.user.first_name}, настройте критерии — радар рассчитает маржу и пришлёт сигнал в Telegram.`;
    $("#watch-count").textContent = data.watches.filter(w=>w.enabled).length;
    $("#listing-count").textContent = data.stats.listings;
    $("#alert-count").textContent = data.stats.alerts;
    renderWatches(data.watches);
    renderDeals(data.deals || []);
    $("#source-status").textContent = data.source_connected
      ? "Источник подключён · расписание каждые 5 минут · уведомления в чат включены"
      : "Сохраните ссылку поиска Avito. Облачная проверка запускается по расписанию каждые 5 минут; результат появится на карточке фильтра.";
  } catch (error) {
    $("#watch-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const detail=event.target.closest('[data-detail]');
  if(detail) return openAnalysis(detail.dataset.detail);
  const edit=event.target.closest('[data-edit]');
  if(edit){
    const watch=dashboard.watches.find(w=>w.id===Number(edit.dataset.edit));
    const form=$('#watch-form'); form.reset();
    for(const [key,value] of Object.entries({...watch,...watch.options,watch_id:watch.id})){
      const input=form.elements.namedItem(key);
      if(input){if(input.type==='checkbox') input.checked=Boolean(value); else input.value=value??'';}
    }
    $('#watch-modal').showModal(); return;
  }
  const toggle=event.target.closest('[data-toggle]');
  if(toggle){try{const watch=dashboard.watches.find(w=>w.id===Number(toggle.dataset.toggle));await api(`/api/watches/${watch.id}`,{method:'PATCH',body:JSON.stringify({enabled:!watch.enabled})});await load();}catch(error){toast(error.message,true);} return;}
  const favorite=event.target.closest('[data-favorite]'), dismiss=event.target.closest('[data-dismiss]');
  if(favorite||dismiss){
    const id=favorite?.dataset.favorite||dismiss.dataset.dismiss;
    const deal=dashboard.deals.find(d=>d.external_id===id);
    try{await api('/api/listing-state',{method:'POST',body:JSON.stringify({external_id:id,action:favorite?'favorite':'dismissed',value:favorite?!deal.favorite:!deal.dismissed})});await load();}catch(error){toast(error.message,true);} return;
  }
  const closer = event.target.closest("[data-close]");
  if (closer) {
    closer.closest("dialog")?.close();
    return;
  }

  const opener = event.target.closest("[data-open]");
  if (opener) {
    if (!initData) return toast("Откройте приложение внутри Telegram", true);
    if(opener.dataset.open==='watch-modal') { $('#watch-form').reset(); $('#watch-form').elements.watch_id.value=''; }
    if(opener.dataset.open==='listing-modal'){
      const watches=dashboard.watches.filter(w=>w.enabled);
      if(!watches.length)return toast('Сначала создайте или включите радар',true);
      $('#manual-watch').innerHTML=watches.map(w=>`<option value="${w.id}">${escapeHtml(w.query)}</option>`).join('');
    }
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
  form.querySelectorAll('input[type="checkbox"]').forEach(input=>{body[input.name]=input.checked;});
  try {
    await api(body.watch_id?`/api/watches/${body.watch_id}`:"/api/watches", { method: body.watch_id?'PATCH':"POST", body: JSON.stringify(body) });
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
  body.detail_status='complete';
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
['feed-search','feed-mode','feed-sort','feed-min','feed-max'].forEach(id=>$('#'+id).addEventListener('input',()=>renderDeals(dashboard.deals)));
setInterval(() => { if (!document.hidden) load(); }, 60000);
