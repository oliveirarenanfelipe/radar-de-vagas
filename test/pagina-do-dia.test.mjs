import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../src/collect.mjs';
import { loadRounds } from '../src/rounds.mjs';
import { startServer } from '../src/page/server.mjs';
import { addJobs, loadState } from '../src/state.mjs';

const responses = JSON.parse(await readFile(new URL('./fixtures/sources/responses.json', import.meta.url), 'utf8'));

// Lista da Sólides com as vagas pedidas; a sd101 é a da fixture gravada.
function listing(ids) {
  const page = structuredClone(responses.solides);
  const base = page.data[0];
  page.data = ids.map((id, i) => ({ ...base, id, title: i === 0 && id === 'sd101' ? base.title : `Analista fictício ${id}` }));
  page.count = page.data.length;
  return page;
}

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-dia-'));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => server.close()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await writeFile(join(dataDir, 'busca.json'), JSON.stringify({ termos: ['planejamento fictício'], localidade: null,
    modelo: null, idadeMaximaDias: null, fontes: { gupy: false, linkedin: false, solides: true },
    empresas: { greenhouse: [], lever: [], ashby: [], inhire: [] } }));
  const env = { ids: ['sd101'] };
  // Só a API da Sólides responde; qualquer outra URL derruba o teste (rede real proibida).
  const fetch = async url => {
    assert.match(String(url), /^https:\/\/vagas\.solides\.com\.br\/api\/vacancies\?/);
    return new Response(JSON.stringify(listing(env.ids)), { status: 200 });
  };
  const run = ids => { env.ids = ids; return collect({ dataDir, fetch }); };
  const open = async () => {
    const server = await startServer({ dataDir, port: 0 });
    servers.push(server);
    return server;
  };
  return { dataDir, run, open };
}

const json = async (server, path) => {
  const response = await fetch(server.url + path);
  return { status: response.status, body: await response.json() };
};
const page = async server => {
  const response = await fetch(server.url + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  return { html, day: html.match(/<section id="dia"[\s\S]*?<\/section>/)?.[0] ?? '' };
};

test('4.1 e 4.6 /api/dia mostra só as vagas da janela da última rodada, com a fonte de cada uma', async t => {
  const { dataDir, run, open } = await setup(t);
  await run(['sd101']);
  const second = await run(['sd101', 'sd102']);
  const server = await open();
  const { status, body } = await json(server, '/api/dia');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['rodada', 'mostradas', 'cortadas', 'contagemPorMotivo']);
  assert.deepEqual(body.rodada, (await loadRounds({ dataDir })).at(-1));
  assert.deepEqual(body.mostradas.map(entry => entry.id), ['solides:sd102']);
  assert.ok(body.mostradas.every(entry => entry.job.source === 'solides'));
  assert.deepEqual(body.cortadas, []);
  assert.deepEqual(body.contagemPorMotivo, {});
  assert.equal(body.mostradas.length + body.cortadas.length, body.rodada.totalNovas);
  assert.equal(body.rodada.totalNovas, second.totalNew);
  // O GET da tabela leva a mesma vista, para o botão Atualizar.
  assert.deepEqual((await json(server, '/api/jobs')).body.dia, body);
});

test('4.1 a janela vale nas duas pontas: vaga gravada antes do inicio ou depois do fim não entra', async t => {
  const { dataDir, run, open } = await setup(t);
  const job = id => ({ source: 'solides', sourceId: id, url: `https://vagas.solides.com.br/vaga/${id}`,
    title: `Vaga fora da rodada ${id}`, company: 'Alfa Fictícia', description: 'Descrição fictícia completa.' });
  await addJobs([job('sd900')], { dataDir });
  await run(['sd101']);
  await addJobs([job('sd901')], { dataDir });
  const { body } = await json(await open(), '/api/dia');
  assert.equal(Object.keys((await loadState({ dataDir })).jobs).length, 3);
  assert.deepEqual(body.mostradas.map(entry => entry.id), ['solides:sd101']);
});

