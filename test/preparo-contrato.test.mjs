import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSearch, validateSearch } from '../src/data-dir.mjs';
import {
  carregarBasesAprovadas, carregarComplementos, carregarFrasesAprovadas, carregarProibidas, hashRetrato,
  validarDeclarado, validarFatos,
} from '../src/preparo/contrato.mjs';
import { chaveFrase, normalizarEmpresa, normalizarPeriodo, partirFrases, partirSecao } from '../src/preparo/frases.mjs';

// Pasta de dados temporária: os arquivos do preparo nascem aqui, por código, com pessoa e empresa inventadas.
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-preparo-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const put = (nome, conteudo) => writeFile(join(dataDir, nome), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
  return { dataDir, put };
}

const experiencia = { cargo: 'Analista de Planejamento', empresa: 'Alfa Fictícia Ltda.', periodo: 'Mar/2023 – Mar/2026', local: 'Cidade Imaginária' };
const declarado = (extra = {}) => ({
  versao: 1, experiencias: [experiencia], formacao: [{ titulo: 'Bacharel Inventado', instituicao: 'Universidade Fictícia', periodo: '2010 – 2014' }],
  cursos: ['Curso Inventado'], idiomas: [{ idioma: 'Inglês', nivel: 'Fluente' }],
  textoLivre: [{ secao: 'titulo', texto: 'Analista de Planejamento' }, { secao: 'perfil', texto: 'Planejo cenários fictícios.' }],
  ...extra,
});
const fatos = (extra = {}) => {
  const { textoLivre, ...rest } = declarado();
  return { ...rest, base: 'base_ficticia-1', experiencias: [{ ...experiencia, aliases: ['Alfa'] }],
    textoLivre: [...textoLivre, { secao: 'experiencia', texto: 'Planejei cenários fictícios.' }], ...extra };
};
const has = (problems, pattern) => problems.some(problem => pattern.test(problem));

test('11.1 CV declarado e fatos: válidos passam; campo extra, versão, cargo vazio e seções faltando reprovam', () => {
  assert.deepEqual(validarDeclarado(declarado()), []);
  assert.deepEqual(validarDeclarado(declarado({ textoLivre: [...declarado().textoLivre,
    { secao: 'habilidades', texto: 'Planejamento' }, { secao: 'integral', texto: 'Tudo\nque o DOCX tem' }, { secao: 'gupy', texto: 'Texto' }] })), []);
  assert.ok(has(validarDeclarado(declarado({ extra: 1 })), /campo desconhecido no CV declarado: "extra"/));
  assert.ok(has(validarDeclarado(declarado({ versao: 2 })), /versao/));
  assert.ok(has(validarDeclarado(declarado({ experiencias: [{ ...experiencia, cargo: ' ' }] })), /cargo vazio/));
  for (const textoLivre of [[], [{ secao: 'perfil', texto: 'Perfil fictício.' }], [{ secao: 'titulo', texto: 'Título' }],
    [{ secao: 'titulo', texto: 'Título' }, { secao: 'perfil', texto: '   ' }], [{ secao: 'titulo', texto: '' }, { secao: 'perfil', texto: 'Perfil.' }]]) {
    assert.ok(has(validarDeclarado(declarado({ textoLivre })), /declarado sem título\/perfil/), JSON.stringify(textoLivre));
  }
  assert.ok(has(validarDeclarado(declarado({ textoLivre: [...declarado().textoLivre, { secao: 'resumo', texto: 'x' }] })), /textoLivre\[2\]/));
  assert.ok(has(validarDeclarado(declarado({ experiencias: [{ ...experiencia, periodo: 'Março de 2023' }] })), /Período não reconhecido/));

  assert.deepEqual(validarFatos(fatos()), []);
  const { base, ...semBase } = fatos();
  assert.equal(base, 'base_ficticia-1');
  assert.ok(has(validarFatos(semBase), /campo ausente nos fatos: "base"/));
  assert.ok(has(validarFatos(fatos({ base: 'base fictícia' })), /"base"/));
  assert.ok(has(validarFatos(fatos({ idioma: 'pt' })), /campo desconhecido nos fatos: "idioma"/));
  for (const aliases of ['Alfa', [''], [3]]) {
    assert.ok(has(validarFatos(fatos({ experiencias: [{ ...experiencia, aliases }] })), /aliases/), JSON.stringify(aliases));
  }
  // O declarado não aceita aliases (é campo só dos fatos).
  assert.ok(has(validarDeclarado(declarado({ experiencias: [{ ...experiencia, aliases: ['Alfa'] }] })), /experiencias\[0\]/));
});

