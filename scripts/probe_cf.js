export default {
  async fetch() {
    const url = 'https://www.avito.ru/all/telefony/mobile-ASgBAgICAUSwwQ2I_Dc?cd=1&d=1&f=ASgBAgECAUSwwQ2I_DcBRcaaDBV7ImZyb20iOjAsInRvIjoxNTAwMH0&s=104';
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const html = await response.text();
    return Response.json({ status: response.status, title: html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1], cards: (html.match(/data-marker="item"/g) || []).length });
  },
};