test('4.2 a página tem a vista "Vagas do dia" com fonte por vaga e o total de novas; a tabela completa continua', async t => {
  const { run, open } = await setup(t);
  await run(['sd101']);
  await run(['sd101', 'sd102']);
  const { html, day } = await page(await open());
  assert.match(day, /<h2>Vagas do dia<\/h2>/);
  assert.match(day, /Vagas novas nesta rodada: 1</);
  assert.match(day, /Analista fictício sd102/);
  assert.match(day, /Fonte: solides/);
  assert.doesNotMatch(day, /data-id="solides:sd101"/);
  assert.doesNotMatch(day, /diverge/);
  for (const id of ['solides:sd101', 'solides:sd102']) assert.match(html, new RegExp(`<tr data-id="${id}">`));
});

test('4.3 marcação entre duas rodadas continua, sem duplicar vaga, e a vista mostra só as novas da segunda', async t => {
  const { dataDir, run, open } = await setup(t);
  await run(['sd101']);
  const server = await open();
  const marked = await fetch(`${server.url}/api/jobs/${encodeURIComponent('solides:sd101')}/mark`, {
    method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'applied', cutReason: null }),
  });
  assert.equal(marked.status, 200);
  const mark = (await loadState({ dataDir })).jobs['solides:sd101'].mark;
  await run(['sd101', 'sd102']);
  const state = await loadState({ dataDir });
  assert.deepEqual(Object.keys(state.jobs).sort(), ['solides:sd101', 'solides:sd102']);
  assert.deepEqual(state.jobs['solides:sd101'].mark, mark);
  const { body } = await json(server, '/api/dia');
  assert.deepEqual(body.mostradas.map(entry => entry.id), ['solides:sd102']);
  const { html } = await page(server);
  assert.match(html, /<tr data-id="solides:sd101">[\s\S]*?Inscrita/);
});

test('4.4 sem rodadas.json a vista diz "Nenhuma rodada registrada ainda", sem erro 500', async t => {
  const { open } = await setup(t);
  const server = await open();
  const { status, body } = await json(server, '/api/dia');
  assert.equal(status, 200);
  assert.deepEqual(body, { rodada: null, mostradas: [], cortadas: [], contagemPorMotivo: {} });
  assert.match((await page(server)).day, /Nenhuma rodada registrada ainda/);
});

test('4.5 contagem da vista diferente do registro da coleta gera aviso visível', async t => {
  const { dataDir, run, open } = await setup(t);
  await run(['sd101', 'sd102']);
  const path = join(dataDir, 'rodadas.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.rodadas.at(-1).totalNovas = 3;
  await writeFile(path, JSON.stringify(data));
  const { day } = await page(await open());
  assert.match(day, /Vagas novas nesta rodada: 3</);
  assert.match(day, /a contagem diverge do registro da coleta \(2 na vista, 3 no registro\)/);
});

test('rodadas.json corrompido: /api/dia responde 500 em português e a página mostra o erro com a tabela', async t => {
  const { dataDir, run, open } = await setup(t);
  await run(['sd101']);
  await writeFile(join(dataDir, 'rodadas.json'), '{ corrompido');
  const server = await open();
  const { status, body } = await json(server, '/api/dia');
  assert.equal(status, 500);
  assert.match(body.error, /rodadas\.json/);
  const { html, day } = await page(server);
  assert.match(day, /class="warning">Registro de rodadas inválido/);
  assert.match(html, /<tr data-id="solides:sd101">/);
});

test('/api/dia recusa Host estranho, como as outras rotas', async t => {
  const { open } = await setup(t);
  const server = await open();
  const status = await new Promise((resolve, reject) => {
    const outgoing = request(`${server.url}/api/dia`, { headers: { Host: 'intruso.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(status, 403);
});
