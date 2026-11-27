const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.setHeaderColor("#090b0d");
tg?.setBackgroundColor("#090b0d");

const initData = tg?.initData || "";
const rubles = new Intl.NumberFormat("ru-RU");
const $ = (selector) => document.querySelector(selector);
let dashboard = { watches: [], deals: [] };
let loadVersion = 0;
let currentPage='finds';
let tradeData={trades:[],stats:{profit:0,sold_count:0},daily:[]};

function setPage(name){
  currentPage=name;
  document.querySelectorAll('[data-page]').forEach(el=>el.hidden=el.dataset.page!==name);
  document.querySelectorAll('.bottom-nav [data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));
  $('#screen-title').textContent=({finds:'Находки',searches:'Мои поиски',trades:'Мои сделки',service:'Мой тариф'})[name];
  $('#screen-subtitle').textContent=({finds:`${dashboard.deals.length} находок в последней ленте`,searches:'Ваши условия покупки и расчёта',trades:'Покупки, расходы и результат',service:'Все функции без подписки'})[name];
  $('[data-show-filters]').hidden=name!=='finds';
  if(name==='trades')loadTrades();
}

async function loadTrades(){
  try{
    const data=await api('/api/trades');
    tradeData={trades:data.trades||[],stats:data.stats||{profit:0,sold_count:0},daily:data.daily||[]};
    const profit=Number(tradeData.stats.profit||0);
    $('#trade-profit').textContent=`${profit>0?'+':''}${rubles.format(profit)} ₽`;
    $('#trade-profit').style.color=profit<0?'#ef9b75':'var(--lime)';
    $('#trade-count').textContent=`${tradeData.stats.sold_count||0} продаж`;
    const bars=tradeData.daily.slice(-12), maximum=Math.max(1,...bars.map(b=>Math.abs(b.profit)));
    $('#trade-chart').innerHTML=bars.length?bars.map(b=>`<div class="chart-column ${b.profit>=0?'positive':'negative'}" title="${escapeHtml(b.day)}: ${b.profit} ₽" style="height:${Math.max(4,Math.abs(b.profit)/maximum*80)}px"><span>${rubles.format(b.profit)}</span></div>`).join(''):'<p class="screen-subtitle">Здесь появится график ваших продаж</p>';
    $('#trade-list').innerHTML=tradeData.trades.length?tradeData.trades.map(t=>`<article class="trade-row" data-edit-trade="${t.id}" tabindex="0"><div><h3>${escapeHtml(t.title)}</h3><p>${rubles.format(t.purchase_price)} → ${t.sale_price==null?'в наличии':rubles.format(t.sale_price)+' ₽'}</p></div><strong class="${t.net_profit!=null&&t.net_profit>=0?'status-good':'status-neutral'}">${t.net_profit==null?'В наличии':(t.net_profit>0?'+':'')+rubles.format(t.net_profit)+' ₽'}</strong></article>`).join(''):'<div class="empty">Сделок пока нет.<br>Нажмите «Я купил» в карточке или добавьте сделку вручную.</div>';
  }catch(error){$('#trade-list').innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;}
}

function openTrade(deal=null,trade=null){
  const form=$('#trade-form');form.reset();
  const today=new Date();
  const date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const fields=trade?{...trade,...trade.costs,trade_id:trade.id}:{trade_id:'',external_id:deal?.external_id||'',title:deal?.title||'',purchase_price:deal?.price||'',purchased_at:date};
  form.elements.trade_id.value='';form.elements.external_id.value='';
  for(const [key,value] of Object.entries(fields)){const input=form.elements.namedItem(key);if(input)input.value=value??'';}
  $('#trade-modal').showModal();
}

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
    <article class="deal-card" data-card="${escapeHtml(deal.external_id)}" tabindex="0" aria-label="Разбор: ${escapeHtml(deal.title)}">
      ${deal.image_url ? `<img class="deal-photo" src="${escapeHtml(deal.image_url)}" alt="Фото товара" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="deal-photo deal-photo-fallback">Фото не предоставлено</div>'}
      <div class="deal-body">
        <h3>${escapeHtml(deal.title)}</h3>
        <div class="deal-price">${rubles.format(deal.price)} ₽${deal.analysis?.market.mean?`<span class="old-price">${rubles.format(deal.analysis.market.mean)} ₽</span>`:''}</div>
        ${deal.analysis?.market.mean?`<span class="price-discount ${deal.analysis?.eligible?'':'risky'}">${deal.price<deal.analysis.market.mean?'-':'+'}${Math.abs(Math.round((deal.price/deal.analysis.market.mean-1)*100))}%</span>`:''}
        <div class="fact-chips"><span>${deal.analysis?.details_checked ? 'Описание прочитано' : 'Ожидает проверки'}</span><span>${deal.analysis?.delivery === true ? 'Есть доставка' : deal.analysis?.delivery === false ? 'Без доставки' : 'Доставка: нет данных'}</span></div>
        <div class="fact-chips"><span>${escapeHtml(deal.avito_price_label || 'Avito: нет оценки')}</span></div>
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
  const marker=a?.market?.mean?Math.max(2,Math.min(96,100*(deal.price-(a.market.low||0))/Math.max(1,(a.market.high||a.market.mean)-(a.market.low||0)))):50;
  $('#deal-content').innerHTML=`${deal.image_url?`<img class="detail-photo" src="${escapeHtml(deal.image_url)}" alt="${escapeHtml(deal.title)}" />`:''}<h3>${escapeHtml(deal.title)}</h3>${line('Покупка',money(deal.price))}
    <button class="deal-open" type="button" data-source-url="${escapeHtml(deal.url)}">Открыть оригинал на мобильном Avito ↗</button>
    ${a?.market.mean?`<div class="market-scale"><div class="scale-track"><i class="scale-dot" style="--marker:${marker}%"></i></div><div class="scale-labels"><span>Покупка: ${money(deal.price)}</span><span>Аналоги: ${money(a.market.low)}–${money(a.market.high)}</span></div></div>`:''}
    <div class="detail-summary"><div class="summary-cell"><span>Быстрая продажа, оценка</span><strong>${money(a?.expected)}</strong></div><div class="summary-cell highlight"><span>Потенциальная прибыль</span><strong>${money(a?.profit)}</strong></div></div>
    <div class="deal-actions"><button class="small-button ${deal.favorite?'active':''}" type="button" data-favorite="${escapeHtml(id)}">${deal.favorite?'★ В избранном':'☆ В избранное'}</button><button class="primary" type="button" data-buy="${escapeHtml(id)}">Я купил</button></div>
    ${line('Оценка самой площадки',deal.avito_price_label||'Avito не предоставил оценку')}
    ${Object.entries(deal.specs||{}).map(([k,v])=>line(({screen:'Экран',body:'Корпус',kit:'Комплект',manufacturer:'Производитель',model:'Модель',storage:'Память',ram:'Оперативная память',color:'Цвет',sim:'SIM-карты'})[k]||k,v)).join('')}
    ${line('Состояние по продавцу',a?.condition||deal.condition||'Не указано')}
    ${line('Доставка',a?.delivery===true?'Доступна по карточке/описанию':a?.delivery===false?'Не предусмотрена':'Не удалось определить')}
    ${line('АКБ по описанию',a?.battery!=null?`${a.battery}%`:'Не указано')}
    ${line('Описание проверено',a?.description_checked_at?new Date(a.description_checked_at).toLocaleString('ru-RU'):'Пока не проверено')}
    <h3>Расчёт перепродажи</h3>${line('Быстрая продажа, оценка',money(a?.expected))}
    ${a?.costs?Object.entries(a.costs).map(([k,v])=>line(({commission:'Комиссия',reserve:'Резерв',repair:'Ремонт',delivery:'Доставка',other:'Прочие расходы'})[k],money(v))).join(''):''}
    ${line('Потенциальная прибыль',money(a?.profit))}
    <div class="note-panel">${a?.eligible?'Прошло ваши фильтры. Проверьте товар лично.':escapeHtml(a?.reasons?.join(' · ')||'Полная проверка ещё не выполнена')}</div>
    <h3>Рынок и аналоги</h3>${line('Проверенных аналогов',a?.market.count??0)}${line('Средняя цена',money(a?.market.mean))}${line('Медиана цен',money(a?.market.median))}${line('Диапазон 25–75%',`${money(a?.market.low)} — ${money(a?.market.high)}`)}
    <p>Отдельная выборка предложений по России без потолка цены покупки. Не является статистикой завершённых продаж. Состояние и комплектацию аналогов нужно проверить.</p>
    ${(a?.market.examples||[]).map(s=>`<button class="market-example small-button" type="button" data-source-url="${escapeHtml(s.url)}">${escapeHtml(s.title)} · ${money(s.price)} ↗</button>`).join('')}
    ${a?.recommendation_search?`<p>Подсказка поиска Avito: ${escapeHtml(a.recommendation_search)}. Это диапазон рекомендации поиска, не оценка состояния данного товара.</p>`:''}
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
  const version=++loadVersion;
  if (!initData) {
    $("#watch-list").innerHTML = '<div class="empty">Откройте приложение кнопкой внутри Telegram, чтобы увидеть свои фильтры.</div>';
    $("#welcome").textContent = "Интерфейс готов. Для защищённого входа откройте его из чата с ботом.";
    $('#deal-list').innerHTML='<div class="empty">Откройте Mini App кнопкой внутри Telegram-бота для защищённого входа.</div>';
    $('#source-status').textContent='Требуется вход через Telegram';
    return;
  }
  try {
    const data = await api("/api/dashboard");
    if(version!==loadVersion)return;
    dashboard=data;
    if(currentPage!=='trades')setPage(currentPage);
    if (data.user.first_name) $("#welcome").textContent = `${data.user.first_name}, настройте критерии — радар рассчитает маржу и пришлёт сигнал в Telegram.`;
    $("#watch-count").textContent = data.watches.filter(w=>w.enabled).length;
    $("#listing-count").textContent = data.stats.listings;
    $("#alert-count").textContent = data.stats.alerts;
    renderWatches(data.watches);
    renderDeals(data.deals || []);
    const active = data.watches.filter(w=>w.enabled);
    const failed = active.filter(w=>w.scan_error);
    const checked = active.map(w=>Date.parse(w.scanned_at ? w.scanned_at.replace(' ','T').replace(/Z$/, '')+'Z' : '')).filter(Number.isFinite);
    const stale = checked.length && Date.now()-Math.min(...checked)>20*60000;
    $('#source-status').textContent = !active.length
      ? 'Создайте или включите радар со ссылкой поиска Avito.'
      : failed.length
        ? `Проверка ${failed.length} из ${active.length} радаров не удалась. Сохранённые находки доступны; свежие объявления пока не подтверждены. Подробности — в разделе «Поиски».`
        : stale
          ? 'Данные не обновлялись более 20 минут. Проверьте время последней проверки в разделе «Поиски». Расписание GitHub может задерживаться.'
          : !checked.length
            ? 'Радар ожидает первую проверку. В GitHub задан интервал 5 минут; время запуска может задерживаться.'
            : 'Последние проверки доступны в разделе «Поиски». В GitHub задан интервал 5 минут; уведомления приходят после проверки объявления и расчёта прибыли.';
  } catch (error) {
    $("#watch-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const tab=event.target.closest('[data-tab]');
  if(tab){setPage(tab.dataset.tab);return;}
  const filters=event.target.closest('[data-show-filters]');
  if(filters){$('#feed-tools').hidden=!$('#feed-tools').hidden;return;}
  const quick=event.target.closest('[data-quick]');
  if(quick){$('#feed-mode').value=quick.dataset.quick;document.querySelectorAll('[data-quick]').forEach(el=>el.classList.toggle('active',el===quick));renderDeals(dashboard.deals);return;}
  const buy=event.target.closest('[data-buy]');
  if(buy){openTrade(dashboard.deals.find(d=>d.external_id===buy.dataset.buy));return;}
  if(event.target.closest('[data-new-trade]')){openTrade();return;}
  const editTrade=event.target.closest('[data-edit-trade]');
  if(editTrade){openTrade(null,tradeData.trades.find(t=>t.id===Number(editTrade.dataset.editTrade)));return;}
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
    (favorite||dismiss).disabled=true;
    const id=favorite?.dataset.favorite||dismiss.dataset.dismiss;
    const deal=dashboard.deals.find(d=>d.external_id===id);
    try{await api('/api/listing-state',{method:'POST',body:JSON.stringify({external_id:id,action:favorite?'favorite':'dismissed',value:favorite?!deal.favorite:!deal.dismissed})});await load();}catch(error){(favorite||dismiss).disabled=false;toast(error.message,true);} return;
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
    let url = sourceLink.dataset.sourceUrl;
    try { const parsed=new URL(url); if(parsed.hostname==='avito.ru'||parsed.hostname.endsWith('.avito.ru')){parsed.hostname='m.avito.ru';url=parsed.toString();} }catch{}
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
  const card=event.target.closest('[data-card]');
  if(card&&!event.target.closest('button,a,input,select,textarea'))openAnalysis(card.dataset.card);
});
document.addEventListener('keydown',event=>{if(event.target.matches('[data-card]')&&['Enter',' '].includes(event.key)){event.preventDefault();openAnalysis(event.target.dataset.card);}});

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
$('#trade-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,body=Object.fromEntries(new FormData(form));
  try{await api(body.trade_id?`/api/trades/${body.trade_id}`:'/api/trades',{method:body.trade_id?'PATCH':'POST',body:JSON.stringify(body)});$('#trade-modal').close();if($('#deal-modal').open)$('#deal-modal').close();setPage('trades');toast('Сделка сохранена');}catch(error){toast(error.message,true);}
});
['feed-search','feed-mode','feed-sort','feed-min','feed-max'].forEach(id=>$('#'+id).addEventListener('input',()=>renderDeals(dashboard.deals)));
setInterval(() => { if (!document.hidden) load(); }, 60000);
