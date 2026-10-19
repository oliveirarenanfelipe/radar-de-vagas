import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/collect.mjs';
import { startServer } from '../src/page/server.mjs';
import { main } from '../bin/radar.mjs';

const filtro = { local: { ufs: ['DF'], cidades: ['Taguatinga'] }, remoto: 'brasil',
  titulo: { ligado: true, sinonimos: ['product owner'] } };
// 10 vagas inventadas: 6 passam (uma com alerta) e 4 são cortáveis em 3 motivos. As cortadas (c..)
// ordenam antes das que passam (v..) no pending, para o teto aplicado antes do filtro ser visível.
const rows = [
  ['v01', 'Analista de Processos', 'Brasília - DF', 'onsite', null],
  ['v02', 'Analista de Processos Sênior', 'Taguatinga', 'onsite', null],
  ['v03', 'Product Owner', 'Recife - PE', 'remote', null],
  ['v04', 'Product Owner', 'Remoto', 'remote', null],
  ['v05', 'Analista de Processos', 'Brasília - DF', 'hybrid', null],
  ['v06', 'Analista de Processos', 'Goiânia - GO', null, null],
  ['c07', 'Analista de Processos', 'Curitiba - PR', 'onsite', 'fora-do-local'],
  ['c08', 'Product Owner', 'Recife - PE', 'hybrid', 'fora-do-local'],
  ['c09', 'Analista de Processos', 'Lisboa, Portugal', 'remote', 'remota-fora-do-pais'],
  ['c10', 'Analista Financeiro', 'Brasília - DF', 'onsite', 'titulo-sem-termo'],
];
const jobs = rows.map(([id, title, location, workModel]) => ({
  source: 'ficticia', sourceId: id, url: `https://alfa.example/vagas/${id}`, title, company: 'Alfa Fictícia',
  location, workModel, description: `Descrição fictícia completa da vaga ${id}.`, publishedAt: null,
}));
const expectedCut = rows.filter(row => row[4]).map(row => `ficticia:${row[0]}`);

async function setup(t, search = { filtro }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-filtro-'));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => server.close()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const busca = { termos: ['analista de processos'], localidade: null, modelo: null, idadeMaximaDias: null,
    fontes: { gupy: false, linkedin: false }, empresas: { greenhouse: [], lever: [], ashby: [], inhire: [] }, ...search };
  const write = changes => writeFile(join(dataDir, 'busca.json'), JSON.stringify({ ...busca, ...changes }));
  await write({});
  // Fonte injetada com as vagas da fixture; nenhuma rede.
  const source = { name: 'ficticia', label: 'Fonte fictícia', kind: 'search', defaultEnabled: true,
    collect: async () => ({ jobs: structuredClone(jobs), errors: [] }) };
  const summary = await collect({ dataDir, sources: [source], fetch: async () => assert.fail('Rede proibida.') });
  const server = await startServer({ dataDir, port: 0 });
  servers.push(server);
  const day = async () => (await fetch(`${server.url}/api/dia`)).json();
  const page = async () => {
    const html = await (await fetch(`${server.url}/`)).text();
    return html.match(/<section id="dia"[\s\S]*?<\/section>/)?.[0] ?? '';
  };
  return { dataDir, summary, server, day, page, write };
}

test('8.1 rodada de 10: 6 mostradas, 4 cortadas com motivo, contagem por motivo e 6 + 4 = totalNovas', async t => {
  const { summary, day } = await setup(t);
  const body = await day();
  assert.equal(summary.totalNew, 10);
  assert.equal(body.mostradas.length, 6);
  assert.deepEqual(body.cortadas.map(entry => entry.id).sort(), expectedCut);
  for (const entry of body.cortadas) assert.equal(entry.motivo, rows.find(row => `ficticia:${row[0]}` === entry.id)[4]);
  assert.deepEqual(body.contagemPorMotivo, { 'fora-do-local': 2, 'remota-fora-do-pais': 1, 'titulo-sem-termo': 1 });
  assert.equal(body.mostradas.length + body.cortadas.length, body.rodada.totalNovas);
});

