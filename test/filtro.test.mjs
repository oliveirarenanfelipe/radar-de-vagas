import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarFiltro, classificarLocal } from '../src/filter.mjs';

// Vagas e empresas inventadas; o filtro é o do PRD (DF em qualquer modelo, remota no Brasil).
const termos = ['automacao de processos', 'analista de processos'];
const filtro = {
  local: { ufs: ['DF'], cidades: ['Brasília', 'Taguatinga'] },
  remoto: 'brasil',
  titulo: { ligado: true, sinonimos: ['melhoria contínua'] },
};
const vaga = (campos = {}) => ({
  source: 'ficticia', sourceId: 'f-001', url: 'https://exemplo.invalid/vaga/f-001', applyUrl: null,
  title: 'Analista de Processos', company: 'Empresa Fictícia Alfa', location: null, workModel: null,
  description: 'Descrição inventada.', publishedAt: null, salary: null, employmentType: null, ...campos,
});
const passa = (...alertas) => ({ passa: true, motivo: null, alertas });
const corta = (motivo, ...alertas) => ({ passa: false, motivo, alertas });

const tabela = [
  ['6.1 presencial em São Paulo - SP', vaga({ workModel: 'onsite', location: 'São Paulo - SP' }), filtro, corta('fora-do-local')],
  ['6.2 presencial em Brasília - DF', vaga({ workModel: 'onsite', location: 'Brasília - DF' }), filtro, passa()],
  ['6.3 remota em Recife - PE', vaga({ workModel: 'remote', location: 'Recife - PE' }), filtro, passa()],
  ['6.4 remota em Lisboa, Portugal', vaga({ workModel: 'remote', location: 'Lisboa, Portugal' }), filtro, corta('remota-fora-do-pais')],
  ['6.5 sem local e sem modelo', vaga(), filtro, passa('local-nao-informado')],
  ['6.6 híbrida em Brasília de Minas - MG', vaga({ workModel: 'hybrid', location: 'Brasília de Minas - MG' }), filtro, corta('fora-do-local')],
  ['6.7 presencial em Taguatinga, sem UF', vaga({ workModel: 'onsite', location: 'Taguatinga' }), filtro, passa()],
  ['6.8 modelo nulo em Curitiba - PR', vaga({ location: 'Curitiba - PR' }), filtro, passa('modelo-nao-informado')],
  ['6.9 remota em Remote - LATAM', vaga({ workModel: 'remote', location: 'Remote - LATAM' }), filtro, passa('remota-regional')],
  ['6.10 título sem termo', vaga({ title: 'Analista Financeiro', workModel: 'onsite', location: 'Brasília - DF' }), filtro, corta('titulo-sem-termo')],
  ['6.11 título em maiúsculas e com acento', vaga({ title: 'AUTOMAÇÃO DE PROCESSOS Sr', workModel: 'onsite', location: 'Brasília - DF' }), filtro, passa()],
  ['6.12 sem filtro, vaga que seria cortada', vaga({ title: 'Analista Financeiro', workModel: 'onsite', location: 'São Paulo - SP' }), undefined, passa()],
];

for (const [nome, job, config, esperado] of tabela) {
  test(nome, () => {
    assert.deepEqual(aplicarFiltro(job, config, termos), esperado);
  });
}

test('determinístico e puro: a mesma entrada dá a mesma saída e nada é alterado', () => {
  const congelados = tabela.map(([, job, config]) => [structuredClone(job), structuredClone(config)]);
  const primeira = tabela.map(([, job, config]) => aplicarFiltro(job, config, termos));
  const segunda = tabela.map(([, job, config]) => aplicarFiltro(job, config, termos));
  assert.deepEqual(primeira, segunda);
  assert.deepEqual(tabela.map(([, job, config]) => [job, config]), congelados);
  assert.deepEqual(termos, ['automacao de processos', 'analista de processos']);
});

