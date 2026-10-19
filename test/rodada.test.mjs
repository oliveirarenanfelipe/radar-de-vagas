import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, COLLECT_LOCKED } from '../src/collect.mjs';
import { loadRounds, MAX_ROUNDS } from '../src/rounds.mjs';
import { scheduledRun } from '../src/scheduled-run.mjs';
import { sources } from '../src/sources/index.mjs';
import { loadState } from '../src/state.mjs';
import { main } from '../bin/radar.mjs';

const responses = JSON.parse(await readFile(new URL('./fixtures/sources/responses.json', import.meta.url), 'utf8'));
const solides = sources.find(source => source.name === 'solides');

// Lista da Sólides com N vagas inventadas; a primeira é a da fixture gravada.
function listing(count = 1) {
  const page = structuredClone(responses.solides);
  for (let i = 2; i <= count; i++) page.data.push({ ...page.data[0], id: `sd10${i}`, title: `Analista fictício ${i}` });
  page.count = page.data.length;
  return page;
}

async function setup(t, { count = 1 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-rodada-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'busca.json'), JSON.stringify({ termos: ['planejamento fictício'], localidade: null,
    modelo: null, idadeMaximaDias: null, fontes: { gupy: false, linkedin: false, solides: true },
    empresas: { greenhouse: [], lever: [], ashby: [], inhire: [] } }));
  const calls = [];
  // Só a API da Sólides responde; qualquer outra URL derruba o teste (rede real proibida).
  const fetch = async url => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/vagas\.solides\.com\.br\/api\/vacancies\?/);
    return new Response(JSON.stringify(listing(count)), { status: 200 });
  };
  return { dataDir, fetch, calls };
}

const round = (inicio, extra = {}) => ({ inicio, fim: inicio, interrompida: false,
  porFonte: { solides: { vistas: 1, novas: 0, erros: 0 } }, totalNovas: 0, ...extra });

test('3.2 a Sólides registrada chega ao estado e a rodada registra totalNovas igual ao resumo', async t => {
  const options = await setup(t, { count: 2 });
  const summary = await collect(options);
  assert.equal(summary.totalNew, 2);
  const state = await loadState(options);
  assert.deepEqual(Object.keys(state.jobs).sort(), ['solides:sd101', 'solides:sd102']);
  const rounds = await loadRounds(options);
  assert.equal(rounds.length, 1);
  const [last] = rounds;
  assert.deepEqual(Object.keys(last), ['inicio', 'fim', 'interrompida', 'porFonte', 'totalNovas']);
  assert.equal(last.interrompida, false);
  assert.deepEqual(last.porFonte, { solides: { vistas: 2, novas: 2, erros: 0 } });
  assert.equal(last.totalNovas, summary.totalNew);
  // A janela da rodada contém o firstSeenAt de cada vaga nova: é o que a página do dia usa.
  for (const entry of Object.values(state.jobs)) {
    assert.ok(last.inicio <= entry.seen.firstSeenAt && entry.seen.firstSeenAt <= last.fim);
  }
  const second = await collect(options);
  assert.equal(second.totalNew, 0);
  const after = await loadRounds(options);
  assert.equal(after.length, 2);
  assert.deepEqual(after[1].porFonte, { solides: { vistas: 2, novas: 0, erros: 0 } });
  assert.equal(after[1].totalNovas, 0);
  assert.ok(after[0].fim <= after[1].inicio);
  assert.deepEqual((await readdir(options.dataDir)).sort(), ['busca.json', 'estado.json', 'rodadas.json']);
});

test('busca.json antigo, sem fontes.solides, não chama a Sólides; com true, coleta', async t => {
  const options = await setup(t);
  const path = join(options.dataDir, 'busca.json');
  const search = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...search, fontes: { gupy: false, linkedin: false } }));
  const summary = await collect(options);
  assert.deepEqual(summary.sources, []);
  assert.deepEqual(options.calls, []);
  await writeFile(path, JSON.stringify({ ...search, fontes: { gupy: false, linkedin: false, solides: true } }));
  assert.equal((await collect(options)).sources[0].source, 'solides');
  assert.ok(options.calls.length > 0);
});

test('3.3 interrupção no meio grava a rodada como interrompida, com a fonte concluída', async t => {
  const options = await setup(t);
  const controller = new AbortController();
  const interrupts = { name: 'interrompe', label: 'Fonte que interrompe', kind: 'search', defaultEnabled: true,
    collect: async () => { controller.abort(); return new Promise(() => {}); } };
  const summary = await collect({ ...options, sources: [solides, interrupts], signal: controller.signal });
  assert.match(summary.warnings.join('\n'), /Coleta interrompida/);
  const [last] = await loadRounds(options);
  assert.equal(last.interrompida, true);
  assert.deepEqual(last.porFonte, { solides: { vistas: 1, novas: 1, erros: 0 }, interrompe: { vistas: 0, novas: 0, erros: 1 } });
  assert.equal(last.totalNovas, 1);
  assert.ok((await loadState(options)).jobs['solides:sd101']);
  await assert.rejects(stat(join(options.dataDir, 'coleta.lock')), { code: 'ENOENT' });
});