test('8.2 a página mostra "Cortadas pelo filtro: 4" e um <details> por motivo com título, empresa, fonte, motivo e link', async t => {
  const { page } = await setup(t);
  const day = await page();
  assert.match(day, /Cortadas pelo filtro: 4</);
  const groups = [...day.matchAll(/<details class="cut" data-motivo="([^"]+)">([\s\S]*?)<\/details>/g)];
  assert.deepEqual(groups.map(group => group[1]).sort(), ['fora-do-local', 'remota-fora-do-pais', 'titulo-sem-termo']);
  const local = groups.find(group => group[1] === 'fora-do-local')[2];
  assert.match(local, /Fora do local da busca \(2\)/);
  for (const id of ['c07', 'c08']) {
    assert.match(local, new RegExp(`<li data-id="ficticia:${id}"><a href="https://alfa\\.example/vagas/${id}"[^>]*>[^<]+</a> · Alfa Fictícia · Fonte: ficticia · Motivo: Fora do local da busca</li>`));
  }
  // Cortada não aparece entre as mostradas.
  const shown = day.slice(0, day.indexOf('Cortadas pelo filtro'));
  for (const id of expectedCut) assert.doesNotMatch(shown, new RegExp(`data-id="${id}"`));
});

test('8.3 pending pula as cortadas e avisa no stderr; --incluir-cortadas as inclui', async t => {
  const { dataDir } = await setup(t);
  const run = async args => {
    const out = [], err = [];
    assert.equal(await main(args, { dataDir, stdout: text => out.push(text), stderr: text => err.push(text) }), 0);
    return { ids: JSON.parse(out[0]).map(entry => entry.id), err: err.join('\n') };
  };
  const skipped = await run(['pending']);
  assert.equal(skipped.ids.length, 6);
  for (const id of expectedCut) assert.ok(!skipped.ids.includes(id));
  assert.match(skipped.err, /4 vagas cortadas pelo filtro ficaram fora da triagem/);
  // O teto não é gasto nas cortadas: com --limit 6 vêm exatamente as 6 que passam.
  assert.deepEqual((await run(['pending', '--limit', '6'])).ids.sort(), skipped.ids.sort());
  const all = await run(['pending', '--incluir-cortadas']);
  assert.equal(all.ids.length, 10);
  assert.doesNotMatch(all.err, /cortadas pelo filtro/);
});

test('8.4 filtro alterado no busca.json reclassifica na leitura seguinte, sem regravar o estado', async t => {
  const { dataDir, day, write } = await setup(t);
  const statePath = join(dataDir, 'estado.json');
  const before = await readFile(statePath, 'utf8');
  assert.equal((await day()).cortadas.length, 4);
  await write({ filtro: { ...filtro, titulo: { ligado: false, sinonimos: [] } } });
  const after = await day();
  assert.equal(after.mostradas.length, 7);
  assert.deepEqual(after.contagemPorMotivo, { 'fora-do-local': 2, 'remota-fora-do-pais': 1 });
  await write({ filtro: undefined });
  assert.equal((await day()).cortadas.length, 0);
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('8.5 vaga que passa com alerta do filtro mostra o alerta na linha dela', async t => {
  const { day, page } = await setup(t);
  const body = await day();
  assert.deepEqual(body.mostradas.find(entry => entry.id === 'ficticia:v06').alertas, ['modelo-nao-informado']);
  const html = await page();
  const line = html.match(/<li data-id="ficticia:v06">[\s\S]*?<\/li>/)[0];
  assert.match(line, /data-alerta="modelo-nao-informado">Alerta do filtro: modelo não informado/);
  assert.doesNotMatch(html.match(/<li data-id="ficticia:v01">[\s\S]*?<\/li>/)[0], /Alerta do filtro/);
});

test('busca.json inválido: /api/dia responde 500 em português e a página mostra o erro', async t => {
  const { dataDir, server, page } = await setup(t);
  await writeFile(join(dataDir, 'busca.json'), JSON.stringify({ termos: [], fontes: {} }));
  const response = await fetch(`${server.url}/api/dia`);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Busca inválida em busca\.json, o filtro não foi aplicado/);
  assert.match(await page(), /class="warning">Busca inválida em busca\.json/);
});