test('presencial em São Paulo é cortada em qualquer forma de escrever o local', () => {
  for (const location of ['São Paulo, São Paulo, Brasil', 'Sao Paulo/SP', 'São Paulo (SP)', 'SP', 'são paulo, são paulo, brazil',
    'Campinas - SP, Brasil', 'São Paulo - SP / Remoto']) {
    assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location }), filtro, termos), corta('fora-do-local'), location);
  }
});

test('o DF passa escrito por sigla, nome do estado em português ou em inglês', () => {
  for (const location of ['Brasília/DF', 'Brasília, Distrito Federal, Brasil', 'Brasilia, Federal District, Brazil', 'Gama - DF']) {
    assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location }), filtro, termos), passa(), location);
  }
});

test('sem local, qualquer modelo passa com alerta; sem filtro de local nem remoto, sem alerta', () => {
  for (const workModel of ['onsite', 'hybrid', 'remote', null]) {
    for (const location of [null, '', '   ']) {
      assert.deepEqual(aplicarFiltro(vaga({ workModel, location }), filtro, termos), passa('local-nao-informado'), `${workModel} ${location}`);
    }
  }
  assert.deepEqual(aplicarFiltro(vaga(), { titulo: { ligado: true } }, termos), passa());
});

test('a ordem é local antes de título, e a cortada leva só o primeiro motivo', () => {
  const job = vaga({ title: 'Analista Financeiro', workModel: 'onsite', location: 'São Paulo - SP' });
  assert.deepEqual(aplicarFiltro(job, filtro, termos), corta('fora-do-local'));
  const semLocal = vaga({ title: 'Analista Financeiro' });
  assert.deepEqual(aplicarFiltro(semLocal, filtro, termos), corta('titulo-sem-termo', 'local-nao-informado'));
});

test('classificarLocal: UF, país, região, sem país e outro país', () => {
  const casos = [
    [null, 'vazio', []], ['', 'vazio', []],
    ['Brasília - DF', 'brasil', ['DF']], ['Campo Grande, Mato Grosso do Sul', 'brasil', ['MS']],
    ['Cuiabá, Mato Grosso', 'brasil', ['MT']], ['Belém, Pará', 'brasil', ['PA']],
    ['Espírito Santo do Pinhal - SP', 'brasil', ['SP']], ['Brasil', 'brasil', []], ['Remote - BR', 'brasil', []],
    ['Remote - Brazil', 'brasil', []], ['América Latina', 'regional', []], ['Remote, South America', 'regional', []],
    ['Remoto', 'sem-pais', []], ['Remote', 'sem-pais', []], ['Home Office', 'sem-pais', []], ['Anywhere', 'regional', []],
    ['Lisboa, Portugal', 'outro-pais', []], ['Remote - US', 'outro-pais', []], ['vaga para remoto', 'nao-identificado', []],
    ['Cidade de minas', 'nao-identificado', []], ['Franca', 'nao-identificado', []], ['Lisboa', 'nao-identificado', []],
  ];
  for (const [location, tipo, ufs] of casos) assert.deepEqual(classificarLocal(location), { tipo, ufs }, String(location));
});

test('sigla de UF só vale em maiúsculas: "de" e "se" não viram estado', () => {
  assert.deepEqual(classificarLocal('Brasília de Minas'), { tipo: 'nao-identificado', ufs: [] });
  // Sem UF, a cidade da lista decide (PREMISSA 2: DF por cidade quando não há sigla).
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location: 'Taguatinga Sul, se houver vaga' }), filtro, termos), passa());
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location: 'Lisboa' }), filtro, termos), corta('fora-do-local'));
});

