import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarFiltro } from '../src/filter.mjs';
import { toDay } from '../src/page/view.mjs';
import { classificarVariantes } from '../src/preparo/variante.mjs';
import { selecionar } from '../src/preparo/selecao.mjs';

// Vagas, empresas e variantes inventadas, montadas aqui. Nenhum dado real.
const vaga = {
  title: 'Analista de Dados Sênior',
  description: 'Experiência com SQL e Python. Power BI desejável.',
};
const variantes = [
  { id: 'v-obras', titulo: 'Engenheiro de Obras', perfil: 'Acompanho obras civis fictícias.', habilidades: ['Orçamento de obra'] },
  { id: 'v-bi', titulo: 'Especialista em BI', perfil: 'Painéis inventados para a gestão.', habilidades: ['Power BI'] },
  { id: 'v-senior', titulo: 'Coordenador Senior', perfil: 'Lidero equipes imaginárias.', habilidades: [] },
  { id: 'v-dados', titulo: 'Analista de Dados', perfil: 'Atuo com dados de uma empresa fictícia.', habilidades: ['SQL', 'Python'] },
];

test('16.1 ordem por cobertura: título vale 3, descrição vale 1, sem acento e sem palavras vazias', () => {
  const ordem = classificarVariantes(vaga, variantes);
  // À mão: título {analista, dados, senior}; descrição {experiencia, sql, python, power, bi, desejavel}.
  // v-dados: 2 do título (6) + sql, python (2) = 8; v-senior: "senior" sem acento casa "Sênior" (3);
  // v-bi: power, bi (2); v-obras: só "de" em comum, que é palavra vazia (0).
  assert.deepEqual(ordem.map(({ id, pontos }) => [id, pontos]), [['v-dados', 8], ['v-senior', 3], ['v-bi', 2], ['v-obras', 0]]);
  assert.deepEqual(ordem[0].casados, { titulo: ['analista', 'dados'], descricao: ['sql', 'python'] });
  assert.deepEqual(ordem[0].lacunas, ['senior']);
  assert.deepEqual(ordem[3].lacunas, ['analista', 'dados', 'senior']);
});

test('16.1 o porquê lista os termos casados e as lacunas do título', () => {
  const [melhor] = classificarVariantes(vaga, variantes);
  assert.equal(melhor.porque, 'Título: analista, dados. Descrição: sql, python. Lacunas do título: senior.');
});

test('16.1 empate de pontos desempata pelo id, qualquer que seja a ordem de entrada', () => {
  const igual = { titulo: 'Analista de Dados', perfil: 'Texto igual.', habilidades: [] };
  const entrada = [{ id: 'c-var', ...igual }, { id: 'b-var', ...igual }, { id: 'a-var', ...igual }];
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(classificarVariantes(vaga, entrada).map(v => v.id), ['a-var', 'b-var', 'c-var']);
  }
});

test('16.1 variante bloqueada nunca é escolhida, nem sendo a de maior cobertura', () => {
  const ordem = classificarVariantes(vaga, variantes, { bloqueadas: ['v-dados'] });
  assert.equal(ordem[0].id, 'v-senior');
  assert.ok(!ordem.some(v => v.id === 'v-dados'));
  assert.ok(!classificarVariantes(vaga, variantes, { bloqueadas: new Set(['v-dados', 'v-senior']) }).some(v => ['v-dados', 'v-senior'].includes(v.id)));
});

test('16.2 a mesma entrada duas vezes dá a mesma saída, e a ordem da entrada não muda o resultado', () => {
  const primeira = classificarVariantes(vaga, variantes);
  assert.deepEqual(classificarVariantes(vaga, variantes), primeira);
  assert.deepEqual(classificarVariantes(vaga, [...variantes].reverse()), primeira);
  const entradas = base();
  const sel = selecionar(entradas, { quantidade: 5 });
  assert.deepEqual(selecionar(entradas, { quantidade: 5 }), sel);
  assert.deepEqual(selecionar([...entradas].reverse(), { quantidade: 5 }).selecionadas.map(e => e.id), sel.selecionadas.map(e => e.id));
});

