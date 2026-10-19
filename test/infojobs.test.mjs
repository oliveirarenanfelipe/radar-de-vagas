import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { infojobs, listUrl } from '../src/sources/infojobs.mjs';
import { validateJob } from '../src/job.mjs';
const fixture = async name => readFile(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8');
const lista = await fixture('infojobs-lista.html');
const fragmento = JSON.parse(await fixture('infojobs-fragmento.json'));
const detalhe = await fixture('infojobs-detalhe.html');
const respond = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const search = { termos: ['analista de fluxos inventados'], infojobsFiltros: [{ local: 'distrito-federal' }], fontes: { gupy: true, linkedin: false, infojobs: true } };
const LIST_URL = 'https://www.infojobs.com.br/vagas-de-emprego-analista+de+fluxos+inventados-em-distrito-federal.aspx';

// Rede falsa por tipo de endereço: listas e fragmentos saem em ordem; detalhe responde pelo `detail(url)`.
function harness({ lists = [lista], fragments = [fragmento], detail = () => detalhe, ...extra } = {}) {
  const calls = [], logs = [], queue = { lists: [...lists], fragments: [...fragments] };
  const take = (name, url) => {
    assert.ok(queue[name].length, `Chamada inesperada: ${url}`);
    const reply = queue[name].shift();
    return reply instanceof Response ? reply : respond(reply);
  };
  const ctx = { search: structuredClone(search), log: message => logs.push(message), sleep: async () => {}, ...extra, fetch: async url => {
    url = String(url);
    calls.push(url);
    if (url.includes('/GetVacancyListFragment?')) return take('fragments', url);
    if (/__\d+\.aspx$/.test(url)) { const reply = detail(url); return reply instanceof Response ? reply : respond(reply); }
    return take('lists', url);
  } };
  return { calls, logs, ctx, details: () => calls.filter(url => /__\d+\.aspx$/.test(url)) };
}

test('InfoJobs 5.1: a 1ª requisição é a lista do termo no local, e nenhuma usa ?page direto na lista', async () => {
  const h = harness();
  await infojobs.collect(h.ctx);
  assert.equal(h.calls[0], LIST_URL);
  const lists = h.calls.filter(url => new URL(url).pathname.startsWith('/vagas-de-emprego'));
  assert.deepEqual(lists, [LIST_URL]);
  assert.ok(h.calls.every(url => !new URL(url).searchParams.has('page')));
  assert.equal(listUrl('analista de fluxos inventados', { local: 'distrito-federal', homeOffice: true }),
    'https://www.infojobs.com.br/vagas-de-emprego-analista+de+fluxos+inventados-em-distrito-federal-trabalho-home-office.aspx');
  assert.equal(listUrl('analista de fluxos inventados'), 'https://www.infojobs.com.br/vagas-de-emprego-analista+de+fluxos+inventados.aspx');
});

test('InfoJobs 5.2: página 1 com 2 de 3 e fragmento com 1 dão 3 vagas válidas, 3 detalhes e 0 repetidos', async () => {
  const h = harness();
  const result = await infojobs.collect(h.ctx);
  assert.deepEqual(result.errors, []);
  assert.equal(result.jobs.length, 3);
  for (const job of result.jobs) assert.deepEqual(validateJob(job), []);
  assert.deepEqual(result.jobs.map(job => job.sourceId).sort(), ['900101', '900102', '900103']);
  assert.equal(h.details().length, 3);
  assert.equal(new Set(h.details()).size, 3);
  const fragments = h.calls.filter(url => url.includes('GetVacancyListFragment'));
  assert.deepEqual(fragments, [`https://www.infojobs.com.br/mf-publicarea/VacancyList/GetVacancyListFragment?url=${encodeURIComponent(`${LIST_URL}?page=2`)}`]);
  assert.ok(h.logs.includes('InfoJobs: página 2 (analista de fluxos inventados · distrito-federal), 0 de 1 vagas já vistas neste alvo.'));
});

test('InfoJobs 5.2: quando o total da página 1 cabe nela, não pede fragmento', async () => {
  const h = harness({ lists: [lista.replace('<span class="small text-medium"> 3</span>', '<span class="small text-medium"> 2</span>')], fragments: [] });
  const result = await infojobs.collect(h.ctx);
  assert.deepEqual(result.errors, []);
  assert.equal(result.jobs.length, 2);
  assert.equal(h.calls.length, 3);
  assert.ok(!h.calls.some(url => url.includes('GetVacancyListFragment')));
});

test('InfoJobs: total com separador de milhar continua pedindo a página seguinte', async () => {
  // "1.002" lido como decimal (1,002) pararia na página 1, que já tem 2 vagas.
  const h = harness({ lists: [lista.replace('<span class="small text-medium"> 3</span>', '<span class="small text-medium"> 1.002</span>')] });
  const result = await infojobs.collect(h.ctx);
  assert.equal(result.jobs.length, 3);
  assert.equal(h.calls.filter(url => url.includes('GetVacancyListFragment')).length, 1);
});

test('InfoJobs 5.3: fragmento que repete as vagas já vistas avisa, encerra o alvo e conta os repetidos no log', async () => {
  // Só a 2ª vaga da página 1: a página não é idêntica à anterior, mas não traz nada novo.
  const second = lista.slice(lista.indexOf('<div id="vacancy900102"'));
  const h = harness({ fragments: [{ eof: false, listFragmentHTML: `<div class="js_vacanciesGridFragment mb-16">${second}` }] });
  const result = await infojobs.collect(h.ctx);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'busca');
  assert.match(result.errors[0].message, /Paginação repetida/);
  assert.ok(h.logs.includes('InfoJobs: página 2 (analista de fluxos inventados · distrito-federal), 1 de 1 vagas já vistas neste alvo.'));
  assert.equal(h.calls.filter(url => url.includes('GetVacancyListFragment')).length, 1);
});

