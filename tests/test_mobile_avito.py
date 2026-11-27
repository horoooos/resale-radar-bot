import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('mobile_avito',Path(__file__).resolve().parents[1]/'scripts/mobile_avito.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_mobile_link_preserves_encoded_search_filters():
    assert module.mobile_url('https://www.avito.ru/all/telefony?f=abc%2Bdef&s=104')=='https://m.avito.ru/all/telefony?f=abc%2Bdef&s=104'


def test_mobile_specs_and_avito_badge_from_user_example():
    result=module.parse_mobile_facts('Цена выше рыночной\nНезависимая оценка Авито\nСостояние › Хорошее\nЭкран: Без дефектов\nКорпус: Мелкие царапины\nКомплект: Коробка\nВстроенная память: 128 ГБ\nОперативная память: 4 ГБ')
    assert result['avito_price_status']=='above'
    assert result['condition']=='Хорошее'
    assert result['specs']['screen']=='Без дефектов'
    assert result['specs']['ram']=='4 ГБ'


def test_recommendation_is_not_market_valuation():
    result=module.parse_mobile_facts('Найти больше вариантов\nTECNO Spark 20 · 3,5–6 тыс. ₽\nTECNO Spark 20\nВсе телефоны TECNO')
    assert result['avito_price_status']=='unknown'
    assert result['recommendation_search']=='TECNO Spark 20 · 3,5–6 тыс. ₽'


def test_conflicting_badges_and_faq_do_not_invent_a_price_rating():
    assert module.parse_mobile_facts('Как определить, цена выше рыночной или ниже?')['avito_price_status']=='unknown'
    assert module.parse_mobile_facts('Цена выше рыночной\nЦена ниже рыночной')['avito_price_status']=='unknown'