test('remoto: "brasil" aceita sem país e cidade da lista, "qualquer-pais" aceita tudo, "nao" julga pelo local', () => {
  const lisboa = vaga({ workModel: 'remote', location: 'Lisboa, Portugal' });
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Remoto' }), filtro, termos), passa());
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Taguatinga' }), filtro, termos), passa());
  assert.deepEqual(aplicarFiltro(lisboa, { ...filtro, remoto: 'qualquer-pais' }, termos), passa());
  assert.deepEqual(aplicarFiltro(lisboa, { local: filtro.local }, termos), passa());
  assert.deepEqual(aplicarFiltro(lisboa, { ...filtro, remoto: 'nao' }, termos), corta('fora-do-local'));
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Recife - PE' }), { ...filtro, remoto: 'nao' }, termos), corta('fora-do-local'));
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Brasília - DF' }), { ...filtro, remoto: 'nao' }, termos), passa());
});

test('sem "local" no filtro, presencial passa em qualquer lugar', () => {
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location: 'São Paulo - SP' }), { remoto: 'brasil' }, termos), passa());
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location: 'São Paulo - SP' }), {}, termos), passa());
});

test('título: palavras inteiras, sinônimos, descrição fora e corte só com ligado true', () => {
  const noDf = campos => vaga({ workModel: 'onsite', location: 'Brasília - DF', ...campos });
  // "processos" sozinho não é a sequência "analista de processos".
  assert.deepEqual(aplicarFiltro(noDf({ title: 'Gerente de Processos' }), filtro, termos), corta('titulo-sem-termo'));
  // Palavra inteira: "automacao de processosx" não casa.
  assert.deepEqual(aplicarFiltro(noDf({ title: 'Automação de Processosx' }), filtro, termos), corta('titulo-sem-termo'));
  assert.deepEqual(aplicarFiltro(noDf({ title: 'Coordenador(a) de Melhoria Continua' }), filtro, termos), passa());
  assert.deepEqual(aplicarFiltro(noDf({ title: 'Analista-de-Processos/Pleno' }), filtro, termos), passa());
  const naDescricao = noDf({ title: 'Analista Financeiro', description: 'Atua com automação de processos.' });
  assert.deepEqual(aplicarFiltro(naDescricao, filtro, termos), corta('titulo-sem-termo'));
  for (const titulo of [undefined, { sinonimos: ['x'] }, { ligado: false, sinonimos: [] }]) {
    assert.deepEqual(aplicarFiltro(naDescricao, { ...filtro, titulo }, termos), passa(), JSON.stringify(titulo));
  }
  // Termo só com pontuação não corta tudo.
  assert.deepEqual(aplicarFiltro(naDescricao, { titulo: { ligado: true } }, ['!!!']), passa());
});

test('S5: remota só é cortada por país estrangeiro explícito', () => {
  const remota = location => aplicarFiltro(vaga({ workModel: 'remote', location }), filtro, termos);
  for (const location of ['Nicaragua', 'Remoto - Portugal', 'Remote - USA', 'Remote (US only)', 'Ciudad de Mexico, Mexico',
    'Bogotá, Colombia', 'London, United Kingdom', 'Remote - Europe']) {
    assert.deepEqual(remota(location), corta('remota-fora-do-pais'), location);
  }
});

test('S5: Worldwide, Global, Anywhere, Latin America, LATAM e Americas passam com alerta regional', () => {
  for (const location of ['Remote (Worldwide)', 'Global', 'Anywhere', 'Latin America', 'LATAM, Mexico', 'Remote - Americas']) {
    assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location }), filtro, termos), passa('remota-regional'), location);
  }
});

test('S5: local sem sinal de país passa remota com alerta; presencial segue julgada pelo local', () => {
  for (const location of ['Recife', 'Lisboa', 'Franca']) {
    assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location }), filtro, termos), passa('pais-nao-identificado'), location);
    assert.deepEqual(aplicarFiltro(vaga({ workModel: 'onsite', location }), filtro, termos), corta('fora-do-local'), location);
  }
  // Só palavra de remoto não é país desconhecido: passa sem alerta.
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Remoto' }), filtro, termos), passa());
  // Com "qualquer-pais", país não importa e não há alerta.
  assert.deepEqual(aplicarFiltro(vaga({ workModel: 'remote', location: 'Recife' }), { ...filtro, remoto: 'qualquer-pais' }, termos), passa());
});