test('11.2 normalizarPeriodo lê os formatos do contrato e recusa o resto, sem chutar', () => {
  const casos = [['Mar/2023 – Mar/2026', '2023-03', '2026-03'], ['Jan/2025 - Atual', '2025-01', 'atual'],
    ['Sep/2016 – Jun/2017', '2016-09', '2017-06'], ['2010 – 2014', '2010-01', '2014-12'], ['2014', '2014-01', '2014-12'],
    ['2025 – em andamento', '2025-01', 'atual'], ['Jan/2025 – In progress', '2025-01', 'atual'], ['2024 – Cursando', '2024-01', 'atual'],
    ['Fev/2020 — Dez/2021', '2020-02', '2021-12'], ['jan/2019 - present', '2019-01', 'atual']];
  for (const [texto, inicio, fim] of casos) assert.deepEqual(normalizarPeriodo(texto), { inicio, fim }, texto);
  for (const texto of ['Março de 2023', 'em andamento', '2025 – logo', 'Atual – 2025', 'Xyz/2020 – 2021', '2026 – 2020', '', 'Mar/23 – Mar/26']) {
    assert.throws(() => normalizarPeriodo(texto), /Período não reconhecido/, texto);
  }
});

test('normalizarEmpresa tira sufixo societário só como palavra inteira do fim', () => {
  assert.equal(normalizarEmpresa('Alfa Fictícia Ltda.'), 'alfa ficticia');
  assert.equal(normalizarEmpresa('ALFA FICTICIA S.A.'), 'alfa ficticia');
  assert.equal(normalizarEmpresa('Beta Inventada S/A'), 'beta inventada');
  assert.equal(normalizarEmpresa('Gama Imaginária Ltda ME'), 'gama imaginaria');
  assert.equal(normalizarEmpresa('Mesa'), 'mesa');
  assert.equal(normalizarEmpresa('Ltda.'), '');
});

test('partição e chave de frase (fonte única de frases.mjs): os casos 12.29 e 12.29b', () => {
  const perfil = [{ secao: 'perfil', texto: 'Atuo em campo. Reduzi 12% do custo; entreguei 3 obras' },
    { secao: 'perfil', texto: '- Equipe de 8\n• 1.000 visitas | 2) Sr. Silva aprovou' }, { secao: 'titulo', texto: 'Fora da seção' }];
  assert.deepEqual(partirSecao(perfil, 'perfil').flat().map(chaveFrase),
    ['atuo em campo', 'reduzi 12% do custo', 'entreguei 3 obras', 'equipe de 8', '1.000 visitas', 'sr', 'silva aprovou']);
  // Cada item é uma linha: a frase nunca atravessa dois itens.
  assert.deepEqual(partirSecao(perfil, 'perfil').map(linha => linha.length), [3, 1, 3]);
  assert.deepEqual(partirFrases('1. Reduzi custos em 12%\n2) Entreguei 3 obras\n12. Atendi 40 clientes\n2024. Ano de 9 entregas').map(chaveFrase),
    ['reduzi custos em 12%', 'entreguei 3 obras', 'atendi 40 clientes', '2024', 'ano de 9 entregas']);
  assert.equal(chaveFrase('R$ 90 mil em contratos.'), chaveFrase('r$ 90 mil em contratos'));
  assert.notEqual(chaveFrase('R$90k/mês em contratos novos'), chaveFrase('R$90k/mês em contratos'));
  assert.deepEqual(partirFrases('... ; | •'), []);
});

