"""Explicit facts from the mobile Avito page; no private API."""
import re
from urllib.parse import urlsplit, urlunsplit


def mobile_url(value):
    parsed=urlsplit(value)
    host=(parsed.hostname or '').lower()
    if parsed.scheme!='https' or not (host=='avito.ru' or host.endswith('.avito.ru')):
        raise ValueError('Нужна HTTPS-ссылка Avito')
    return urlunsplit(('https','m.avito.ru',parsed.path,parsed.query,parsed.fragment))


def parse_mobile_facts(text):
    text=text.replace('\xa0',' ').replace('\u202f',' ')
    labels={'above':'Цена выше рыночной','market':'Рыночная цена','below':'Цена ниже рыночной'}
    found=[key for key,label in labels.items() if re.search(r'(?:^|\n)\s*'+re.escape(label).replace(r'\ ',r'\s+')+r'\s*(?:\n|$)',text,re.I)]
    status=found[0] if len(found)==1 else 'unknown'
    def field(label):
        match=re.search(r'(?:^|\n)\s*'+re.escape(label)+r'\s*[:›>→]?\s*([^\n:]{1,90})',text,re.I)
        return match[1].strip() if match else ''
    condition=field('Состояние')
    if condition.lower() not in ('хорошее','удовлетворительное','отличное','новое','новый','б/у','б / у'): condition=''
    recommendation=''
    block=text.split('Найти больше вариантов',1)
    if len(block)>1:
        match=re.search(r'[^\n]{1,90}\s[·•]\s*\d[\d ,.]*\s*[–—-]\s*\d[\d ,.]*\s*(?:тыс\.)?\s*₽',block[1][:1200])
        if match: recommendation=match[0].strip()
    return {'avito_price_status':status,'avito_price_label':labels.get(status,''),'condition':condition,
      'specs':{key:value for key,value in {'screen':field('Экран'),'body':field('Корпус'),'kit':field('Комплект'),
        'manufacturer':field('Производитель'),'model':field('Модель'),'storage':field('Встроенная память'),
        'ram':field('Оперативная память'),'color':field('Цвет'),'sim':field('SIM-карты')}.items() if value},
      'recommendation_search':recommendation}
