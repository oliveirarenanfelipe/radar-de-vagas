import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregarComplementos } from '../src/preparo/contrato.mjs';
import { chaveFrase, partirSecao } from '../src/preparo/frases.mjs';
import { verificar } from '../src/preparo/veracidade.mjs';

// Fixture inventada (docs/spec.md, T12): pessoa "Ana Fictícia", empresas "Alfa Fictícia", "Beta Fictícia" e
// "Nebulosa Ltda", instituições "Instituto Delta Inventado" e "Universidade Gama Inventada".
const ALFA = { cargo: 'Analista de Operações', empresa: 'Alfa Fictícia Ltda.', periodo: 'Mar/2023 – Mar/2026', local: 'Cidade Inventada', aliases: ['Alfa'] };
const BETA = { cargo: 'Coordenador de Obras', empresa: 'Beta Fictícia', periodo: '2018 – 2022', local: 'Cidade Inventada' };
const BACHARELADO = { titulo: 'Bacharelado em Engenharia', instituicao: 'Universidade Gama Inventada', periodo: '2010 – 2014' };
const MESTRADO = { titulo: 'Mestrado em Energia', instituicao: 'Instituto Delta Inventado', periodo: '2015 – 2017' };
const PERFIL_BASE = 'Analista de operações com foco em campo. Reduzo custos em 12% ao ano.';
const TEXTO_BASE = [
  { secao: 'perfil', texto: PERFIL_BASE },
  { secao: 'experiencia', texto: 'Analista de Operações\nAlfa Fictícia Ltda. | Mar/2023 – Mar/2026 | Cidade Inventada\nReduzi perdas em 14% na manutenção\nR$ 120 mil de economia anual.' },
  { secao: 'formacao', texto: 'Bacharelado em Engenharia — Universidade Gama Inventada\nCurso Scrum Master Fictício\nInglês avançado | Espanhol básico' },
];

const fatos = (extra = {}) => ({
  versao: 1, base: 'ana_ficticia', experiencias: [ALFA], formacao: [BACHARELADO], cursos: ['Curso Scrum Master Fictício'],
  idiomas: [{ idioma: 'Inglês', nivel: 'Avançado' }, { idioma: 'Espanhol', nivel: 'Básico' }, { idioma: 'Português', nivel: 'Nativo' }],
  textoLivre: TEXTO_BASE, ...extra,
});
const comTexto = (...textos) => fatos({ textoLivre: [...TEXTO_BASE, ...textos.map(texto => ({ secao: 'experiencia', texto }))] });

// CV declarado com os blocos iguais aos da base; cada seção recebe um texto ou uma lista de itens.
function cv(secoes = {}, base = fatos()) {
  const textoLivre = [];
  for (const [secao, valor] of Object.entries({ titulo: 'Analista de operações', perfil: PERFIL_BASE, ...secoes })) {
    for (const texto of [].concat(valor)) textoLivre.push({ secao, texto });
  }
  return {
    versao: 1, experiencias: base.experiencias.map(({ aliases, ...exp }) => ({ ...exp })),
    formacao: base.formacao.map(item => ({ ...item })), cursos: [...base.cursos], idiomas: base.idiomas.map(item => ({ ...item })), textoLivre,
  };
}
const noPerfil = (frase, { base = fatos(), ...opcoes } = {}) => verificar(cv({ perfil: [PERFIL_BASE, frase] }, base), base, opcoes);
const aprovar = (...textos) => ({ frasesAprovadas: textos.map(texto => ({ texto, aprovadaEm: '2026-10-01', origem: 'variante teste, perfil' })) });
const checagens = resultado => [...new Set(resultado.falhas.map(falha => falha.checagem))].sort();
const novas = resultado => resultado.frasesNovas.map(item => item.frase);
const temSinal = (frase, opcoes) => novas(noPerfil(frase, opcoes)).includes(frase);
const PROIBIDAS = [{ id: 'vinculo-societario-teste', padrao: 'participacao societaria', descricao: 'vínculo societário (lista de teste)' }];
const PROIBIDA = 'participação societária na Alfa Fictícia';
// Os complementos chegam juntados aos fatos por quem chama (spec T12); nos testes, quem junta é o teste.
const juntarComplementos = (base, complementos) => ({
  ...base,
  cursos: [...base.cursos, ...complementos.filter(c => c.tipo === 'curso').map(c => c.texto)],
  idiomas: [...base.idiomas, ...complementos.filter(c => c.tipo === 'idioma').map(({ idioma, nivel }) => ({ idioma, nivel }))],
  formacao: [...base.formacao, ...complementos.filter(c => c.tipo === 'formacao').map(({ titulo, instituicao, periodo }) => ({ titulo, instituicao, periodo }))],
});

test('12.1 CV gerado da base, sem nada plantado, com integral igual ao texto da base: aprovado sem falha', () => {
  const base = fatos();
  const resultado = verificar(cv({ habilidades: ['Planejamento de manutenção', 'Leitura de projetos'],
    integral: base.textoLivre.map(item => item.texto).join('\n') }, base), base, { proibidas: PROIBIDAS });
  assert.deepEqual(resultado, { aprovado: true, falhas: [], frasesNovas: [] });
});