test('11.3 preparo: chaves fechadas, comando e placeholders, e as quatro listas', async t => {
  const { dataDir } = await setup(t);
  const busca = await loadSearch({ dataDir });
  const comando = args => ({ comando: 'python', args });
  const preparo = {
    variantes: comando(['-P', '/ponte/ficticia.py', 'variantes']), fatos: comando(['-P', '/ponte/ficticia.py', 'fatos', '{variante}']),
    gerarCv: comando(['-P', '/ponte/ficticia.py', 'gerar', '{variante}', '{pasta}']), gateCv: comando(['-P', '/ponte/gate.py', '{pdf}']),
    termosHierarquia: ['Gerente Fictício', 'líder técnico'], empresasExtras: ['Cliente Inventado S.A.'],
    certificacoesExtras: ['Certificação Inventada X'], fontesCirculares: ['meu_curriculo_ficticio', 'perfis\\.json'],
  };
  assert.deepEqual(validateSearch({ ...busca, preparo }), []);
  await writeFile(join(dataDir, 'busca.json'), JSON.stringify({ ...busca, preparo }));
  const lido = (await loadSearch({ dataDir })).preparo;
  for (const key of ['termosHierarquia', 'empresasExtras', 'certificacoesExtras', 'fontesCirculares']) assert.deepEqual(lido[key], preparo[key]);
  assert.deepEqual(validateSearch({ ...busca, preparo: {} }), []);

  const problemas = patch => validateSearch({ ...busca, preparo: { ...preparo, ...patch } }).join(' | ');
  assert.match(problemas({ termosHierarquiaa: ['x'] }), /campo desconhecido em preparo: "termosHierarquiaa"/);
  assert.match(problemas({ numeros: true }), /campo desconhecido em preparo: "numeros"/);
  assert.match(problemas({ fatos: { comando: 'bin/python', args: [] } }), /comando relativo/);
  assert.match(problemas({ fatos: comando(['{outro}']) }), /placeholder inválido/);
  assert.match(problemas({ gerarCv: comando(['--saida={pasta}']) }), /placeholder inválido/);
  assert.match(problemas({ fatos: { comando: 'python', args: [], extra: 1 } }), /preparo\.fatos/);
  assert.match(problemas({ fatos: { comando: 'python', args: 'fatos' } }), /preparo\.fatos/);
  for (const fontesCirculares of ['curriculo', [3], ['(sem fechar']]) {
    assert.match(problemas({ fontesCirculares }), /preparo\.fontesCirculares/, JSON.stringify(fontesCirculares));
  }
  for (const key of ['termosHierarquia', 'empresasExtras', 'certificacoesExtras']) {
    for (const value of ['texto', [''], [1]]) assert.match(problemas({ [key]: value }), new RegExp(`preparo\\.${key}`), `${key} ${JSON.stringify(value)}`);
  }
  assert.match(problemas({ termosHierarquia: ['gerente/diretor'] }), /preparo\.termosHierarquia/);
  assert.match(problemas({ empresasExtras: ['Ltda.'] }), /preparo\.empresasExtras/);
  assert.match(validateSearch({ ...busca, preparo: [] }).join(), /"preparo" precisa ser um objeto/);
});

test('11.4 afirmacoes-proibidas.json com regex inválida é erro de carga, nunca lista vazia', async t => {
  const { dataDir, put } = await setup(t);
  assert.deepEqual(await carregarProibidas({ dataDir }), []);
  await put('afirmacoes-proibidas.json', [{ id: 'p1', padrao: 'frase vetada inventada', descricao: 'Afirmação vetada inventada.' }]);
  const [proibida] = await carregarProibidas({ dataDir });
  assert.ok(proibida.regex.test('uma frase vetada inventada aqui'));
  await put('afirmacoes-proibidas.json', [{ id: 'p1', padrao: 'ok', descricao: '' }, { id: 'p2', padrao: '(sem fechar', descricao: '' }]);
  await assert.rejects(carregarProibidas({ dataDir }), /afirmacoes-proibidas\.json: item 1 \("p2"\): regex inválida/);
  await put('afirmacoes-proibidas.json', '{ quebrado');
  await assert.rejects(carregarProibidas({ dataDir }), /JSON válido/);
});

const fonte = (extra = {}) => ({ tipo: 'comprovante', referencia: 'Certificado inventado número 12 de 2024', data: '2024-05-10', ...extra });

