import { createSource, object, html, workModel, elementByClass } from '../source-utils.mjs';
// Página 1 em HTML; as seguintes só pelo fragmento (`?page=N` direto na lista devolve a página 1).
// A listagem traz só um resumo: a descrição inteira vem do detalhe de cada vaga.
const BASE = 'https://www.infojobs.com.br';
const LIST_MARKER = 'js_vacanciesGridFragment';
// Desligada de fábrica: busca.json antigo, sem fontes.infojobs, não passa a chamar uma fonte nova sem pedir.
export const infojobs = createSource({ name: 'infojobs', label: 'InfoJobs', kind: 'search', defaultEnabled: false, async run(s, term) {
  // Falha num filtro (termo + local) vira aviso desse alvo e não impede o filtro seguinte.
  for (const filter of s.ctx.search?.infojobsFiltros ?? [{}]) {
    if (s.stopped) break;
    const key = [term, filter.local, filter.homeOffice ? 'home office' : null].filter(Boolean).join(' · ');
    try { await searchInfojobs(s, term, filter, key); }
    catch (error) { if (s.ctx.signal?.aborted) throw error; s.warn(key, 'busca', error); }
  }
} });
export function listUrl(term, filter = {}) {
  const words = String(term).trim().split(/\s+/).map(encodeURIComponent).join('+');
  return `${BASE}/vagas-de-emprego-${words}${filter.local ? `-em-${filter.local}` : ''}${filter.homeOffice ? '-trabalho-home-office' : ''}.aspx`;
}
async function request(s, url, format) {
  try { return await s.request(url, undefined, format); }
  catch (error) {
    // Bloqueio não se contorna: para a fonte inteira e preserva o que já foi lido.
    if ([403, 429].includes(error.status)) {
      s.stopped = true;
      throw new Error(`InfoJobs sinalizou bloqueio (HTTP ${error.status}); fonte interrompida.`);
    }
    throw error;
  }
}
async function searchInfojobs(s, term, filter, key) {
  const url = listUrl(term, filter);
  const first = await request(s, url, 'text');
  if (!first.includes(LIST_MARKER)) {
    if (/Nenhuma vaga foi encontrada/i.test(first)) { s.listing(key, 1, 0); return; }
    throw new Error('Resposta malformada: lista de vagas do InfoJobs não reconhecida.');
  }
  const total = Number(first.match(/id="resumeVacancies">\s*<span[^>]*>\s*([\d.]+)/)?.[1]?.replaceAll('.', '')) || null;
  const ids = new Set();
  let body = first.slice(first.indexOf(LIST_MARKER)), page = 1, eof = false;
  while (!s.stopped) {
    const cards = parseCards(body);
    const repeated = cards.filter(card => ids.has(card.id)).length;
    s.listing(key, page, cards.length);
    if (page > 1) s.ctx.log?.(`InfoJobs: página ${page} (${key}), ${repeated} de ${cards.length} vagas já vistas neste alvo.`);
    if (!cards.length) break;
    if (repeated === cards.length) throw new Error('Paginação repetida; a coleta deste alvo foi interrompida.');
    for (const card of cards) {
      ids.add(card.id);
      if (s.stopped) break;
      await s.item(card.id, () => detail(s, card), card.publishedAt);
    }
    await s.flush();
    if (eof || (total !== null && ids.size >= total) || !s.page(cards.map(card => card.id), key, page)) break;
    page++;
    const fragment = object(await request(s, `${BASE}/mf-publicarea/VacancyList/GetVacancyListFragment?url=${encodeURIComponent(`${url}?page=${page}`)}`));
    if (typeof fragment.listFragmentHTML !== 'string') throw new Error('Resposta malformada: fragmento da lista do InfoJobs sem HTML.');
    body = fragment.listFragmentHTML;
    eof = fragment.eof === true;
  }
}
function parseCards(body) {
  const starts = [...body.matchAll(/<div\b[^>]*\bid="vacancy\d+"/g)].map(match => match.index);
  return starts.map((start, index) => {
    const card = body.slice(start, starts[index + 1] ?? body.length);
    const id = card.match(/\bdata-id="(\d+)"/)?.[1], href = card.match(/\bdata-href="([^"]+)"/)?.[1];
    if (!id || !href) throw new Error('Resposta malformada: vaga sem identificador ou endereço na listagem do InfoJobs.');
    const companyAt = card.indexOf('<div class="text-body">');
    const company = companyAt < 0 ? '' : line(elementByClass(card.slice(companyAt), 'text-body'));
    // Local do card ("Taguatinga - DF"), sem o trecho oculto de distância.
    const place = card.match(/<div class="mb-8">([\s\S]*?)<\/div>/)?.[1];
    return { id, url: new URL(html(href), BASE).href,
      title: line(elementByClass(card, 'js_vacancyTitle')),
      location: place ? line(place.split(/<span\b[^>]*\bhidden\b/)[0]) : '',
      company: !company || /^empresa confidencial$/i.test(company) ? 'Empresa não informada' : company,
      publishedAt: civilDate(card.match(/\bjs_date\b[^>]*\bdata-value="([^"]*)"/)?.[1]) };
  });
}
// "2026/10/05 04:29:00" vira "2026-10-05"; data impossível vira null.
function civilDate(value) {
  const day = value?.match(/^(\d{4})\/(\d{2})\/(\d{2})\b/)?.slice(1).join('-');
  return day && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : null;
}
// Texto de uma linha. As tags saem antes do `html`: o selo de empresa verificada traz atributos
// com HTML dentro (data-bs-title) e um `onclick`, que o `stripHtml` não reconhece como tag.
const line = value => html(value.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, ' ')).replace(/\s+/g, ' ').trim();
async function detail(s, card) {
  const page = await request(s, card.url, 'text');
  const panel = elementByClass(page, 'js_vacancyDataPanels');
  const start = panel.search(/<p\b[^>]*\bwhite-space-pre-line\b/);
  if (start < 0 || !html(elementByClass(panel, 'white-space-pre-line'))) throw new Error('Descrição completa ausente no detalhe do InfoJobs.');
  // Do texto da vaga em diante; sai só o botão de denúncia, que não é da vaga.
  const description = html(panel.slice(start).replace(/<form\b[\s\S]*?<\/form>/gi, ''));
  const header = page.slice(page.indexOf('id="VacancyHeader"'), page.indexOf('js_vacancyDataPanels'));
  const facts = [...header.matchAll(/<div class="text-medium mb-4">([\s\S]*?)<\/div>/g)].map(match => line(match[1].split(/<span\b[^>]*\bhidden\b/)[0]));
  const isSalary = value => /R\$|a combinar/i.test(value);
  return { source: 'infojobs', sourceId: card.id, url: card.url,
    title: line(elementByClass(page, 'js_vacancyHeaderTitle')) || card.title,
    company: card.company, description,
    // O card é mais granular que o detalhe ("Todo Brasil"); o detalhe só preenche card sem local.
    location: card.location || (facts.find(value => value && !isSalary(value)) ?? null),
    workModel: workModel(line(header.match(/<div class="text-medium small font-weight-bold mb-4">([\s\S]*?)<\/div>/)?.[1] ?? '')),
    salary: facts.find(isSalary) ?? null,
    employmentType: line(page.match(/Tipo de contrato e Jornada:\s*<\/span>([\s\S]*?)<\/p>/)?.[1] ?? '') || null,
    publishedAt: card.publishedAt };
}