test('InfoJobs 5.4: HTML sem a lista e JSON com estrutura errada viram 1 erro de resposta malformada na busca', async () => {
  for (const body of ['<html>quebrado</html>', 'null', '42', '{}', JSON.stringify({ unexpected: [] })]) {
    const h = harness({ lists: [body], fragments: [] });
    const result = await infojobs.collect(h.ctx);
    assert.equal(result.jobs.length, 0, body);
    assert.equal(result.errors.length, 1, body);
    assert.equal(result.errors[0].step, 'busca');
    assert.match(result.errors[0].message, /malformada/);
  }
  const h = harness({ fragments: [{ eof: true }] });
  const result = await infojobs.collect(h.ctx);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /malformada/);
});

test('InfoJobs: lista sem resultados encerra o alvo sem erro', async () => {
  const empty = '<div id="scrollContent"><h2 class="h2">Ops! Nenhuma vaga foi encontrada com os filtros selecionados</h2></div>';
  const h = harness({ lists: [empty], fragments: [] });
  assert.deepEqual(await infojobs.collect(h.ctx), { jobs: [], errors: [], observed: [] });
  assert.equal(h.calls.length, 1);
});

test('InfoJobs 5.5: empresa oculta vira "Empresa não informada"; empresa com selo vem sem o texto do selo', async () => {
  const result = await infojobs.collect(harness().ctx);
  const byId = Object.fromEntries(result.jobs.map(job => [job.sourceId, job]));
  assert.equal(byId['900102'].company, 'Empresa não informada');
  assert.equal(byId['900101'].company, 'Alfa Fictícia Serviços');
  assert.equal(byId['900103'].company, 'Beta Inventada');
});

test('InfoJobs 5.6: link absoluto, sourceId do data-id e data de publicação só quando válida', async () => {
  const result = await infojobs.collect(harness().ctx);
  const byId = Object.fromEntries(result.jobs.map(job => [job.sourceId, job]));
  assert.equal(byId['900101'].url, 'https://www.infojobs.com.br/vaga-de-analista-fluxos-ficticios-em-distrito-federal__900101.aspx');
  assert.equal(byId['900102'].url, 'https://www.infojobs.com.br/vaga-de-analista-documentos-inventados-em-__900102.aspx');
  assert.equal(byId['900101'].publishedAt, '2026-10-05');
  assert.equal(byId['900102'].publishedAt, null);
  assert.equal(byId['900103'].publishedAt, '2026-10-14');
  const noDate = harness({ lists: [lista.replace('<div hidden class="js_date" data-value="2026/10/05 04:29:00">', '<div hidden>')] });
  const again = await infojobs.collect(noDate.ctx);
  assert.equal(again.jobs.find(job => job.sourceId === '900101').publishedAt, null);
});

test('InfoJobs: descrição inteira do detalhe, do texto da vaga ao último requisito, e campos do cabeçalho', async () => {
  const result = await infojobs.collect(harness().ctx);
  const job = result.jobs.find(item => item.sourceId === '900101');
  assert.equal(job.title, 'Analista de Fluxos Fictícios');
  assert.ok(job.description.startsWith('Analista de Fluxos Fictícios\nLocal: Brasília/DF – Home office'));
  assert.ok(job.description.endsWith('Requisito final: idioma inventado.'));
  assert.match(job.description, /Medir indicadores inventados\./);
  assert.match(job.description, /Tipo de contrato e Jornada: Efetivo – CLT - Período Integral/);
  for (const chrome of ['Sua adequação', 'Visualizar', 'Assine', 'Denunciar vaga', 'Vaga similar inventada', 'Resumo da listagem']) {
    assert.ok(!job.description.includes(chrome), chrome);
  }
  assert.equal(job.location, 'Brasília - DF');
  assert.equal(job.workModel, 'remote');
  assert.equal(job.salary, 'R$ 1.000,00 a R$ 2.000,00 (Bruto mensal)');
  assert.equal(job.employmentType, 'Efetivo – CLT - Período Integral');
});