test('11.5 fatos-complementares.json: item inválido ou com fonte circular é erro de carga com o índice', async t => {
  const { dataDir, put } = await setup(t);
  assert.deepEqual(await carregarComplementos({ dataDir }), []);
  const validos = [{ tipo: 'curso', texto: 'Certificação Inventada X', fonte: fonte() },
    { tipo: 'idioma', idioma: 'Espanhol', nivel: 'Básico', fonte: fonte({ tipo: 'registro-de-plataforma' }) },
    { tipo: 'formacao', titulo: 'Especialização Fictícia', instituicao: 'Escola Inventada', periodo: '2020 – 2021', fonte: fonte({ tipo: 'fala-datada' }) }];
  await put('fatos-complementares.json', validos);
  assert.equal((await carregarComplementos({ dataDir })).length, 3);
  const invalidos = [
    [{ tipo: 'curso', texto: 'Sem fonte' }, /item 1/],
    [{ tipo: 'numero', texto: '90 mil', fonte: fonte() }, /item 1: tipo precisa ser curso, idioma ou formacao/],
    [{ tipo: 'idioma', idioma: 'Espanhol', fonte: fonte() }, /item 1: o tipo idioma precisa de idioma, nivel/],
    [{ tipo: 'curso', texto: 'Curso', fonte: fonte({ tipo: 'boato' }) }, /item 1: fonte precisa/],
    [{ tipo: 'curso', texto: 'Curso', fonte: fonte({ data: '2024-02-30' }) }, /item 1: fonte precisa/],
    [{ tipo: 'curso', texto: 'Curso', extra: 1, fonte: fonte() }, /item 1/],
  ];
  for (const [item, erro] of invalidos) {
    await put('fatos-complementares.json', [validos[0], item]);
    await assert.rejects(carregarComplementos({ dataDir }), erro, JSON.stringify(item));
  }
  for (const referencia of ['CV_Ana_Ficticia.pdf', 'Currículo Fictício v3.docx', 'resume-ficticio.pdf', 'curriculum vitae']) {
    await put('fatos-complementares.json', [validos[0], { tipo: 'curso', texto: 'Curso', fonte: fonte({ referencia }) }]);
    await assert.rejects(carregarComplementos({ dataDir }), /item 1: fonte circular/, referencia);
  }
  // "cvm" e "resumo" não são fonte circular; o padrão da pessoa (preparo.fontesCirculares) também barra.
  await put('fatos-complementares.json', [{ tipo: 'curso', texto: 'Curso', fonte: fonte({ referencia: 'Relatório CVM e resumo anual' }) }]);
  assert.equal((await carregarComplementos({ dataDir })).length, 1);
  await put('fatos-complementares.json', [{ tipo: 'curso', texto: 'Curso', fonte: fonte({ referencia: 'perfis_ficticios.json' }) }]);
  await assert.rejects(carregarComplementos({ dataDir, preparo: { fontesCirculares: ['perfis_ficticios'] } }), /item 0: fonte circular \(a referência casa "perfis_ficticios"\)/);
});

const frase = (extra = {}) => ({ texto: 'Reduzi 12% do custo de obras fictícias.', aprovadaEm: '2026-10-01', origem: 'variante ficticia, perfil', ...extra });