// Entrada no formato do toJobs/toDay.
function entrada(id, source, fit, publishedAt = '2026-10-10T12:00:00.000Z', extra = {}) {
  return {
    id, job: { title: `Vaga ${id}`, company: 'Empresa Fictícia', source, publishedAt },
    seen: { dedupKey: id, firstSeenAt: '2026-10-17T10:00:00.000Z' },
    triage: fit == null ? null : { fit, reason: 'inventada', alerts: [], triagedAt: '2026-10-17T11:00:00.000Z' },
    mark: null, tracking: null, ...extra,
  };
}
const marcada = { mark: { status: 'discarded', cutReason: 'inventado', markedAt: '2026-10-17T11:00:00.000Z' } };
const ids = resultado => resultado.selecionadas.map(e => e.id);

function base() {
  return [
    entrada('s1', 'solides', 5, '2026-10-12T12:00:00.000Z'),
    entrada('g1', 'gupy', 4, '2026-10-11T12:00:00.000Z'),
    entrada('i2', 'infojobs', 4, '2026-10-10T12:00:00.000Z'),
    entrada('i1', 'infojobs', 4, '2026-10-10T12:00:00.000Z'), // mesmo dia de i2: desempate pelo id
    entrada('a2', 'solides', 4, null), // sem data vai para o fim da nota, embora o id venha antes
    entrada('s3', 'solides', 3),
    entrada('m1', 'solides', 5, '2026-10-16T12:00:00.000Z', marcada),
    entrada('c1', 'infojobs', 5, '2026-10-16T12:00:00.000Z', { motivo: 'fora-do-local', alertas: [] }),
    entrada('t1', 'solides', null, '2026-10-16T12:00:00.000Z'),
  ];
}

test('16.3 as 5 de maior estrela, desempate por publicação e depois id, sem marcadas, cortadas nem sem triagem', () => {
  const resultado = selecionar(base(), { quantidade: 5 });
  assert.deepEqual(ids(resultado), ['s1', 'g1', 'i1', 'i2', 'a2']);
  assert.equal(resultado.ok, true);
  assert.equal(resultado.restricaoFalhou, null);
  assert.equal(resultado.faltam, 0);
});

test('16.3 com entradas vindas do toDay e do filtro: a cortada e a marcada ficam fora', () => {
  const rounds = [{ inicio: '2026-10-17T09:00:00.000Z', fim: '2026-10-17T12:00:00.000Z' }];
  const jobs = {};
  for (const e of [entrada('g1', 'gupy', 3), entrada('s1', 'solides', 4), entrada('s2', 'solides', 5, undefined, marcada),
    entrada('i1', 'infojobs', 5)]) {
    const { id, ...resto } = e;
    jobs[id] = { ...resto, job: { ...resto.job, location: id === 'i1' ? 'Cidade Inventada, AM' : 'Cidade Fictícia, DF', workModel: 'onsite' } };
  }
  const filtro = { local: { ufs: ['DF'] } };
  const dia = toDay({ jobs }, rounds, job => aplicarFiltro(job, filtro));
  assert.deepEqual(dia.cortadas.map(e => e.id), ['i1']);
  const resultado = selecionar([...dia.mostradas, ...dia.cortadas], { quantidade: 5 });
  assert.deepEqual(ids(resultado), ['s1', 'g1']);
  assert.equal(resultado.faltam, 3);
});

test('16.4 top 5 sem Gupy: a pior das 5 sai e entra a melhor da Gupy', () => {
  const entradas = [
    entrada('s1', 'solides', 5), entrada('s2', 'solides', 5), entrada('i1', 'infojobs', 4), entrada('i2', 'infojobs', 4),
    entrada('s3', 'solides', 3), entrada('s4', 'solides', 3, '2026-10-01T12:00:00.000Z'),
    entrada('g2', 'gupy', 1), entrada('g1', 'gupy', 2),
  ];
  const resultado = selecionar(entradas, { quantidade: 5 });
  assert.deepEqual(ids(resultado), ['s1', 's2', 'i1', 'i2', 'g1']); // s3, a pior das 5, deu lugar à g1
  assert.equal(resultado.ok, true);
});