test('InfoJobs: local vem do card; o do detalhe só entra quando o card não tem local', async () => {
  const result = await infojobs.collect(harness().ctx);
  const byId = Object.fromEntries(result.jobs.map(job => [job.sourceId, job]));
  assert.equal(byId['900103'].location, 'Taguatinga - DF');
  assert.equal(byId['900102'].location, 'Brasília - DF');
  const neither = harness({ fragments: [{ eof: true, listFragmentHTML: '<div class="js_vacanciesGridFragment"></div>' }],
    detail: () => detalhe.replace(/<div class="text-medium mb-4">\s*Bras&#xED;lia - DF[\s\S]*?<\/div>/, '') });
  const again = await infojobs.collect(neither.ctx);
  assert.equal(again.jobs.find(job => job.sourceId === '900102').location, null);
});

test('InfoJobs: título do detalhe quando existe, senão o do card', async () => {
  const withTitle = await infojobs.collect(harness().ctx);
  assert.equal(withTitle.jobs.find(job => job.sourceId === '900103').title, 'Analista de Fluxos Fictícios');
  const h = harness({ detail: () => detalhe.replace(/(js_vacancyHeaderTitle">)[^<]*/, '$1') });
  const result = await infojobs.collect(h.ctx);
  assert.equal(result.jobs.find(job => job.sourceId === '900103').title, 'Analista de Fluxos Imaginários');
});

test('InfoJobs 5.7: detalhe sem descrição vira erro de detalhe e o resumo da listagem nunca é salvo', async () => {
  for (const broken of [
    detalhe.replace(/<p class="mb-16 text-break white-space-pre-line">[\s\S]*?<\/p>/, ''),
    detalhe.replace(/(<p class="mb-16 text-break white-space-pre-line">)[\s\S]*?(<\/p>)/, '$1  $2'),
    '<html>Sem descrição</html>',
  ]) {
    const h = harness({ detail: url => url.includes('900101') ? broken : detalhe });
    const result = await infojobs.collect(h.ctx);
    assert.deepEqual(result.jobs.map(job => job.sourceId).sort(), ['900102', '900103']);
    assert.equal(result.errors.length, 1);
    assert.deepEqual({ ...result.errors[0], message: undefined }, { target: '900101', step: 'detalhe', message: undefined });
    assert.match(result.errors[0].message, /Descrição completa ausente/);
    assert.ok(result.jobs.every(job => !job.description.includes('Resumo da listagem')));
  }
});

test('InfoJobs: vaga conhecida não busca detalhe e entra em observed', async () => {
  const h = harness({ known: new Set(['900101', '900102', '900103']) });
  const result = await infojobs.collect(h.ctx);
  assert.deepEqual(result, { jobs: [], errors: [], observed: ['900101', '900102', '900103'] });
  assert.equal(h.details().length, 0);
});

for (const status of [403, 429]) {
  test(`InfoJobs: HTTP ${status} interrompe a fonte inteira, sem tentar os outros alvos`, async () => {
    const h = harness({ lists: [respond('', status)], fragments: [] });
    h.ctx.search.termos.push('outro termo');
    h.ctx.search.infojobsFiltros.push({ local: 'distrito-federal', homeOffice: true });
    const result = await infojobs.collect(h.ctx);
    assert.equal(h.calls.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, new RegExp(`bloqueio \\(HTTP ${status}\\)`));
  });
}

test('InfoJobs: erro HTTP comum num alvo não impede o filtro seguinte', async () => {
  const h = harness({ lists: [respond('', 404), lista], fragments: [fragmento] });
  h.ctx.search.infojobsFiltros = [{ local: 'distrito-federal' }, { local: 'distrito-federal', homeOffice: true }];
  const result = await infojobs.collect(h.ctx);
  assert.equal(result.jobs.length, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /HTTP 404/);
  assert.deepEqual([result.errors[0].target, result.errors[0].step], ['analista de fluxos inventados · distrito-federal', 'busca']);
  assert.equal(h.calls[1], 'https://www.infojobs.com.br/vagas-de-emprego-analista+de+fluxos+inventados-em-distrito-federal-trabalho-home-office.aspx');
});

test('InfoJobs: desligada de fábrica; campo ausente ou false não acessa a rede, só true coleta', async () => {
  assert.equal(infojobs.defaultEnabled, false);
  for (const fontes of [{ gupy: true, linkedin: false }, {}, { gupy: true, linkedin: false, infojobs: false }]) {
    const h = harness();
    h.ctx.search.fontes = fontes;
    assert.deepEqual(await infojobs.collect(h.ctx), { jobs: [], errors: [] }, JSON.stringify(fontes));
    assert.equal(h.calls.length, 0, JSON.stringify(fontes));
  }
  const off = harness();
  delete off.ctx.search;
  assert.deepEqual(await infojobs.collect(off.ctx), { jobs: [], errors: [] });
  assert.equal(off.calls.length, 0);
  const on = harness();
  assert.equal((await infojobs.collect(on.ctx)).jobs.length, 3);
});