test('11.6 frases-aprovadas.json: item inválido, data, duplicata e caractere de controle são erro de carga com o índice', async t => {
  const { dataDir, put } = await setup(t);
  const hoje = '2026-10-17';
  assert.deepEqual(await carregarFrasesAprovadas({ dataDir, hoje }), []);
  await put('frases-aprovadas.json', { versao: 1, frases: [frase(), frase({ texto: 'Atendi 40 clientes. Por mês.' })] });
  const aprovadas = await carregarFrasesAprovadas({ dataDir, hoje });
  assert.deepEqual(aprovadas.map(item => item.chave), [['reduzi 12% do custo de obras ficticias'], ['atendi 40 clientes', 'por mes']]);
  const invalidas = [
    [{ aprovadaEm: '2026-10-01', origem: 'x' }, /item 1/],
    [frase({ texto: '... !' }), /item 1: texto vazio ou só com pontuação/],
    [frase({ texto: 'Outra frase.', aprovadaEm: '01/10/2026' }), /item 1: aprovadaEm/],
    [frase({ texto: 'Outra frase.', aprovadaEm: '2026-02-30' }), /item 1: aprovadaEm/],
    [frase({ texto: 'Outra frase.', aprovadaEm: '2026-10-18' }), /item 1: aprovadaEm no futuro/],
    [frase({ texto: 'Outra frase.', origem: ' ' }), /item 1: origem vazia/],
    [frase({ texto: 'Outra frase.', extra: 1 }), /item 1/],
    [frase({ texto: 'reduzi 12% do custo de obras ficticias' }), /item 1: mesma frase do item 0/],
  ];
  for (const [item, erro] of invalidas) {
    await put('frases-aprovadas.json', { versao: 1, frases: [frase(), item] });
    await assert.rejects(carregarFrasesAprovadas({ dataDir, hoje }), erro, JSON.stringify(item));
  }
  // "R$ 90 mil em contratos." e "r$ 90 mil em contratos" têm a mesma chave.
  await put('frases-aprovadas.json', { versao: 1, frases: [frase({ texto: 'R$ 90 mil em contratos.' }), frase({ texto: 'r$ 90 mil em contratos' })] });
  await assert.rejects(carregarFrasesAprovadas({ dataDir, hoje }), /item 1: mesma frase do item 0/);
  for (const [caractere, ponto] of [['\x1b', 'U+001B'], ['\t', 'U+0009'], ['\r', 'U+000D'], ['‮', 'U+202E'], ['​', 'U+200B'], ['­', 'U+00AD'],
    [' ', 'U+2028'], [' ', 'U+2029']]) {
    for (const campo of ['texto', 'origem']) {
      await put('frases-aprovadas.json', { versao: 1, frases: [frase(), frase({ texto: 'Outra frase.', [campo]: `antes${caractere}depois` })] });
      await assert.rejects(carregarFrasesAprovadas({ dataDir, hoje }),
        new RegExp(`frases-aprovadas\\.json: item 1, campo ${campo}: caractere de controle ${ponto.replace('+', '\\+')}`), `${campo} ${ponto}`);
    }
  }
});

const retrato = (extra = {}) => ({ experiencias: [{ cargo: 'analista de planejamento', empresa: 'alfa ficticia', aliases: ['alfa'] }],
  formacao: [], cursos: ['curso inventado'], idiomas: [], complementos: [], unidadesComSinal: [['reduzi 12% do custo']],
  preparo: {}, proibidasSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', ...extra });
const base = (r = retrato()) => ({ aprovadaEm: '2026-10-01', hash: hashRetrato(r), retrato: r });

test('11.6 bases-aprovadas.json: hash que não confere, texto com controle e arquivo ausente', async t => {
  const { dataDir, put } = await setup(t);
  assert.deepEqual(await carregarBasesAprovadas({ dataDir }), {});
  await put('bases-aprovadas.json', { versao: 1, bases: { base_ficticia: base() } });
  assert.deepEqual(Object.keys(await carregarBasesAprovadas({ dataDir })), ['base_ficticia']);
  // O hash é do JSON com chaves ordenadas: a ordem das chaves no arquivo não muda o resultado.
  const reordenado = Object.fromEntries(Object.entries(retrato()).reverse());
  assert.equal(hashRetrato(reordenado), hashRetrato(retrato()));
  // Retrato editado à mão sem recalcular o hash.
  const editado = base();
  editado.retrato.cursos.push('curso inventado depois');
  await put('bases-aprovadas.json', { versao: 1, bases: { base_ficticia: base(), outra_base: editado } });
  await assert.rejects(carregarBasesAprovadas({ dataDir }), /bases-aprovadas\.json: base "outra_base": o hash não confere/);
  // U+202E num texto do retrato, mesmo com o hash recalculado.
  await put('bases-aprovadas.json', { versao: 1, bases: { base_ficticia: base(retrato({ cursos: ['curso ‮inventado'] })) } });
  await assert.rejects(carregarBasesAprovadas({ dataDir }), /base "base_ficticia", campo retrato\.cursos\[0\]: caractere de controle U\+202E/);
  await put('bases-aprovadas.json', { versao: 1, bases: { base_ficticia: { ...base(), extra: 1 } } });
  await assert.rejects(carregarBasesAprovadas({ dataDir }), /base "base_ficticia" precisa ter só/);
  await put('bases-aprovadas.json', { versao: 1, bases: { base_ficticia: base(retrato({ numeros: [] })) } });
  await assert.rejects(carregarBasesAprovadas({ dataDir }), /retrato precisa ter só/);
});