test('16.4 uma fonte só: a pior sai e entra a melhor de outra fonte, sem tirar a única Gupy', () => {
  const soGupy = [
    entrada('g1', 'gupy', 5), entrada('g2', 'gupy', 5), entrada('g3', 'gupy', 4), entrada('g4', 'gupy', 4), entrada('g5', 'gupy', 3),
    entrada('s1', 'solides', 1), entrada('i1', 'infojobs', 2),
  ];
  const resultado = selecionar(soGupy, { quantidade: 5 });
  assert.deepEqual(ids(resultado), ['g1', 'g2', 'g3', 'g4', 'i1']);
  assert.equal(resultado.ok, true);

  // Com 1 vaga só, a única Gupy não pode sair para dar lugar à outra fonte.
  const umaSo = selecionar([entrada('g1', 'gupy', 5), entrada('s1', 'solides', 4)], { quantidade: 1 });
  assert.deepEqual(ids(umaSo), ['g1']);
  assert.equal(umaSo.restricaoFalhou, 'fontes');
});

test('16.5 nenhuma Gupy elegível no dia: ok false, restricaoFalhou "gupy", sem completar com vaga de fora da regra', () => {
  const entradas = [
    entrada('s1', 'solides', 5), entrada('i1', 'infojobs', 4), entrada('s2', 'solides', 3),
    entrada('g-marcada', 'gupy', 5, undefined, marcada),
    entrada('g-cortada', 'gupy', 5, undefined, { motivo: 'fora-do-local', alertas: [] }),
    entrada('g-sem-triagem', 'gupy', null),
  ];
  const resultado = selecionar(entradas, { quantidade: 5 });
  assert.deepEqual(resultado, { ok: false, restricaoFalhou: 'gupy', selecionadas: resultado.selecionadas, faltam: 2 });
  assert.deepEqual(ids(resultado), ['s1', 'i1', 's2']);

  const soUmaFonte = selecionar([entrada('g1', 'gupy', 5), entrada('g2', 'gupy', 4), entrada('s-marcada', 'solides', 5, undefined, marcada)]);
  assert.equal(soUmaFonte.ok, false);
  assert.equal(soUmaFonte.restricaoFalhou, 'fontes');
  assert.deepEqual(ids(soUmaFonte), ['g1', 'g2']);
});

test('16.6 menos de 5 elegíveis: devolve as que há e faltam N', () => {
  const resultado = selecionar([entrada('g1', 'gupy', 3), entrada('s1', 'solides', 2), entrada('i1', 'infojobs', 4)], { quantidade: 5 });
  assert.deepEqual(ids(resultado), ['i1', 'g1', 's1']);
  assert.equal(resultado.faltam, 2);
  assert.equal(resultado.ok, true);
});

test('16.6 a janela de rodadas é parâmetro da função: 1 rodada pega só a última, 2 pegam as duas', () => {
  const rounds = [
    { inicio: '2026-10-15T09:00:00.000Z', fim: '2026-10-15T10:00:00.000Z' },
    { inicio: '2026-10-16T09:00:00.000Z', fim: '2026-10-16T10:00:00.000Z' },
    { inicio: '2026-10-17T09:00:00.000Z', fim: '2026-10-17T10:00:00.000Z' },
  ];
  const em = (e, firstSeenAt) => ({ ...e, seen: { ...e.seen, firstSeenAt } });
  const entradas = [
    em(entrada('velha', 'gupy', 5), '2026-10-15T09:30:00.000Z'),
    em(entrada('ontem', 'gupy', 4), '2026-10-16T09:30:00.000Z'),
    em(entrada('hoje', 'solides', 3), '2026-10-17T09:30:00.000Z'),
  ];
  const uma = selecionar(entradas, { quantidade: 5, rodadas: 1, rounds });
  assert.deepEqual(ids(uma), ['hoje']);
  assert.equal(uma.restricaoFalhou, 'gupy');
  const duas = selecionar(entradas, { quantidade: 5, rodadas: 2, rounds });
  assert.deepEqual(ids(duas), ['ontem', 'hoje']);
  assert.equal(duas.ok, true);
  assert.equal(duas.faltam, 3);
  assert.throws(() => selecionar(entradas, { rodadas: 2 }), /rounds/);
  assert.throws(() => selecionar(entradas, { rodadas: 0, rounds }), /rodadas/);
});
