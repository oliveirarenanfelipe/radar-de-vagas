import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/collect.mjs';
import { startServer } from '../src/page/server.mjs';
import { loadRounds } from '../src/rounds.mjs';
import { sources } from '../src/sources/index.mjs';
import { createSource } from '../src/source-utils.mjs';

const data = JSON.parse(await readFile(new URL('./fixtures/sources/responses.json', import.meta.url), 'utf8'));
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });
const source = name => sources.find(item => item.name === name);
const empty = { inhire: { tenantName: 'Constelação Fictícia', jobsPage: [] }, greenhouse: { jobs: [], meta: { total: 0 } },
  ashby: { jobs: [] }, lever: [] };
const vazia = target => ({ target, step: 'vazia', message: 'A empresa respondeu, mas não tem vagas publicadas agora.' });
const search = { termos: ['planejamento'], localidade: null, modelo: null, idadeMaximaDias: null, fontes: { gupy: false, linkedin: false },
  empresas: { greenhouse: ['aurora'], lever: ['nebulosa'], ashby: ['orbita'], inhire: ['constelacao'] } };

test('9.1 InHire com jobsPage vazio para a empresa consultada gera aviso "vazia" nominal e nenhuma vaga', async () => {
  const calls = [];
  const result = await source('inhire').collect({ search, fetch: async url => { calls.push(String(url)); return respond(empty.inhire); } });
  assert.deepEqual(result.jobs, []);
  assert.deepEqual(result.errors, [vazia('constelacao')]);
  assert.equal(calls.length, 1);
});

test('9.2 Greenhouse, Ashby e Lever vazios dão o mesmo aviso, com o nome da empresa', async () => {
  for (const name of ['greenhouse', 'ashby', 'lever']) {
    const result = await source(name).collect({ search, fetch: async () => respond(empty[name]) });
    assert.deepEqual(result.jobs, [], name);
    assert.deepEqual(result.errors, [vazia(search.empresas[name][0])], name);
  }
});

test('9.3 lista de empresas vazia: nenhuma requisição e nenhum aviso', async () => {
  for (const name of ['greenhouse', 'lever', 'ashby', 'inhire']) {
    let calls = 0;
    const result = await source(name).collect({ search, companies: [], fetch: async () => { calls++; return respond(empty[name]); } });
    assert.deepEqual(result, { jobs: [], errors: [], observed: [] }, name);
    assert.equal(calls, 0, name);
  }
});

test('aviso só para a empresa sem vaga: a que tem vaga não avisa e a que falhou fica só com a falha', async () => {
  const replies = { 'com-vaga': data.ashby, 'sem-vaga': empty.ashby };
  const result = await source('ashby').collect({ search, companies: ['com-vaga', 'sem-vaga', 'quebrada'], fetch: async url => {
    const company = new URL(String(url)).pathname.split('/').at(-1);
    return replies[company] ? respond(replies[company]) : respond({}, 404);
  } });
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(result.errors.map(error => [error.target, error.step]), [['sem-vaga', 'vazia'], ['quebrada', 'busca']]);
});

test('contrato do helper: soma a listagem de todas as páginas do alvo; sem listagem anunciada, não avisa', async () => {
  // Página 1 com vaga e página 2 vazia (paginação como a do Lever): a empresa tem vaga, não é "vazia".
  const paged = createSource({ name: 'paginada', label: 'Paginada', kind: 'company', async run(s, company) {
    s.listing(company, 1, 1);
    s.listing(company, 2, 0);
  } });
  assert.deepEqual((await paged.collect({ companies: ['alfa-ficticia'] })).errors, []);
  // Terminou sem anunciar listagem: não há prova de que a empresa respondeu, então não há aviso.
  const silent = createSource({ name: 'muda', label: 'Muda', kind: 'company', async run() {} });
  assert.deepEqual((await silent.collect({ companies: ['alfa-ficticia'] })).errors, []);
});

test('9.4 a página mostra os avisos "vazia" por empresa num bloco Avisos, separado de Falhas; a rodada não conta como erro', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-vazia-'));
  let server;
  t.after(async () => { await server?.close(); await rm(dataDir, { recursive: true, force: true }); });
  await writeFile(join(dataDir, 'busca.json'), JSON.stringify(search));
  // Greenhouse com vaga, InHire e Ashby vazias e Lever com falha HTTP; nenhuma rede real.
  const fakeFetch = async url => {
    const { host } = new URL(String(url));
    if (host === 'boards-api.greenhouse.io') return respond(data.greenhouse);
    if (host === 'api.inhire.app') return respond(empty.inhire);
    if (host === 'api.ashbyhq.com') return respond(empty.ashby);
    if (host === 'api.lever.co') return respond({}, 500);
    assert.fail(`Rede proibida: ${url}`);
  };
  await collect({ dataDir, fetch: fakeFetch });
  server = await startServer({ dataDir, port: 0 });
  const page = await (await fetch(server.url + '/')).text();
  const warnings = page.match(/<details class="source-warnings">[\s\S]*?<\/details>/)?.[0] ?? '';
  const failures = page.match(/<details class="source-errors">[\s\S]*?<\/details>/)?.[0] ?? '';
  assert.match(warnings, /Avisos: empresas sem vagas publicadas agora \(2\)/);
  assert.match(warnings, /<li>inhire · constelacao: A empresa respondeu, mas não tem vagas publicadas agora\.<\/li>/);
  assert.match(warnings, /<li>ashby · orbita: A empresa respondeu/);
  assert.match(failures, /Falhas: algumas fontes tiveram falhas na última coleta \(1\)/);
  assert.match(failures, /lever · nebulosa: A fonte respondeu com erro HTTP 500/);
  assert.doesNotMatch(failures, /constelacao|orbita/);
  assert.doesNotMatch(warnings, /nebulosa/);
  const [round] = await loadRounds({ dataDir });
  assert.deepEqual(round.porFonte.inhire, { vistas: 0, novas: 0, erros: 0 });
  assert.deepEqual(round.porFonte.lever, { vistas: 0, novas: 0, erros: 1 });
});
