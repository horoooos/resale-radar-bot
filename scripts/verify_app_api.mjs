import { createHmac } from 'node:crypto';

const base=process.env.WORKER_URL.trim().replace(/\/$/,'');
const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'deployment-read-check',user:JSON.stringify({id:815803688})});
const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
const secret=createHmac('sha256','WebAppData').update(process.env.BOT_TOKEN).digest();
params.set('hash',createHmac('sha256',secret).update(check).digest('hex'));
async function get(path){
  const response=await fetch(base+path,{headers:{'X-Telegram-Init-Data':params.toString()}});
  const data=await response.json();
  if(!response.ok||!data.ok)throw new Error(`Read-only API check failed: ${path} HTTP ${response.status}`);
  return data;
}
const dashboard=await get('/api/dashboard');
const trades=await get('/api/trades');
if(!Array.isArray(dashboard.watches)||!Array.isArray(dashboard.deals)||!Array.isArray(trades.trades))throw new Error('Unexpected API response');
const analyzed=dashboard.deals.filter(d=>d.analysis);
console.log(JSON.stringify({dashboard:'ok',trades:'ok',radars:dashboard.watches.length,visible_listings:dashboard.deals.length,analyzed:analyzed.length,full_descriptions:analyzed.filter(d=>d.analysis.details_checked).length,delivery_confirmed:analyzed.filter(d=>d.analysis.delivery===true).length,avito_ratings:dashboard.deals.filter(d=>d.avito_price_status!=='unknown').length,trade_records:trades.trades.length}));
if(dashboard.deals.length)await get('/api/history/'+encodeURIComponent(dashboard.deals[0].external_id));
console.log('Owned listing history: ok. No writes performed.');
