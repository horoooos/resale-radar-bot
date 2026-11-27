"""Browser-level regression checks using synthetic data, never Telegram credentials."""
import functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import re
from pathlib import Path
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
server=ThreadingHTTPServer(('127.0.0.1',8765),functools.partial(SimpleHTTPRequestHandler,directory=str(root/'worker/public')))
threading.Thread(target=server.serve_forever,daemon=True).start()
fixture={'ok':True,'user':{'first_name':'Тест'},'source_connected':True,'stats':{'listings':2,'alerts':0},
 'watches':[{'id':7,'enabled':1,'query':'Тестовый радар','source_url':'https://www.avito.ru/all/telefony','max_buy_price':15000,'min_profit':2000,'min_roi':15,'expected_sale_price':None,'options':{'require_details':True,'exclude_defects':True,'delivery_only':False}}],
 'deals':[{'external_id':'a','title':'iPhone 11, 128 ГБ','price':10000,'url':'https://www.avito.ru/example','description':'Б/у. Полностью исправный телефон.','image_url':'','favorite':0,'dismissed':0,'analysis':None},
          {'external_id':'b','title':'iPhone 13, 128 ГБ','price':14000,'url':'https://www.avito.ru/example2','description':'Телефон продавца <script>window.pwned=true</script>','image_url':'','favorite':0,'dismissed':0,'analysis':None}]}
calls=[]
trade_fixture=[]
def route_api(route):
    request=route.request
    path=urlsplit(request.url).path
    body=request.post_data_json if request.method in ('POST','PATCH') else None
    calls.append((request.method,path,body))
    if path=='/api/listing-state':
        item=next(d for d in fixture['deals'] if d['external_id']==body['external_id'])
        item[body['action']]=int(body['value'])
    if path=='/api/trades' and request.method=='POST':
        costs={k:int(body[k] or 0) for k in ('repair','delivery','commission','other')}
        trade_fixture.append({'id':1,'title':body['title'],'purchase_price':int(body['purchase_price']),'sale_price':int(body['sale_price']),'purchased_at':body['purchased_at'],'sold_at':body['sold_at'],'net_profit':int(body['sale_price'])-int(body['purchase_price'])-sum(costs.values()),'costs':costs})
    response=fixture if path=='/api/dashboard' else {'ok':True,'history':[{'price':14000,'checked_at':'2026-11-27 10:00:00'}]} if path.startswith('/api/history/') else {'ok':True,'trades':trade_fixture,'stats':{'profit':sum(t['net_profit'] for t in trade_fixture),'sold_count':len(trade_fixture)},'daily':[]} if path=='/api/trades' and request.method=='GET' else {'ok':True}
    route.fulfill(status=200,content_type='application/json',body=json.dumps(response))

with sync_playwright() as pw:
    browser=pw.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/api/**',route_api)
    page.route('https://telegram.org/**',lambda route:route.abort())
    page.add_init_script("window.Telegram={WebApp:{initData:'test-fixture',ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){}}}")
    page.goto('http://127.0.0.1:8765/')
    page.locator('.bottom-nav [data-tab=searches]').click()
    page.get_by_role('button',name='Настроить',exact=True).click()
    assert page.locator('[name=watch_id]').first.input_value()=='7'
    page.locator('[name=delivery_only]').check()
    page.get_by_role('button',name='Запустить радар',exact=True).click()
    page.wait_for_timeout(100)
    assert any(method=='PATCH' and path=='/api/watches/7' and body['delivery_only'] is True for method,path,body in calls)
    page.get_by_role('button',name='Создать фильтр',exact=True).click()
    assert page.locator('#watch-form [name=watch_id]').input_value()==''
    page.locator('#watch-modal [data-close]').click()
    assert not page.locator('#watch-modal').is_visible()
    page.locator('.bottom-nav [data-tab=finds]').click()
    page.get_by_role('button',name='Фильтры находок').click()
    page.locator('[data-favorite=a]').click()
    expect(page.locator('[data-favorite=a]')).to_have_class(re.compile('active'))
    page.locator('#feed-mode').select_option('favorite')
    expect(page.locator('.deal-card')).to_have_count(1)
    page.locator('[data-dismiss=a]').click()
    expect(page.locator('.deal-card')).to_have_count(0)
    page.locator('#feed-mode').select_option('hidden')
    expect(page.locator('.deal-card')).to_have_count(1)
    page.locator('[data-dismiss=a]').click()
    expect(page.locator('.deal-card')).to_have_count(0)
    page.locator('#feed-mode').select_option('all')
    page.locator('#feed-min').fill('12000')
    assert page.locator('.deal-card').count()==1
    page.locator('.deal-card h3').click()
    expect(page.locator('#deal-modal')).to_be_visible()
    assert '<script>' in page.locator('#deal-content').inner_text()
    assert page.evaluate('window.pwned') is None
    page.locator('#deal-modal [data-close]').click()
    page.locator('#feed-min').fill('')
    page.get_by_role('button',name='Фильтры находок').click()
    page.set_viewport_size({'width':390,'height':844})
    page.wait_for_timeout(200)
    for tab in ('finds','searches','trades','service'):
        expect(page.locator(f'.bottom-nav [data-tab={tab}]')).to_be_in_viewport()
    print('Mobile navigation:',page.locator('.bottom-nav').evaluate("el=>({box:el.getBoundingClientRect().toJSON(),text:el.innerText,children:[...el.children].map(c=>({box:c.getBoundingClientRect().toJSON(),display:getComputedStyle(c).display,visibility:getComputedStyle(c).visibility,color:getComputedStyle(c).color}))})"))
    assert page.evaluate('document.documentElement.scrollWidth')<=390
    Path('ui-artifacts').mkdir(exist_ok=True)
    page.screenshot(path='ui-artifacts/workbench-mobile.png',full_page=True)
    page.locator('.bottom-nav [data-tab=searches]').click()
    page.get_by_role('button',name='Создать фильтр',exact=True).click()
    page.locator('#watch-modal').evaluate('el=>el.scrollTop=el.scrollHeight/2')
    page.screenshot(path='ui-artifacts/radar-settings-mobile.png')
    page.locator('#watch-modal [data-close]').click()
    page.locator('.bottom-nav [data-tab=trades]').click()
    page.locator('[data-new-trade]').click()
    form=page.locator('#trade-form')
    for name,value in {'title':'Тестовая покупка','purchase_price':'10000','sale_price':'15000','purchased_at':'2026-11-20','sold_at':'2026-11-27','repair':'1000','delivery':'200','commission':'300'}.items():
        form.locator(f'[name={name}]').fill(value)
    form.get_by_role('button',name='Сохранить сделку').click()
    expect(page.locator('#trade-profit')).to_have_text(re.compile(r'\+3\s500\s₽'))
    page.screenshot(path='ui-artifacts/trades-mobile.png')
    page.locator('.bottom-nav [data-tab=service]').click()
    expect(page.locator('.plan-card')).to_contain_text('0 ₽')
    page.screenshot(path='ui-artifacts/service-mobile.png')
    assert not errors,errors
    browser.close()
server.shutdown()
print('UI checks passed: radar editing, close buttons, favorites, hide/restore, price filter, safe descriptions, mobile layout.')