test('local do bloco de experiência tem de ser o da base daquele bloco ("300 obras" no local reprova)', () => {
  const base = fatos();
  const plantado = cv({}, base);
  plantado.experiencias[0].local = 'Cidade Inventada, 300 obras entregues';
  const resultado = verificar(plantado, base);
  assert.equal(resultado.aprovado, false);
  assert.deepEqual(checagens(resultado), ['local']);
  assert.match(resultado.falhas[0].trecho, /300 obras entregues/);
  assert.match(resultado.falhas[0].esperado, /local da base: Cidade Inventada/);
  // Só caixa, acento e espaço diferem: é o mesmo local.
  const igual = cv({}, base);
  igual.experiencias[0].local = '  cidade   INVENTADA ';
  assert.equal(verificar(igual, base).aprovado, true);
});

test('dígito sobrescrito, subscrito ou romano é sinal (Unicode \\p{N}): "¹⁴%" reprova sem aprovação', () => {
  for (const frase of ['Reduzi custos em ¹⁴% ao ano.', 'Atendi H₂ clientes fictícios.', 'Fiz Ⅻ entregas fictícias.']) {
    assert.ok(temSinal(frase), frase);
    const resultado = noPerfil(frase);
    assert.equal(resultado.aprovado, false, frase);
    assert.ok(resultado.falhas.some(falha => falha.checagem === 'frase-nova' && falha.trecho === frase), frase);
    assert.equal(noPerfil(frase, aprovar(frase)).aprovado, true, frase);
  }
});

test('12.2 cargo promovido no bloco de experiência reprova cargo, com o cargo declarado e o da base', () => {
  const base = fatos();
  const declarado = cv({}, base);
  declarado.experiencias[0].cargo = 'Coordenador Sênior';
  const resultado = verificar(declarado, base);
  assert.equal(resultado.aprovado, false);
  assert.deepEqual(checagens(resultado), ['cargo']);
  assert.match(resultado.falhas[0].trecho, /Coordenador Sênior/);
  assert.match(resultado.falhas[0].trecho, /Analista de Operações/);
});

test('12.3 empresa que não está na base reprova empresa', () => {
  const base = fatos();
  const declarado = cv({}, base);
  declarado.experiencias[0].empresa = 'Nebulosa Ltda';
  assert.deepEqual(checagens(verificar(declarado, base)), ['empresa']);
});

test('12.3b empresa pelo nome normalizado e pelo alias; contenção não casa', () => {
  const base = fatos();
  const com = empresa => { const declarado = cv({}, base); declarado.experiencias[0].empresa = empresa; return verificar(declarado, base); };
  for (const empresa of ['ALFA FICTICIA', 'Alfa Ficticia S.A.', 'Alfa']) assert.equal(com(empresa).aprovado, true, empresa);
  assert.deepEqual(checagens(com('Alfa Fictícia Comércio')), ['empresa']);
});

test('12.4 período com início antecipado 1 ano reprova periodo', () => {
  const base = fatos();
  const declarado = cv({}, base);
  declarado.experiencias[0].periodo = 'Mar/2022 – Mar/2026';
  assert.deepEqual(checagens(verificar(declarado, base)), ['periodo']);
});

test('12.5 frase inventada no perfil reprova frase-nova e vai para frasesNovas', () => {
  const frase = 'Reduzi custos em 90% no primeiro ano';
  const resultado = noPerfil(frase);
  assert.equal(resultado.aprovado, false);
  assert.deepEqual(checagens(resultado), ['frase-nova']);
  assert.equal(resultado.falhas[0].trecho, frase);
  assert.equal(resultado.falhas[0].secao, 'perfil');
  assert.deepEqual(resultado.frasesNovas, [{ secao: 'perfil', frase }]);
});

test('12.6 "Mestrado em Gestão" sem mestrado na base reprova formacao e frase-nova', () => {
  assert.deepEqual(checagens(noPerfil('Mestrado em Gestão')), ['formacao', 'frase-nova']);
});

const BASE_DOIS_GRAUS = fatos({ formacao: [MESTRADO, BACHARELADO], textoLivre: [...TEXTO_BASE, { secao: 'formacao', texto: 'Mestrado pelo Instituto Delta Inventado' }] });

test('12.6b grau e instituição conferidos em par, mesmo com a frase aprovada', () => {
  const frase = 'Mestrado pela Universidade Gama Inventada';
  assert.deepEqual(checagens(noPerfil(frase, { base: BASE_DOIS_GRAUS, ...aprovar(frase) })), ['formacao']);
  assert.equal(noPerfil('Mestrado pelo Instituto Delta Inventado', { base: BASE_DOIS_GRAUS }).aprovado, true);
});