test('3.4 com 50 rodadas gravadas, a 51ª descarta a mais antiga', async t => {
  const options = await setup(t);
  const old = Array.from({ length: MAX_ROUNDS }, (_, i) => round(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
  await writeFile(join(options.dataDir, 'rodadas.json'), JSON.stringify({ schemaVersion: 1, rodadas: old }));
  await collect(options);
  const rounds = await loadRounds(options);
  assert.equal(MAX_ROUNDS, 50);
  assert.equal(rounds.length, 50);
  assert.deepEqual(rounds.slice(0, 49), old.slice(1));
  assert.equal(rounds[49].totalNovas, 1);
});

test('3.5 rodadas.json corrompido: o estado é gravado, a coleta falha em português e o arquivo fica intacto', async t => {
  const options = await setup(t);
  const path = join(options.dataDir, 'rodadas.json');
  for (const content of ['{ corrompido', JSON.stringify({ schemaVersion: 1, rodadas: [{ inicio: 'ontem' }] })]) {
    await writeFile(path, content);
    await assert.rejects(collect(options), /rodadas\.json.*preservado/);
    assert.equal(await readFile(path, 'utf8'), content);
    assert.ok((await loadState(options)).jobs['solides:sd101']);
    await assert.rejects(stat(join(options.dataDir, 'coleta.lock')), { code: 'ENOENT' });
  }
  const stderr = [];
  assert.equal(await main(['collect'], { collect: ctx => collect({ ...options, ...ctx }), stdout: () => {},
    stderr: text => stderr.push(text) }), 1);
  assert.match(stderr.join('\n'), /Não foi possível coletar.*rodadas\.json/);
});

test('3.6 coleta.lock recente barra a coleta com 75 sem tocar estado, rodadas nem rede', async t => {
  const options = await setup(t);
  const lock = join(options.dataDir, 'coleta.lock');
  const rounds = JSON.stringify({ schemaVersion: 1, rodadas: [round('2026-01-01T00:00:00.000Z')] });
  await writeFile(join(options.dataDir, 'rodadas.json'), rounds);
  for (const content of ['', String(process.pid)]) {
    await writeFile(lock, content);
    await assert.rejects(collect(options), error => error.exitCode === COLLECT_LOCKED && /outra coleta em andamento/.test(error.message));
    const stderr = [];
    assert.equal(await main(['collect'], { collect: ctx => collect({ ...options, ...ctx }), stdout: () => {},
      stderr: text => stderr.push(text) }), 75);
    assert.match(stderr.join('\n'), /outra coleta em andamento/);
    assert.equal(await readFile(lock, 'utf8'), content);
  }
  assert.equal(COLLECT_LOCKED, 75);
  assert.deepEqual(options.calls, []);
  assert.equal(await readFile(join(options.dataDir, 'rodadas.json'), 'utf8'), rounds);
  assert.deepEqual((await readdir(options.dataDir)).sort(), ['busca.json', 'coleta.lock', 'rodadas.json']);
});

test('3.7 PID vivo antigo continua barrando; PID morto é recuperado e a coleta roda', async t => {
  const options = await setup(t);
  const lock = join(options.dataDir, 'coleta.lock');
  const old = new Date(Date.now() - 86400000);
  await writeFile(lock, String(process.pid));
  await utimes(lock, old, old);
  await assert.rejects(collect(options), error => error.exitCode === 75);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'close');
  await writeFile(lock, String(child.pid));
  await utimes(lock, old, old);
  assert.equal((await collect(options)).totalNew, 1);
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('3.8 a agenda pula coleta e triagem quando a coleta devolve 75, e sai com zero', async t => {
  const options = await setup(t);
  const calls = [];
  assert.equal(await scheduledRun(options.dataDir, { run: async args => { calls.push(args[0]); return 75; } }), 0);
  assert.deepEqual(calls, ['collect']);
  let log = await readFile(join(options.dataDir, 'agendamento.log'), 'utf8');
  assert.match(log, /Coleta manual em andamento; rodada agendada pulada/);
  assert.doesNotMatch(log, /Triagem/);
  // Com a coleta real: a coleta manual segura coleta.lock, a agendada não coleta nem consulta a rede.
  const lock = join(options.dataDir, 'coleta.lock');
  await writeFile(lock, String(process.pid));
  assert.equal(await scheduledRun(options.dataDir), 0);
  log = await readFile(join(options.dataDir, 'agendamento.log'), 'utf8');
  assert.match(log, /Coleta encerrada com código 75\.[\s\S]*Coleta manual em andamento; rodada agendada pulada/);
  assert.doesNotMatch(log, /Triagem/);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  assert.deepEqual(options.calls, []);
  await assert.rejects(stat(join(options.dataDir, 'rodadas.json')), { code: 'ENOENT' });
  // Outro código diferente de zero continua sendo falha.
  await rm(lock);
  assert.equal(await scheduledRun(options.dataDir, { run: async args => args[0] === 'collect' ? 1 : 0 }), 1);
});
