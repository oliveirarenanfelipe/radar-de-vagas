import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/radar.mjs';
import { startServer } from '../src/page/server.mjs';
import { RETORNOS_DA_PAGINA } from '../src/page/view.mjs';
import { pastaSegura } from '../src/preparo/pacote.mjs';
import { addJobs, loadState, RETORNOS, setMark, setRetorno, setTracking, setTriage } from '../src/state.mjs';

const vaga = (source, sourceId) => ({ source, sourceId, url: `https://alfa.example/${source}/${sourceId}`,
  title: `Vaga fictícia ${sourceId}`, company: 'Alfa Fictícia', description: 'Descrição fictícia completa.', publishedAt: null });

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-retorno-'));
  const servers = [];
  t.after(async () => { await Promise.all(servers.map(server => server.close())); await rm(dataDir, { recursive: true, force: true }); });
  const options = { dataDir };
  const open = async () => { const server = await startServer({ dataDir, port: 0 }); servers.push(server); return server; };
  const run = async args => {
    const out = [], err = [];
    const code = await main(args, { dataDir, stdout: texto => out.push(texto), stderr: texto => err.push(texto) });
    return { code, tudo: [...out, ...err].join('\n') };
  };
  const tracking = async id => (await loadState(options)).jobs[id].tracking;
  return { dataDir, options, open, run, tracking };
}

