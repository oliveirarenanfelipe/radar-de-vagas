import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solides } from '../src/sources/solides.mjs';
import { validateSource } from '../src/sources/index.mjs';
import { validateJob } from '../src/job.mjs';
import { USER_AGENT } from '../src/network.mjs';
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/sources/${name}`, import.meta.url), 'utf8'));
const p1 = await fixture('solides-p1.json');
const p2 = await fixture('solides-p2.json');
const respond = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const search = (extra = {}) => ({ termos: ['planejamento'], localidade: null, modelo: null, idadeMaximaDias: null,
  fontes: { gupy: true, linkedin: false, solides: true }, ...extra });
// Responde pela página pedida; rede de verdade nunca é acessada.
function harness(pages, extra = {}) {
  const calls = [];
  return { calls, ctx: { search: search(extra), sleep: async () => {}, fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const reply = pages[new URL(url).searchParams.get('page')];
    assert.ok(reply !== undefined, `Chamada inesperada: ${url}`);
    return reply instanceof Response ? reply : respond(reply);
  } } };
}
const byId = (result, id) => result.jobs.find(job => job.sourceId === id);

test('Sólides: objeto da fonte segue o contrato e vem desligada de fábrica', () => {
  assert.deepEqual(validateSource(solides), []);
  assert.deepEqual(Object.keys(solides).sort(), ['collect', 'defaultEnabled', 'kind', 'label', 'name']);
  assert.equal(solides.name, 'solides');
  assert.equal(solides.kind, 'search');
  assert.equal(solides.defaultEnabled, false);
});

test('2.1 Sólides: pede page=1 e page=2 por filtro, com take=14, title e o filtro, e nada mais', async () => {
  const filtros = [{ locations: 'Cidade Imaginária - DF' }, { jobsType: 'remoto' }];
  const h = harness({ 1: p1, 2: p2 }, { solidesFiltros: filtros });
  const result = await solides.collect(h.ctx);
  const asked = h.calls.map(({ url }) => [url.origin + url.pathname, Object.fromEntries(url.searchParams)]);
  const endpoint = 'https://vagas.solides.com.br/api/vacancies';
  assert.deepEqual(asked, [
    [endpoint, { page: '1', take: '14', title: 'planejamento', locations: 'Cidade Imaginária - DF' }],
    [endpoint, { page: '2', take: '14', title: 'planejamento', locations: 'Cidade Imaginária - DF' }],
    [endpoint, { page: '1', take: '14', title: 'planejamento', jobsType: 'remoto' }],
    [endpoint, { page: '2', take: '14', title: 'planejamento', jobsType: 'remoto' }],
  ]);
  assert.ok(h.calls.every(call => call.options.headers.get('User-Agent') === USER_AGENT && call.options.signal));
  // As mesmas vagas nos dois filtros entram uma vez só.
  assert.equal(result.jobs.length, 5);
});

test('Sólides: sem solidesFiltros busca o termo sem filtro', async () => {
  const h = harness({ 1: p1, 2: p2 });
  await solides.collect(h.ctx);
  assert.deepEqual(h.calls.map(({ url }) => url.search), ['?page=1&take=14&title=planejamento', '?page=2&take=14&title=planejamento']);
});

test('Sólides: vaga completa no formato do contrato, descrição inteira e sem HTML', async () => {
  const result = await solides.collect(harness({ 1: p1, 2: p2 }).ctx);
  for (const job of result.jobs) assert.deepEqual(validateJob(job), []);
  assert.deepEqual(byId(result, '937001'), {
    source: 'solides', sourceId: '937001', url: 'https://vagas.solides.com.br/vaga/937001',
    title: 'Analista de Planejamento', company: 'Alfa Fictícia',
    description: byId(result, '937001').description, location: 'Cidade Imaginária - DF', workModel: 'onsite',
    publishedAt: '2026-10-15', employmentType: 'CLT' });
  const description = byId(result, '937001').description;
  assert.ok(description.startsWith('Vaga: Analista de Planejamento'));
  assert.ok(description.includes('Planejar cenários fictícios para a Alfa Fictícia.'));
  assert.ok(description.includes('Acompanhar indicadores de teste'));
  assert.ok(description.endsWith('Requisito final: idioma inventado.'));
  assert.doesNotMatch(description, /<|&[a-z]+;/);
  assert.equal(byId(result, '8ujFicticio').employmentType, 'PJ, Autônomo');
  assert.equal(byId(result, '937002').employmentType, null);
  // Salário só numérico na Sólides: número solto não é convertido.
  assert.ok(result.jobs.every(job => job.salary === undefined && job.applyUrl === undefined));
  // Data inválida fica null, nunca recebe a data da coleta.
  assert.equal(byId(result, '937004').publishedAt, null);
});

test('2.2 Sólides: url sempre no portal com o id, redirectLink nunca usado', async () => {
  const result = await solides.collect(harness({ 1: p1, 2: p2 }).ctx);
  assert.equal(byId(result, '937001').url, 'https://vagas.solides.com.br/vaga/937001');
  assert.equal(byId(result, '8ujFicticio').url, 'https://vagas.solides.com.br/vaga/8ujFicticio');
  assert.ok(result.jobs.every(job => !JSON.stringify(job).includes('/vacancies/')));
});

test('2.3 Sólides: empresa confidencial sem slug é coletada com o link do portal', async () => {
  const result = await solides.collect(harness({ 1: p1, 2: p2 }).ctx);
  assert.deepEqual(result.errors, []);
  const hidden = byId(result, '937003');
  assert.equal(hidden.url, 'https://vagas.solides.com.br/vaga/937003');
  assert.equal(hidden.company, 'Empresa não informada');
  assert.deepEqual(validateJob(hidden), []);
});

test('Sólides: id em formato inesperado não vira link', async () => {
  for (const id of ['alfa/../outra', '9370 01', '']) {
    const page = structuredClone(p1);
    page.totalPages = 1;
    page.data = [{ ...p1.data[0], id }];
    const result = await solides.collect(harness({ 1: page }).ctx);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.errors.map(error => [error.target, error.step]), [[id, 'detalhe']]);
  }
});

test('2.4 Sólides: modelo de trabalho e local', async () => {
  const result = await solides.collect(harness({ 1: p1, 2: p2 }).ctx);
  assert.equal(byId(result, '937004').workModel, 'remote'); // homeOffice: true vence jobType presencial
  assert.equal(byId(result, '8ujFicticio').workModel, 'remote'); // jobType remoto
  assert.equal(byId(result, '937002').workModel, 'hybrid');
  assert.equal(byId(result, '937001').workModel, 'onsite');
  assert.equal(byId(result, '937002').location, 'Vila Inventada - GO');
  assert.equal(byId(result, '8ujFicticio').location, null);
});

test('2.5 Sólides: id numérico e alfanumérico viram sourceId em texto', async () => {
  const result = await solides.collect(harness({ 1: p1, 2: p2 }).ctx);
  assert.deepEqual(result.jobs.map(job => job.sourceId).sort(), ['8ujFicticio', '937001', '937002', '937003', '937004']);
});

test('2.5 Sólides: mesmo id com duas empresas na rodada vira erro identidade e nenhuma entra', async () => {
  const second = structuredClone(p2);
  second.data[0] = { ...p1.data[0], companyName: 'Outra Fictícia', slug: 'outra-ficticia' };
  const result = await solides.collect(harness({ 1: p1, 2: second }).ctx);
  assert.equal(byId(result, '937001'), undefined);
  assert.deepEqual(result.errors.filter(error => error.step === 'identidade'),
    [{ target: '937001', step: 'identidade', message: 'O mesmo identificador apareceu com empresas diferentes nesta rodada; a vaga não foi salva.' }]);
  assert.ok(byId(result, '937004'));
  // Conhecida e ambígua também não é marcada como vista.
  const known = await solides.collect({ ...harness({ 1: p1, 2: second }).ctx, known: new Set(['937001']) });
  assert.deepEqual(known.observed, []);
  assert.equal(known.errors.filter(error => error.step === 'identidade').length, 1);
});

test('2.5 Sólides: mesmo id e mesma empresa em dois filtros não é conflito', async () => {
  const h = harness({ 1: p1, 2: p2 }, { solidesFiltros: [{ jobsType: 'remoto' }, { jobsType: 'presencial' }] });
  const result = await solides.collect(h.ctx);
  assert.ok(!result.errors.some(error => error.step === 'identidade'));
  assert.ok(byId(result, '937001'));
});

test('2.6 Sólides: página repetida interrompe com aviso e não pede a seguinte', async () => {
  const first = { ...structuredClone(p1), totalPages: 3 };
  const h = harness({ 1: first, 2: { ...structuredClone(p1), totalPages: 3, currentPage: 2 } });
  const result = await solides.collect(h.ctx);
  assert.deepEqual(h.calls.map(({ url }) => url.searchParams.get('page')), ['1', '2']);
  assert.ok(result.errors.some(error => error.step === 'busca' && /Paginação repetida/.test(error.message)));
  assert.equal(result.jobs.length, 3);
});

test('2.6 Sólides: data vazia encerra o alvo mesmo com totalPages maior', async () => {
  const h = harness({ 1: { totalPages: 5, currentPage: 1, count: 0, data: [] } });
  const result = await solides.collect(h.ctx);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result, { jobs: [], errors: [], observed: [] });
});

test('Sólides: falha num filtro não derruba o filtro seguinte', async () => {
  let call = 0;
  const ctx = { search: search({ solidesFiltros: [{ jobsType: 'remoto' }, { jobsType: 'presencial' }] }), fetch: async url => {
    call++;
    if (new URL(url).searchParams.get('jobsType') === 'remoto') return respond({}, 500);
    return respond(new URL(url).searchParams.get('page') === '1' ? p1 : p2);
  } };
  const result = await solides.collect(ctx);
  assert.equal(call, 3);
  assert.equal(result.jobs.length, 5);
  assert.ok(result.errors.some(error => error.target === 'planejamento · remoto' && error.step === 'busca' && /HTTP 500/.test(error.message)));
});

test('Sólides: resposta sem totalPages vira aviso de resposta malformada', async () => {
  const result = await solides.collect(harness({ 1: { data: p1.data } }).ctx);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /malformada/);
});

test('2.7 Sólides: descrição vazia vira erro detalhe, sem resumo no lugar', async () => {
  for (const description of ['', '<p> </p>', null]) {
    const page = structuredClone(p1);
    page.totalPages = 1;
    page.data = [{ ...p1.data[0], description }];
    const result = await solides.collect(harness({ 1: page }).ctx);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.errors, [{ target: '937001', step: 'detalhe', message: 'Descrição ausente na listagem da vaga.' }]);
  }
});

test('2.8 Sólides: vaga conhecida vai para observed e não é construída', async () => {
  // A conhecida tem descrição vazia: se fosse construída, apareceria erro de detalhe.
  const page = structuredClone(p1);
  page.data[0].description = '';
  const result = await solides.collect({ ...harness({ 1: page, 2: p2 }).ctx, known: new Set(['937001', '937003']) });
  assert.deepEqual(result.observed.sort(), ['937001', '937003']);
  assert.equal(byId(result, '937001'), undefined);
  assert.deepEqual(result.errors, []);
  assert.equal(result.jobs.length, 3);
});

test('Sólides: campo ausente ou false não acessa a rede; só fontes.solides true coleta', async () => {
  for (const fontes of [{ gupy: true, linkedin: false }, {}, undefined, { gupy: true, linkedin: false, solides: false }]) {
    let calls = 0;
    const config = fontes === undefined ? undefined : search({ fontes });
    const result = await solides.collect({ search: config, fetch: async () => { calls++; throw new Error(); } });
    assert.deepEqual(result, { jobs: [], errors: [] }, JSON.stringify(fontes));
    assert.equal(calls, 0, JSON.stringify(fontes));
  }
  const h = harness({ 1: p1, 2: p2 }, { fontes: { gupy: false, linkedin: false, solides: true } });
  assert.ok((await solides.collect(h.ctx)).jobs.length > 0);
  assert.ok(h.calls.length > 0);
});

test('Sólides: idade máxima descarta pela data da listagem e mantém data inválida', async () => {
  // Fixtures têm datas passadas: com 0 dias, só a vaga de data inválida sobrevive.
  const result = await solides.collect(harness({ 1: p1, 2: p2 }, { idadeMaximaDias: 0 }).ctx);
  assert.deepEqual(result.jobs.map(job => job.sourceId), ['937004']);
  assert.deepEqual(result.errors, []);
});