test('12.6c par no bloco: título, instituição e período de itens diferentes reprova formacao', () => {
  const declarado = cv({}, BASE_DOIS_GRAUS);
  declarado.formacao = [{ titulo: 'Mestrado em Energia', instituicao: 'Universidade Gama Inventada', periodo: '2015 – 2017' }, { ...BACHARELADO }];
  assert.deepEqual(checagens(verificar(declarado, BASE_DOIS_GRAUS)), ['formacao']);
});

test('12.6d "Curso Scrum Master Fictício" igual à base, sem mestrado: aprova (scrum master não é grau)', () => {
  assert.deepEqual(noPerfil('Curso Scrum Master Fictício'), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('12.7 "certificação PMP" sem curso na base reprova cursos', () => {
  assert.deepEqual(checagens(noPerfil('certificação PMP')), ['cursos', 'frase-nova']);
});

test('12.8 espanhol fluente no perfil com base básico reprova idiomas e frase-nova', () => {
  assert.deepEqual(checagens(noPerfil('Espanhol fluente')), ['frase-nova', 'idiomas']);
});

test('12.8b "fluent Spanish" no título com base Básico reprova idiomas e frase-nova', () => {
  const base = fatos();
  const resultado = verificar(cv({ titulo: 'Fluent Spanish' }, base), base);
  assert.deepEqual(checagens(resultado), ['frase-nova', 'idiomas']);
  assert.ok(resultado.falhas.every(falha => falha.secao === 'titulo'));
});

test('12.8c idiomas no bloco: nível acima, nível abaixo, ausente e nível não reconhecido', () => {
  const base = fatos({ idiomas: [{ idioma: 'Inglês', nivel: 'Avançado' }, { idioma: 'Espanhol', nivel: 'Básico' }] });
  const com = (idioma, nivel) => { const declarado = cv({}, base); declarado.idiomas = [{ idioma, nivel }]; return verificar(declarado, base); };
  const fluente = com('English', 'Fluent');
  assert.deepEqual(checagens(fluente), ['idiomas']);
  assert.match(fluente.falhas[0].esperado, /^nível até "Avançado" \(escala 3\)$/);
  assert.equal(com('Inglês', 'Intermediário').aprovado, true);
  const frances = com('Francês', 'Básico');
  assert.deepEqual(checagens(frances), ['idiomas']);
  assert.equal(frances.falhas[0].esperado, 'idioma presente na base');
  const muitoBom = com('Inglês', 'Muito bom');
  assert.deepEqual(checagens(muitoBom), ['idiomas']);
  assert.match(muitoBom.falhas[0].esperado, /^nível não reconhecido/);
});

test('12.8d pareamento de idioma e nível dentro da frase; a expressão mais longa vence', () => {
  const base = fatos({ idiomas: [{ idioma: 'Inglês', nivel: 'Avançado' }, { idioma: 'Espanhol', nivel: 'Básico' }] });
  const frase = 'espanhol básico e inglês fluente';
  const resultado = noPerfil(frase, { base, ...aprovar(frase) });
  assert.deepEqual(checagens(resultado), ['idiomas']);
  assert.match(resultado.falhas[0].esperado, /ingles/);
  assert.doesNotMatch(resultado.falhas[0].esperado, /espanhol/);
  const completo = fatos({ idiomas: [{ idioma: 'Inglês', nivel: 'Profissional completo' }] });
  assert.equal(noPerfil('Fluent English', { base: completo, ...aprovar('Fluent English') }).aprovado, true);
});

test('12.8e idioma ampliado: nome sozinho é sinal; níveis novos conferidos; sem nível não confere', () => {
  const base = fatos({ idiomas: [{ idioma: 'Espanhol', nivel: 'Básico' }, { idioma: 'Português', nivel: 'Nativo' }] });
  const formas = ['Fluência em espanhol', 'Proficient in Spanish', 'Conversational Spanish', 'Domínio do espanhol', 'Atendimento em espanhol', 'Currículo em português'];
  for (const frase of formas) assert.deepEqual(novas(noPerfil(frase, { base })), [frase], `(A) ${frase}`);
  for (const frase of formas.slice(0, 4)) assert.deepEqual(checagens(noPerfil(frase, { base, ...aprovar(...formas) })), ['idiomas'], `(B) ${frase}`);
  for (const frase of formas.slice(4)) assert.equal(noPerfil(frase, { base, ...aprovar(...formas) }).aprovado, true, `(B) ${frase}`);
});

test('12.9 afirmação proibida da lista de teste reprova proibidas', () => {
  assert.ok(checagens(noPerfil(PROIBIDA, { proibidas: PROIBIDAS })).includes('proibidas'));
});

test('12.9b proibida vence aprovada, vence base e é lida no integral', () => {
  assert.deepEqual(checagens(noPerfil(PROIBIDA, { proibidas: PROIBIDAS, ...aprovar(PROIBIDA) })), ['proibidas']);
  assert.deepEqual(checagens(noPerfil(PROIBIDA, { base: comTexto(PROIBIDA), proibidas: PROIBIDAS })), ['proibidas']);
  const base = fatos();
  const integral = [...base.textoLivre.map(item => item.texto), PROIBIDA].join('\n');
  assert.ok(checagens(verificar(cv({ integral }, base), base, { proibidas: PROIBIDAS })).includes('proibidas'));
});

test('12.10 "gerente na Alfa Fictícia" com base Analista reprova cargo', () => {
  assert.ok(checagens(noPerfil('gerente na Alfa Fictícia')).includes('cargo'));
});

test('12.10b cargo conferido na empresa citada', () => {
  const base = fatos({ experiencias: [ALFA, { ...BETA, cargo: 'Gerente de Contas' }] });
  assert.deepEqual(checagens(noPerfil('gerente na Alfa', { base, ...aprovar('gerente na Alfa') })), ['cargo']);
  assert.equal(noPerfil('gerente na Beta Fictícia', { base, ...aprovar('gerente na Beta Fictícia') }).aprovado, true);
});

test('12.11 ordem e pontuação final não importam; verbo noutro tempo é frase nova; sem sinal fora de unidade passa', () => {
  const base = fatos({ textoLivre: [
    { secao: 'perfil', texto: 'Atuo em campo. Reduzo custos em 12% ao ano. Atendo 40 clientes por mês!' },
    { secao: 'habilidades', texto: 'Leitura de NR-10' }, { secao: 'habilidades', texto: 'Planilhas com 3 níveis' },
  ] });
  const reordenado = cv({ perfil: 'Atendo 40 clientes por mês.\nReduzo custos em 12% ao ano!', habilidades: ['Planilhas com 3 níveis.', 'Leitura de NR-10'] }, base);
  assert.deepEqual(verificar(reordenado, base), { aprovado: true, falhas: [], frasesNovas: [] });
  const outroTempo = verificar(cv({ perfil: 'Reduzi custos em 12% ao ano.' }, base), base);
  assert.deepEqual(checagens(outroTempo), ['frase-nova']);
  const semSinal = verificar(cv({ perfil: 'Atuei em campo\nTrabalhei em campo. Reduzo custos em 12% ao ano.' }, base), base);
  assert.equal(semSinal.aprovado, true);
});

test('12.12 complemento de curso juntado aos fatos libera cursos; sem ele, só cursos reprova', () => {
  const frase = 'certificação Inventada X';
  const complemento = { tipo: 'curso', texto: 'Certificação Inventada X',
    fonte: { tipo: 'registro-de-plataforma', referencia: 'tela da plataforma Inventada, perfil da Ana', data: '2026-09-01' } };
  const opcoes = { preparo: { certificacoesExtras: ['inventada x'] }, ...aprovar(frase) };
  const base = fatos();
  const declarado = cv({ perfil: [PERFIL_BASE, frase] }, base);
  assert.equal(verificar(declarado, juntarComplementos(base, [complemento]), opcoes).aprovado, true);
  assert.deepEqual(checagens(verificar(declarado, base, opcoes)), ['cursos']);
});

test('12.13 mesmo número noutra frase é frase nova', () => {
  const base = comTexto('31 turbinas em operação', '61% de redução de custo');
  const resultado = verificar(cv({ perfil: [PERFIL_BASE, '31 parques em operação', '61% de crescimento de receita'] }, base), base);
  assert.deepEqual(novas(resultado), ['31 parques em operação', '61% de crescimento de receita']);
  assert.equal(verificar(cv({ perfil: [PERFIL_BASE, '31 turbinas em operação', '61% de redução de custo'] }, base), base).aprovado, true);
});

test('12.14 complemento com fonte circular ou tipo de fonte inválido é erro de carga com o índice', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-veracidade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const carregar = async (fonte, preparo) => {
    await writeFile(join(dataDir, 'fatos-complementares.json'), JSON.stringify([{ tipo: 'curso', texto: 'Curso Inventado', fonte: { data: '2026-09-01', ...fonte } }]));
    return carregarComplementos({ dataDir, preparo });
  };
  await assert.rejects(carregar({ tipo: 'cv', referencia: 'o próprio CV' }), /item 0/);
  await assert.rejects(carregar({ tipo: 'comprovante', referencia: 'CV_Ana_Ficticia.pdf' }), /item 0.*cv\|resume/);
  await assert.rejects(carregar({ tipo: 'comprovante', referencia: 'pendencias da Ana, linha 12' }, { fontesCirculares: ['pendencias'] }), /item 0.*"pendencias"/);
  assert.equal((await carregar({ tipo: 'comprovante', referencia: 'contrato assinado com a Alfa Fictícia' })).length, 1);
});

test('12.15 forma do número: só a pontuação final pode mudar', () => {
  assert.equal(noPerfil('R$ 120 mil de economia anual').aprovado, true);
  for (const frase of ['R$120k de economia anual', 'R$ 120 mil de faturamento anual']) assert.deepEqual(novas(noPerfil(frase)), [frase]);
});

test('12.16 frase aprovada casa por igualdade, nunca por semelhança', () => {
  const opcoes = aprovar('Operação de 31 turbinas com equipe própria');
  assert.equal(noPerfil('Operação de 31 turbinas com equipe própria', opcoes).aprovado, true);
  assert.deepEqual(checagens(noPerfil('Operação de 32 turbinas com equipe própria', opcoes)), ['frase-nova']);
});

test('12.17 dígito em sigla é sinal: fora da base reprova, presente na base aprova', () => {
  const frases = ['Implantação de NR-35, S/4HANA e B2B', 'Indústria 4.0 na prática'];
  for (const frase of frases) {
    assert.deepEqual(novas(noPerfil(frase)), [frase]);
    assert.equal(noPerfil(frase, { base: comTexto(...frases) }).aprovado, true);
  }
});

test('12.18 "Diretor de Operações" no título sem diretor na base reprova cargo e frase-nova', () => {
  const base = fatos();
  assert.deepEqual(checagens(verificar(cv({ titulo: 'Diretor de Operações' }, base), base)), ['cargo', 'frase-nova']);
});

test('12.19 contenção não casa', () => {
  const base = comTexto('R$90k/mês em contratos');
  assert.equal(noPerfil('R$90k/mês em contratos', { base }).aprovado, true);
  for (const frase of ['R$90k/mês em contratos novos', 'R$90k/dia em contratos']) assert.deepEqual(novas(noPerfil(frase, { base })), [frase]);
});

test('12.20 caixa e ponto final passam; outro número na fração reprova', () => {
  const base = comTexto('rede de 11,4/22 kV');
  assert.equal(noPerfil('Rede de 11,4/22 kV.', { base }).aprovado, true);
  assert.deepEqual(checagens(noPerfil('rede de 11,4/69 kV', { base })), ['frase-nova']);
});

test('12.21 título de outra pessoa é exceção; fundador como cargo próprio reprova; "da Gerente" não é exceção', () => {
  const base = fatos();
  const titulos = ['Braço direito da fundadora fictícia', 'Hands-on Operations Founder'];
  const opcoes = { ...aprovar(...titulos, 'na função da Gerente'), proibidas: [{ id: 'fundador-teste', padrao: 'founder', descricao: 'lista de teste' }] };
  assert.equal(verificar(cv({ titulo: titulos[0] }, base), base, opcoes).aprovado, true);
  assert.deepEqual(checagens(verificar(cv({ titulo: titulos[1] }, base), base, opcoes)), ['cargo', 'proibidas']);
  assert.deepEqual(checagens(noPerfil('na função da Gerente', opcoes)), ['cargo']);
});

test('12.22 pontuação interna conta', () => {
  const base = comTexto('1.000 atendimentos por mês.');
  assert.equal(noPerfil('1.000 atendimentos por mês', { base }).aprovado, true);
  for (const frase of ['1.000 atendimentos, por mês', '1000 atendimentos por mês']) assert.deepEqual(novas(noPerfil(frase, { base })), [frase]);
});

test('12.23 a seção da base não importa: frase da experiência no meio de um parágrafo do perfil', () => {
  const base = fatos();
  const perfil = 'Atuo com foco em campo. Reduzi perdas em 14% na manutenção. Reduzo custos em 12% ao ano.';
  assert.deepEqual(verificar(cv({ perfil }, base), base), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('12.24 empresa da base e empresa extra são sinal', () => {
  assert.deepEqual(novas(noPerfil('Projetos para a Alfa Fictícia')), ['Projetos para a Alfa Fictícia']);
  const extra = { preparo: { empresasExtras: ['Orion Inventada S.A.'] } };
  assert.deepEqual(novas(noPerfil('Projetos para a Orion Inventada', extra)), ['Projetos para a Orion Inventada']);
});

test('12.25 ano é dígito', () => {
  const frase = 'atuo com indicadores desde 2011';
  assert.deepEqual(checagens(noPerfil(frase)), ['frase-nova']);
  assert.equal(noPerfil(frase, { base: comTexto(frase) }).aprovado, true);
});

test('12.26 limite declarado: empresa fora da base sem hierarquia passa; com termo de pessoa reprova cargo', () => {
  assert.deepEqual(noPerfil('projetos para a Orion Inventada'), { aprovado: true, falhas: [], frasesNovas: [] });
  assert.deepEqual(checagens(noPerfil('gerente na Orion Inventada')), ['cargo', 'frase-nova']);
});

test('12.27 termos de hierarquia como palavra inteira', () => {
  const base = fatos();
  for (const titulo of ['Líder de Operações', 'Operations Lead']) {
    assert.ok(checagens(verificar(cv({ titulo }, base), base)).includes('cargo'), titulo);
  }
  assert.deepEqual(noPerfil('liderança de equipes de campo'), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('12.28 exceções fechadas de cargo, com as frases aprovadas', () => {
  const passam = ['Redução de lead time em compras', 'Dono do processo de compras', 'Advisor to the Founder', 'Apoio direto à fundadora'];
  const reprovam = ['Sou a fundadora', 'I am the founder', 'Dona da Alfa Fictícia'];
  const opcoes = aprovar(...passam, ...reprovam);
  for (const frase of passam) assert.equal(noPerfil(frase, opcoes).aprovado, true, frase);
  for (const frase of reprovam) assert.deepEqual(checagens(noPerfil(frase, opcoes)), ['cargo'], frase);
});

test('12.29 partição: quebra de linha, separadores, marcador e ponto', () => {
  const textoLivre = [
    { secao: 'perfil', texto: 'Atuo em campo. Reduzi 12% do custo; entreguei 3 obras' },
    { secao: 'perfil', texto: '- Equipe de 8\n• 1.000 visitas | 2) Sr. Silva aprovou' },
  ];
  assert.deepEqual(partirSecao(textoLivre, 'perfil').flat().map(chaveFrase),
    ['atuo em campo', 'reduzi 12% do custo', 'entreguei 3 obras', 'equipe de 8', '1.000 visitas', 'sr', 'silva aprovou']);
  assert.deepEqual(partirSecao(textoLivre, 'perfil').flat(),
    ['Atuo em campo.', 'Reduzi 12% do custo', 'entreguei 3 obras', 'Equipe de 8', '1.000 visitas', 'Sr.', 'Silva aprovou']);
});

test('12.29b marcador sai antes do corte por ponto; ano não é marcador', () => {
  const perfil = '1. Reduzi custos em 12%\n2) Entreguei 3 obras\n12. Atendi 40 clientes\n2024. Ano de 9 entregas';
  assert.deepEqual(partirSecao([{ secao: 'perfil', texto: perfil }], 'perfil').flat().map(chaveFrase),
    ['reduzi custos em 12%', 'entreguei 3 obras', 'atendi 40 clientes', '2024', 'ano de 9 entregas']);
  const base = comTexto('Reduzi custos em 12%');
  const resultado = verificar(cv({ perfil: [PERFIL_BASE, perfil] }, base), base);
  assert.ok(!novas(resultado).some(frase => chaveFrase(frase) === 'reduzi custos em 12%'));
  assert.ok(novas(resultado).includes('Entreguei 3 obras'));
});

test('12.30 sinal, frase a frase', () => {
  const sim = ['Equipe de 8', 'Gerentes regionais', 'Diretora comercial', 'VP de vendas', 'sócia da operação', 'partner sênior',
    'MSc em energia', 'MBA executivo', 'pós-graduação em dados', 'pós em logística', 'Doctoral research', 'Postgraduate degree',
    'Post-graduate in Finance', 'Specialization in BI', 'AWS Certified Solutions Architect', 'Certificação ágil',
    'certificate in analytics', 'inglês fluente', 'Projetos com a Alfa Fictícia', 'Parceria com a Universidade Gama Inventada',
    'lead time menor', 'Co-founder', 'Dobrei a carteira', 'três obras simultâneas', 'metade do prazo', 'twice the volume',
    'hundreds of visits', 'Diretoria comercial', 'Reporte à diretoria', 'Board member', 'Chairman', 'Compliance Officer',
    'Coordenação de obras', 'Management team', 'Leadership', 'Analista Sênior', 'Engenheiro pleno', 'Staff engineer',
    'atendimento em inglês', 'Currículo em português', 'Formado em Direito', 'Law degree', 'MEng in Energy',
    'Licenciatura em Física', 'Tecnólogo em Redes'];
  const nao = ['liderança de equipes', 'pós-venda estruturado', 'projetos para a Orion Inventada', 'gestão de compras',
    'uma obra por vez', 'onboarding de clientes', 'atendimento em libras'];
  for (const frase of sim) assert.equal(temSinal(frase), true, `sim: ${frase}`);
  for (const frase of nao) assert.equal(temSinal(frase), false, `não: ${frase}`);
});

test('12.31 limite declarado: frase nova sem sinal passa', () => {
  assert.deepEqual(noPerfil('Comunicação clara com equipes de campo'), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('12.32 seção integral: frase da experiência alterada, proibida e cargo do texto livre que não roda', () => {
  const base = fatos();
  const integral = base.textoLivre.map(item => item.texto).join('\n');
  const alterado = verificar(cv({ integral: integral.replace('14%', '41%') }, base), base);
  assert.deepEqual(alterado.falhas.map(({ checagem, secao, trecho }) => ({ checagem, secao, trecho })),
    [{ checagem: 'frase-nova', secao: 'integral', trecho: 'Reduzi perdas em 41% na manutenção' }]);
  assert.ok(checagens(verificar(cv({ integral: `${integral}\n${PROIBIDA}` }, base), base, { proibidas: PROIBIDAS })).includes('proibidas'));
  const comDiretor = comTexto('Atendimento direto do diretor financeiro');
  const integralDiretor = comDiretor.textoLivre.map(item => item.texto).join('\n');
  assert.equal(verificar(cv({ integral: integralDiretor }, comDiretor), comDiretor).aprovado, true);
});

test('12.33 texto da Gupy passa pela regra de frase', () => {
  const base = fatos();
  const nova = verificar(cv({ gupy: 'Liderei 12 obras em 2024' }, base), base);
  assert.deepEqual(nova.falhas.map(({ checagem, secao }) => ({ checagem, secao })), [{ checagem: 'frase-nova', secao: 'gupy' }]);
  const conhecida = verificar(cv({ gupy: 'Reduzo custos em 12% ao ano. Operação de 31 turbinas com equipe própria.' }, base), base,
    aprovar('Operação de 31 turbinas com equipe própria'));
  assert.equal(conhecida.aprovado, true);
});

test('12.34 a mesma frase nova no perfil e no integral dá uma falha só, com a seção perfil', () => {
  const base = fatos();
  const frase = 'Reduzi custos em 90% no primeiro ano';
  const integral = [...base.textoLivre.map(item => item.texto), frase].join('\n');
  const resultado = verificar(cv({ perfil: [PERFIL_BASE, frase], integral }, base), base);
  assert.deepEqual(resultado.falhas.map(({ checagem, secao }) => ({ checagem, secao })), [{ checagem: 'frase-nova', secao: 'perfil' }]);
  assert.deepEqual(resultado.frasesNovas, [{ secao: 'perfil', frase }]);
});

test('12.35 aprovação não desmente a base: cargo continua valendo', () => {
  assert.deepEqual(checagens(noPerfil('Diretor de Operações', aprovar('Diretor de Operações'))), ['cargo']);
});

test('12.36 grau ampliado, uma forma por linha: doutorado e especialização ausentes da base', () => {
  for (const frase of ['Doctorate in Applied Physics', 'Doctoral research in grid stability', 'Postgraduate degree in Data',
    'Post graduate studies in BI', 'Post-graduate in Finance', 'Specialization in Data Engineering']) {
    assert.deepEqual(checagens(noPerfil(frase)), ['formacao', 'frase-nova'], frase);
  }
});

test('12.36b a classe mais longa vence: pós-graduação é especialização, não bacharelado', () => {
  const frases = ['Pós-graduação em Dados', 'Post graduate in Data', 'Pós-doutorado em Física'];
  for (const frase of frases) assert.deepEqual(checagens(noPerfil(frase, aprovar(...frases))), ['formacao'], frase);
  const especializacao = fatos({ formacao: [{ titulo: 'Especialização em Dados', instituicao: 'Instituto Delta Inventado', periodo: '2015 – 2016' }] });
  assert.equal(noPerfil('Pós-graduação em Dados', { base: especializacao, ...aprovar('Pós-graduação em Dados') }).aprovado, true);
});

test('12.36c grau ampliado: genérico, abreviações em inglês, licenciatura e tecnólogo', () => {
  const formas = ['Formado em Direito', 'Formada em Direito', 'Graduado em Direito', 'Graduada em Direito', 'Graduated in Law',
    'Law degree', 'MEng in Energy', 'BEng in Energy', 'BSc in Physics', 'BA in Economics', 'Licenciatura em Física',
    'Licenciado em Física', 'Tecnólogo em Redes'];
  for (const frase of formas) assert.ok(checagens(noPerfil(frase)).includes('frase-nova'), `(A) ${frase}`);
  const reprovam = ['MEng in Energy', 'Licenciatura em Física', 'Licenciado em Física', 'Tecnólogo em Redes'];
  for (const frase of formas) {
    const resultado = noPerfil(frase, aprovar(...formas));
    if (reprovam.includes(frase)) assert.deepEqual(checagens(resultado), ['formacao'], `(B) ${frase}`);
    else assert.equal(resultado.aprovado, true, `(B) ${frase}`);
  }
  const soMestrado = fatos({ formacao: [MESTRADO] });
  for (const frase of ['Law degree', "Master's degree in Energy"]) {
    assert.equal(noPerfil(frase, { base: soMestrado, ...aprovar('Law degree', "Master's degree in Energy") }).aprovado, true, `(C) ${frase}`);
  }
  assert.deepEqual(checagens(noPerfil('Formado em Direito', { base: fatos({ formacao: [] }), ...aprovar('Formado em Direito') })), ['formacao']);
});

test('12.37 certificação é sinal; nomes das listas conferidos em cursos', () => {
  const formas = ['AWS Certified Solutions Architect', 'Certificação PMP', 'Certificado em Gestão Ágil', 'Profissional certificada em ITIL',
    'Certification in Cloud Security', 'Certificate in Data Analytics', 'Lean Six Sigma Green Belt'];
  const comCursos = ['Certificação PMP', 'Profissional certificada em ITIL', 'Lean Six Sigma Green Belt'];
  for (const frase of formas) {
    assert.deepEqual(checagens(noPerfil(frase)), comCursos.includes(frase) ? ['cursos', 'frase-nova'] : ['frase-nova'], frase);
  }
  const controle = noPerfil('AWS Certified Solutions Architect', { preparo: { certificacoesExtras: ['AWS Certified Solutions Architect'] },
    ...aprovar('AWS Certified Solutions Architect') });
  assert.deepEqual(checagens(controle), ['cursos']);
});

test('12.38 quantidade por extenso é sinal; "uma" não é', () => {
  const formas = ['Dobrei a carteira de clientes', 'Reduzi o prazo pela metade', 'Entreguei três obras simultâneas',
    'Mil visitas técnicas por ano', 'Triplicamos o faturamento', 'Cut field costs in half', 'Grew the backlog twice over',
    'Hundreds of site visits', 'Dozens of field teams'];
  for (const frase of formas) assert.deepEqual(novas(noPerfil(frase)), [frase], frase);
  assert.equal(noPerfil(formas[0], { base: comTexto(formas[0]) }).aprovado, true);
  assert.deepEqual(noPerfil('Atendi uma obra por vez'), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('12.39 coletivo é só sinal; termo de pessoa é cargo', () => {
  const base = fatos({ experiencias: [ALFA, BETA] });
  const coletivos = ['Diretoria de Operações', 'Gerência regional de vendas', 'Chefia de equipe de campo', 'Supervisão de turno',
    'Membro do conselho consultivo', 'Board member', 'Coordenação de obras', 'Reporte à diretoria', 'Apresentações ao conselho',
    'Presented to the board', 'A diretoria passou a usar o painel', 'The board came to approve the plan',
    'Management team review', 'Leadership program'];
  for (const frase of coletivos) assert.equal(noPerfil(frase, { base, ...aprovar(...coletivos) }).aprovado, true, `(A) ${frase}`);
  for (const frase of coletivos) assert.deepEqual(checagens(noPerfil(frase, { base })), ['frase-nova'], `(B) ${frase}`);
  const pessoas = ['Diretor de Operações', 'Gerente regional de vendas', 'Conselheiro consultivo', 'Chairman of the advisory group',
    'Compliance Officer', 'Coordenador de obras', 'Reporte ao diretor financeiro'];
  for (const frase of pessoas.slice(0, 5)) assert.deepEqual(checagens(noPerfil(frase, { base, ...aprovar(...pessoas) })), ['cargo'], `(C) ${frase}`);
  for (const frase of pessoas.slice(5)) assert.equal(noPerfil(frase, { base, ...aprovar(...pessoas) }).aprovado, true, `(C) ${frase}`);
});

test('12.40 unidade colada: frase com sinal e as sem sinal logo depois, na mesma linha', () => {
  const base = fatos({ textoLivre: [{ secao: 'perfil', texto: PERFIL_BASE },
    { secao: 'experiencia', texto: 'R$ 120 mil de economia anual.\nReduzi perdas em 14% na manutenção. Com equipe própria.' }] });
  const A = 'R$ 120 mil de economia anual. Por cliente.';
  const B = 'R$ 120 mil de economia anual. Por cliente. Em contratos novos.';
  const rodar = (perfil, opcoes) => verificar(cv({ perfil: [PERFIL_BASE, ...[].concat(perfil)] }, base), base, opcoes);
  for (const unidade of [A, B]) {
    const resultado = rodar(unidade);
    assert.deepEqual(resultado.falhas.map(({ checagem, trecho }) => ({ checagem, trecho })), [{ checagem: 'frase-nova', trecho: unidade }]);
    assert.deepEqual(novas(resultado), [unidade]);
  }
  assert.equal(rodar(['R$ 120 mil de economia anual.', 'Por cliente.']).aprovado, true, '(C)');
  assert.equal(rodar('Estimativa interna. R$ 120 mil de economia anual.').aprovado, true, '(D)');
  assert.deepEqual(checagens(rodar('Reduzi perdas em 14% na manutenção.')), ['frase-nova'], '(E)');
  assert.equal(rodar('Reduzi perdas em 14% na manutenção. Com equipe própria.').aprovado, true, '(F)');
  assert.equal(rodar(A, aprovar(A)).aprovado, true, '(A) aprovada');
  assert.deepEqual(checagens(rodar(B, aprovar(A))), ['frase-nova'], '(B) com (A) aprovada');
});

test('12.41 senioridade é só sinal', () => {
  const formas = ['Analista Sênior de dados', 'Analista Sr de dados', 'Engenheiro pleno', 'Analista Júnior', 'Jr developer',
    'Principal engineer', 'Staff engineer', 'Especialista em dados'];
  for (const frase of formas) assert.deepEqual(checagens(noPerfil(frase)), ['frase-nova'], `(A) ${frase}`);
  for (const frase of formas) assert.equal(noPerfil(frase, aprovar(...formas)).aprovado, true, `(B) ${frase}`);
});

test('verificar recusa entrada fora do contrato, nunca aprova por omissão', () => {
  const base = fatos();
  assert.throws(() => verificar({ ...cv({}, base), textoLivre: [] }, base), /declarado sem título\/perfil/);
  assert.throws(() => verificar(cv({}, base), { ...base, idioma: 'pt' }), /campo desconhecido nos fatos/);
});
