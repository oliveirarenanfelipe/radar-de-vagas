import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDataDir, loadSearch, validateSearch } from '../src/data-dir.mjs';
import { workModel } from '../src/source-utils.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'radar-contrato-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { dataDir: join(root, 'dados') };
  const example = await loadSearch(options);
  const path = join(options.dataDir, 'busca.json');
  // Grava a busca como a pessoa gravaria e lê pelo caminho real da coleta.
  const load = async search => {
    await writeFile(path, `${JSON.stringify(search, null, 2)}\n`);
    return loadSearch(options);
  };
  return { options, example, path, load };
}

const problemsOf = (search, field) => validateSearch(search).filter(problem => problem.includes(field));

test('1.1 a busca de exemplo do upstream, sem campos novos, continua válida', async t => {
  const { example, load } = await setup(t);
  for (const key of ['solidesFiltros', 'infojobsFiltros', 'filtro']) assert.equal(key in example, false);
  assert.deepEqual(Object.keys(example.fontes), ['gupy', 'linkedin']);
  assert.deepEqual(validateSearch(example), []);
  assert.deepEqual(await load(example), example);
});

test('1.2 fontes aceita solides e infojobs opcionais, só booleanos', async t => {
  const { example, load, path, options } = await setup(t);
  const search = { ...example, fontes: { gupy: true, linkedin: false, solides: true, infojobs: false } };
  assert.deepEqual(await load(search), search);
  assert.deepEqual(validateSearch({ ...example, fontes: { gupy: true, linkedin: false, infojobs: true } }), []);
  const invalid = { ...example, fontes: { gupy: true, linkedin: false, solides: 'sim', infojobs: false } };
  const problems = validateSearch(invalid);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"fontes" precisa conter/);
  for (const fontes of [{ gupy: true, linkedin: false, infojobs: null }, { gupy: true, solides: true }, { gupy: true, linkedin: false, catho: true }]) {
    assert.equal(problemsOf({ ...example, fontes }, '"fontes"').length, 1, JSON.stringify(fontes));
  }
  await writeFile(path, JSON.stringify(invalid));
  await assert.rejects(loadSearch(options), /Busca inválida.*"fontes".*preservado/);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(invalid));
});

test('1.3 solidesFiltros aceita só locations, jobsType, seniorities e contractsType em texto', async t => {
  const { example, load } = await setup(t);
  const search = { ...example, solidesFiltros: [{ locations: 'Cidade Fictícia - DF' }, { jobsType: 'remoto' },
    { seniorities: 'pleno', contractsType: 'clt' }] };
  assert.deepEqual(await load(search), search);
  for (const solidesFiltros of [[], [{}], [{ local: 'DF' }], [{ locations: '' }], [{ jobsType: '  ' }],
    [{ jobsType: true }], [{ locations: 'Cidade Fictícia - DF' }, { estado: 'DF' }], 'remoto', [null], [['jobsType']]]) {
    assert.equal(problemsOf({ ...example, solidesFiltros }, '"solidesFiltros"').length, 1, JSON.stringify(solidesFiltros));
  }
});

test('1.4 infojobsFiltros aceita local em minúsculas com hífen e homeOffice booleano', async t => {
  const { example, load } = await setup(t);
  const search = { ...example, infojobsFiltros: [{ local: 'distrito-federal' }, { local: 'distrito-federal', homeOffice: true }] };
  assert.deepEqual(await load(search), search);
  for (const infojobsFiltros of [[], [{}], [{ local: 'distrito federal' }], [{ local: 'Distrito-Federal' }],
    [{ local: '' }], [{ local: '-df' }], [{ local: 'distrito-federal', homeOffice: 'sim' }],
    [{ local: 'distrito-federal', cidade: 'x' }], { local: 'distrito-federal' }]) {
    assert.equal(problemsOf({ ...example, infojobsFiltros }, '"infojobsFiltros"').length, 1, JSON.stringify(infojobsFiltros));
  }
});