const post = (server, id, body) => fetch(`${server.url}/api/jobs/${encodeURIComponent(id)}/retorno`, {
  method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('a lista de retornos da página é a mesma do estado', () => {
  assert.deepEqual(RETORNOS_DA_PAGINA, RETORNOS);
  assert.deepEqual(RETORNOS, ['Entrevista', 'Teste/Case', 'Proposta', 'Recusado', 'Sem retorno']);
});

test('19.1 retorno pelo comando e pela página, e o valor sobrevive a fechar e reabrir o servidor', async t => {
  const { options, open, run, tracking } = await setup(t);
  await addJobs([vaga('gupy', 'r1'), vaga('solides', 'r2')], options);
  for (const id of ['gupy:r1', 'solides:r2']) await setMark(id, { status: 'applied', cutReason: null }, options);
  const cmd = await run(['retorno', 'gupy:r1', 'Entrevista']);
  assert.equal(cmd.code, 0, cmd.tudo);
  assert.equal((await tracking('gupy:r1')).retorno, 'Entrevista');
  const server = await open();
  const r = await post(server, 'solides:r2', { retorno: 'Teste/Case' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tracking.retorno, 'Teste/Case');
  const html = await (await fetch(`${server.url}/`)).text();
  assert.match(html, /<option value="Teste\/Case" selected>Teste\/Case<\/option>/);
  await server.close();
  const reaberto = await open();
  const jobs = (await (await fetch(`${reaberto.url}/api/jobs`)).json()).jobs;
  assert.deepEqual(jobs.map(entry => [entry.id, entry.tracking?.retorno]).sort(), [['gupy:r1', 'Entrevista'], ['solides:r2', 'Teste/Case']]);
});

test('19.1b retorno em vaga sem acompanhamento cria o bloco "Inscrita"; com acompanhamento, preserva; track tira a marca', async t => {
  const { options, run, tracking } = await setup(t);
  await addJobs([vaga('gupy', 'b1'), vaga('gupy', 'b2')], options);
  for (const id of ['gupy:b1', 'gupy:b2']) await setMark(id, { status: 'applied', cutReason: null }, options);
  await setRetorno('gupy:b1', 'Entrevista', options);
  const criado = await tracking('gupy:b1');
  assert.deepEqual(Object.keys(criado).sort(), ['next', 'notes', 'retorno', 'retornoCriouBloco', 'stage', 'updatedAt']);
  assert.deepEqual({ ...criado, updatedAt: 'x' }, { stage: 'Inscrita', next: null, notes: '', retorno: 'Entrevista', retornoCriouBloco: true, updatedAt: 'x' });
  await setTracking('gupy:b2', { stage: 'conversa', next: 'Ligar sexta', notes: 'Nota fictícia.' }, options);
  await setRetorno('gupy:b2', 'Proposta', options);
  const preservado = await tracking('gupy:b2');
  assert.deepEqual([preservado.stage, preservado.next, preservado.notes, preservado.retorno], ['conversa', 'Ligar sexta', 'Nota fictícia.', 'Proposta']);
  assert.equal('retornoCriouBloco' in preservado, false);
  // A pessoa grava acompanhamento no bloco criado pelo retorno: ele passa a ser dela (e o retorno fica).
  assert.equal((await run(['track', 'gupy:b1', '--stage', 'entrevista marcada'])).code, 0);
  const daPessoa = await tracking('gupy:b1');
  assert.equal('retornoCriouBloco' in daPessoa, false);
  assert.equal(daPessoa.retorno, 'Entrevista');
  // Desfazer um retorno: o bloco criado só por ele volta a null; o da pessoa perde só o retorno.
  await addJobs([vaga('gupy', 'b3')], options);
  await setMark('gupy:b3', { status: 'applied', cutReason: null }, options);
  await setRetorno('gupy:b3', 'Recusado', options);
  assert.equal((await run(['retorno', 'gupy:b3', '--limpar'])).code, 0);
  assert.equal(await tracking('gupy:b3'), null);
  await setRetorno('gupy:b2', null, options);
  assert.deepEqual(Object.keys(await tracking('gupy:b2')).sort(), ['next', 'notes', 'stage', 'updatedAt']);
});

test('19.2 e 19.3 retorno só para candidatura feita, e só com valor da lista (400 na rota, 2 no comando)', async t => {
  const { options, open, run, tracking } = await setup(t);
  await addJobs([vaga('gupy', 'c1'), vaga('gupy', 'c2')], options);
  await setMark('gupy:c2', { status: 'applied', cutReason: null }, options);
  const semInscrevi = await run(['retorno', 'gupy:c1', 'Entrevista']);
  assert.equal(semInscrevi.code, 2);
  assert.match(semInscrevi.tudo, /retorno só existe para candidatura feita/);
  assert.equal(await tracking('gupy:c1'), null);
  const server = await open();
  assert.equal((await post(server, 'gupy:c1', { retorno: 'Entrevista' })).status, 400);
  for (const corpo of [{ retorno: 'Aprovado' }, { retorno: 3 }, { outro: 'x' }, []]) {
    assert.equal((await post(server, 'gupy:c2', corpo)).status, 400, JSON.stringify(corpo));
  }
  // Corpo fora do formato é recusado pela própria rota, com a mensagem dela.
  for (const corpo of [{ outro: 'x' }, { retorno: 3 }, []]) {
    assert.match((await (await post(server, 'gupy:c2', corpo)).json()).error, /Envie \{ retorno \}/, JSON.stringify(corpo));
  }
  assert.equal((await run(['retorno', 'gupy:c2', 'Aprovado'])).code, 2);
  assert.equal((await run(['retorno', 'gupy:c2'])).code, 2);
  assert.equal(await tracking('gupy:c2'), null);
  await assert.rejects(setRetorno('gupy:c2', 'Aprovado', options), /Retorno inválido/);
});

test('estado editado à mão com retorno fora da lista é recusado na leitura', async t => {
  const { dataDir, options } = await setup(t);
  await addJobs([vaga('gupy', 'g1')], options);
  await setMark('gupy:g1', { status: 'applied', cutReason: null }, options);
  await setRetorno('gupy:g1', 'Entrevista', options);
  const caminho = join(dataDir, 'estado.json');
  const disco = JSON.parse(await readFile(caminho, 'utf8'));
  disco.jobs['gupy:g1'].tracking.retorno = 'Aprovado';
  await writeFile(caminho, JSON.stringify(disco));
  await assert.rejects(loadState(options), /retorno precisa ser um de/);
});

test('19.4 estado antigo, sem retorno em vaga nenhuma, abre sem erro e continua schemaVersion 1', async t => {
  const { dataDir, options, open } = await setup(t);
  await addJobs([vaga('gupy', 'd1')], options);
  await setMark('gupy:d1', { status: 'applied', cutReason: null }, options);
  await setTracking('gupy:d1', { stage: 'conversa', next: null, notes: '' }, options);
  const disco = JSON.parse(await readFile(join(dataDir, 'estado.json'), 'utf8'));
  assert.equal(disco.schemaVersion, 1);
  assert.deepEqual(Object.keys(disco.jobs['gupy:d1'].tracking).sort(), ['next', 'notes', 'stage', 'updatedAt']);
  const server = await open();
  assert.equal((await fetch(`${server.url}/`)).status, 200);
  assert.equal((await fetch(`${server.url}/api/indicadores`)).status, 200);
});

test('19.5 indicadores por fonte, estrela e variante batem com a conta à mão', async t => {
  const { dataDir, options, open } = await setup(t);
  await addJobs([vaga('gupy', 'e1'), vaga('gupy', 'e2'), vaga('solides', 'e3'), vaga('solides', 'e4')], options);
  for (const id of ['gupy:e1', 'gupy:e2', 'solides:e3']) await setMark(id, { status: 'applied', cutReason: null }, options);
  await setTriage('gupy:e1', { fit: 5, reason: 'Fictício.', alerts: [] }, options);
  await setTriage('gupy:e2', { fit: 3, reason: 'Fictício.', alerts: [] }, options);
  await setRetorno('gupy:e1', 'Entrevista', options);
  await setRetorno('gupy:e2', 'Sem retorno', options);
  await setRetorno('solides:e3', 'Proposta', options);
  // Variante lida do pacote.json de cada candidatura; a 3ª não tem pacote.
  for (const [id, variante] of [['gupy:e1', 'variante-a'], ['gupy:e2', 'variante-b']]) {
    const pasta = pastaSegura(dataDir, id);
    await mkdir(pasta, { recursive: true });
    await writeFile(join(pasta, 'pacote.json'), JSON.stringify({ versao: 1, variante }));
  }
  const server = await open();
  const dados = await (await fetch(`${server.url}/api/indicadores`)).json();
  // Conta à mão: 3 inscritas (a 4ª vaga não tem "inscrevi"); positivas = Entrevista (e1) e Proposta (e3).
  assert.deepEqual(dados.porFonte, { gupy: { inscritas: 2, positivas: 1, taxa: 0.5 }, solides: { inscritas: 1, positivas: 1, taxa: 1 } });
  assert.deepEqual(dados.porEstrela['5'], { inscritas: 1, positivas: 1, taxa: 1 });
  assert.deepEqual(dados.porEstrela['3'], { inscritas: 1, positivas: 0, taxa: 0 });
  assert.deepEqual(dados.porEstrela['sem triagem'], { inscritas: 1, positivas: 1, taxa: 1 });
  for (const estrela of ['1', '2', '4']) assert.deepEqual(dados.porEstrela[estrela], { inscritas: 0, positivas: 0, taxa: 0 });
  assert.deepEqual(dados.porVariante, { 'variante-a': { inscritas: 1, positivas: 1, taxa: 1 },
    'variante-b': { inscritas: 1, positivas: 0, taxa: 0 }, 'sem pacote': { inscritas: 1, positivas: 1, taxa: 1 } });
  const html = await (await fetch(`${server.url}/`)).text();
  assert.match(html, /<h2>Retorno das candidaturas<\/h2>/);
  assert.match(html, /<tr><td>gupy<\/td><td>2<\/td><td>1<\/td><td>50%<\/td><\/tr>/);
  assert.match(html, /<tr><td>sem pacote<\/td><td>1<\/td><td>1<\/td><td>100%<\/td><\/tr>/);
});

test('19.6 e Desfazer: --limpar-todos sobe-desce-sobe, deixando o formato que o código anterior aceita', async t => {
  const { dataDir, options, run } = await setup(t);
  await addJobs([vaga('gupy', 'f1'), vaga('gupy', 'f2')], options);
  for (const id of ['gupy:f1', 'gupy:f2']) await setMark(id, { status: 'applied', cutReason: null }, options);
  await setTracking('gupy:f2', { stage: 'conversa', next: 'Retornar', notes: 'Nota.' }, options);
  // Sobe: estado sem retorno abre; grava retorno nos dois.
  await setRetorno('gupy:f1', 'Entrevista', options);
  await setRetorno('gupy:f2', 'Recusado', options);
  // Desce: --limpar-todos.
  const limpar = await run(['retorno', '--limpar-todos']);
  assert.equal(limpar.code, 0, limpar.tudo);
  assert.match(limpar.tudo, /Retorno removido de 2 vagas/);
  const disco = JSON.parse(await readFile(join(dataDir, 'estado.json'), 'utf8'));
  assert.equal(disco.jobs['gupy:f1'].tracking, null);
  assert.deepEqual(Object.keys(disco.jobs['gupy:f2'].tracking).sort(), ['next', 'notes', 'stage', 'updatedAt']);
  assert.deepEqual([disco.jobs['gupy:f2'].tracking.stage, disco.jobs['gupy:f2'].tracking.next, disco.jobs['gupy:f2'].tracking.notes], ['conversa', 'Retornar', 'Nota.']);
  // O bloco exato que o código anterior aceita: só os 4 campos antigos (ou null).
  for (const entry of Object.values(disco.jobs)) {
    if (entry.tracking) assert.deepEqual(Object.keys(entry.tracking).sort(), ['next', 'notes', 'stage', 'updatedAt']);
  }
  // Sobe de novo.
  await setRetorno('gupy:f1', 'Proposta', options);
  assert.equal((await loadState(options)).jobs['gupy:f1'].tracking.retorno, 'Proposta');
});