test('1.5 filtro aceita local, remoto e título e recusa UF, remoto ou sinônimo inválidos', async t => {
  const { example, load } = await setup(t);
  const filtro = { local: { ufs: ['DF'], cidades: ['Cidade Fictícia', 'Vila Inventada'] }, remoto: 'brasil',
    titulo: { ligado: true, sinonimos: ['analista de processos fictícios'] } };
  const search = { ...example, filtro };
  assert.deepEqual(await load(search), search);
  for (const remoto of ['brasil', 'qualquer-pais', 'nao']) assert.deepEqual(validateSearch({ ...example, filtro: { remoto } }), []);
  assert.deepEqual(validateSearch({ ...example, filtro: {} }), []);
  for (const [field, broken] of [
    ['"filtro.local.ufs"', { ...filtro, local: { ufs: ['XX'] } }],
    ['"filtro.local.ufs"', { ...filtro, local: { ufs: ['df'] } }],
    ['"filtro.local.ufs"', { ...filtro, local: { ufs: 'DF' } }],
    ['"filtro.local.cidades"', { ...filtro, local: { ufs: ['DF'], cidades: [''] } }],
    ['"filtro.local"', { ...filtro, local: { estados: ['DF'] } }],
    ['"filtro.remoto"', { ...filtro, remoto: 'sim' }],
    ['"filtro.remoto"', { ...filtro, remoto: 'Brasil' }],
    ['"filtro.titulo.sinonimos"', { ...filtro, titulo: { ligado: true, sinonimos: [''] } }],
    ['"filtro.titulo.sinonimos"', { ...filtro, titulo: { ligado: true, sinonimos: ['  '] } }],
    ['"filtro.titulo.ligado"', { ...filtro, titulo: { ligado: 'sim', sinonimos: [] } }],
    ['"filtro.titulo"', { ...filtro, titulo: { ligado: true, extra: 1 } }],
    ['"filtro"', { ...filtro, cargo: 'x' }],
    ['"filtro"', ['DF']],
  ]) {
    assert.equal(problemsOf({ ...example, filtro: broken }, field).length, 1, JSON.stringify(broken));
  }
});

test('1.5 as 27 UFs são aceitas e nenhuma outra sigla', async t => {
  const { example } = await setup(t);
  const all = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR',
    'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
  assert.equal(new Set(all).size, 27);
  assert.deepEqual(validateSearch({ ...example, filtro: { local: { ufs: all, cidades: [] } } }), []);
  for (const uf of ['BR', 'GB', 'FN', '']) {
    assert.equal(problemsOf({ ...example, filtro: { local: { ufs: [uf] } } }, '"filtro.local.ufs"').length, 1, uf);
  }
});

test('1.6 workModel normaliza termos em português sem acento e sem caixa', () => {
  assert.deepEqual(['remoto', 'Home Office', 'híbrido', 'hibrido', 'presencial', 'on-site', 'xyz'].map(workModel),
    ['remote', 'remote', 'hybrid', 'hybrid', 'onsite', 'onsite', null]);
  assert.deepEqual(['home-office', 'homeoffice', '100% Remoto', '  HÍBRIDO ', 'PRESENCIAL', 'Home   Office'].map(workModel),
    ['remote', 'remote', 'remote', 'hybrid', 'onsite', 'remote']);
});

test('1.6 workModel mantém o resultado dos valores que as fontes já entregavam', () => {
  assert.deepEqual(['remote', 'hybrid', 'on-site', 'onsite', 'Remote', ' ONSITE '].map(workModel),
    ['remote', 'hybrid', 'onsite', 'onsite', 'remote', 'onsite']);
  for (const value of [null, undefined, '', 42, {}, 'constructor', 'toString', '__proto__', 'remota']) {
    assert.equal(workModel(value), null, String(value));
  }
});

test('busca com campos novos inválidos é recusada pela leitura real e preserva o arquivo', async t => {
  const { example, path, options } = await setup(t);
  await initializeDataDir(options);
  const content = JSON.stringify({ ...example, filtro: { remoto: 'talvez' }, infojobsFiltros: [{ local: 'DF' }] });
  await writeFile(path, content);
  await assert.rejects(loadSearch(options), /Busca inválida.*infojobsFiltros.*filtro\.remoto.*preservado/);
  assert.equal(await readFile(path, 'utf8'), content);
});
