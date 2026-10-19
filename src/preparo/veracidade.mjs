// Veracidade bloqueante do preparo (docs/spec.md §3, T12): confere o CV declarado contra os fatos da base.
// Função pura: não lê nem grava arquivo. Os complementos chegam já juntados aos fatos por quem chama (T17).
// Partição, chave de frase e normalizações vêm de frases.mjs (T11); aqui nada disso é reimplementado.
import { chaveDeEntrada, validarDeclarado, validarFatos } from './contrato.mjs';
import { chaveFrase, normalizarEmpresa, normalizarPeriodo, normalizarTexto, partirLinhas, partirSecao } from './frases.mjs';

const lista = texto => texto.trim().split(/\s+/);

// Ordem das seções: falha repetida (mesma checagem, mesma chave) fica só com a 1ª.
const ORDEM = ['titulo', 'perfil', 'habilidades', 'gupy', 'integral'];

// Item 3: quantidade por extenso (lista fechada; sem "um", "uma", "one" e ordinais, PREMISSA S11).
const QUANTIDADE = new Set(lista(`
  dois duas tres quatro cinco seis sete oito nove dez onze doze treze catorze quatorze quinze dezesseis dezessete dezoito
  dezenove vinte trinta quarenta cinquenta sessenta setenta oitenta noventa cem cento centena centenas dezena dezenas
  duzentos duzentas trezentos trezentas quinhentos quinhentas mil milhar milhares milhao milhoes bilhao bilhoes dobro dobra
  dobrar dobrei dobrou dobramos dobrado dobrada duplicar duplicou duplicamos duplicado duplicada triplo tripla triplicar
  triplicou triplicamos triplicado triplicada quadruplo quadruplicou metade terco tercos
  two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred
  hundreds thousand thousands million millions billion billions dozen dozens double doubled doubling triple tripled tripling
  quadruple quadrupled half halved halving twice threefold twofold tenfold`));

// Item 3: termos de pessoa (afirmam cargo). Cada string é um grupo: as formas juntas são o mesmo termo (item 5).
const GRUPOS_PESSOA = [
  'diretor diretora diretores diretoras', 'gerente gerentes', 'gestor gestora gestores gestoras', 'lider lideres',
  'chefe chefes', 'head heads', 'lead', 'coordenador coordenadora coordenadores coordenadoras',
  'supervisor supervisora supervisores supervisoras', 'superintendente superintendentes',
  'executivo executiva executivos executivas', 'ceo', 'coo', 'cto', 'cfo', 'cio', 'presidente presidentes', 'vice', 'vp',
  'fundador fundadora fundadores fundadoras', 'cofundador cofundadora cofundadores cofundadoras', 'dono dona donos donas',
  'proprietario proprietaria proprietarios proprietarias', 'socio socia socios socias',
  'conselheiro conselheira conselheiros conselheiras', 'partner partners', 'director directors', 'manager managers',
  'leader leaders', 'chief', 'superintendent superintendents', 'executive executives', 'coordinator coordinators',
  'president presidents', 'founder founders', 'cofounder cofounders', 'owner owners',
  'chair chairs chairman chairmen chairwoman chairperson', 'officer officers',
].map(grupo => lista(grupo).map(termo => [termo]));

// Item 3: coletivos de função e senioridade são só sinal, nunca checagem `cargo`.
const COLETIVOS = new Set(lista(`diretoria diretorias gerencia gerencias coordenacao coordenacoes chefia chefias supervisao
  conselho conselhos board boards management leadership`));
const SENIORIDADE = new Set(lista('senior sr pleno junior jr principal staff especialista'));

// Casamento de expressões: em cada posição, da esquerda para a direita, vence a de mais palavras.
const dicionario = pares => pares.map(([termo, valor]) => ({ seq: lista(termo), valor }))
  .sort((a, b) => b.seq.length - a.seq.length);
const classe = (valor, termos) => termos.split(',').map(termo => [termo, valor]);

// Item 7: classes de grau. "scrum master" é exceção fechada: consome as duas palavras e não é grau.
const GRAU = dicionario([
  ...classe('mestrado', 'mestre,mestra,mestrado,mestrando,mestranda,master,masters,msc,m sc,meng,m eng'),
  ...classe('doutorado', 'doutor,doutora,doutorado,doutorando,doutoranda,doctorate,doctoral,phd,ph d,pos doutorado'),
  ...classe('bacharelado', 'bacharel,bacharelado,bachelor,bsc,b sc,beng,b eng,ba,b a,graduacao'),
  ...classe('licenciatura', 'licenciatura,licenciado,licenciada'),
  ...classe('tecnologo', 'tecnologo,tecnologa'),
  ...classe('mba', 'mba'),
  ...classe('especializacao', 'especializacao,specialization,pos graduacao,pos graduado,pos graduada,pos em,postgraduate,post graduate'),
  ...classe('generico', 'formado,formada,graduado,graduada,graduated,degree'),
  ['scrum master', null],
]);

// Item 3 e 8: certificação, pelo termo genérico ou pelo nome da lista do núcleo.
const CERT_GENERICOS = new Set(lista(`certificacao certificacoes certificado certificados certificada certificadas certified
  certification certifications certificate certificates`));
const CERT_NUCLEO = ['pmp', 'capm', 'psm', 'csm', 'scrum master', 'itil', 'cobit', 'white belt', 'green belt',
  'yellow belt', 'black belt', 'pmi acp', 'cpa 10', 'cpa 20'];

// Item 8: idiomas com equivalência PT/EN (palavra → grupo) e escala de nível (a expressão mais longa vence).
const IDIOMAS = new Map(['portugues portuguese', 'ingles english', 'espanhol spanish', 'frances french', 'alemao german',
  'italiano italian', 'mandarim chines mandarin chinese', 'japones japanese', 'russo russian', 'coreano korean',
  'arabe arabic', 'holandes dutch'].flatMap(grupo => lista(grupo).map(nome => [nome, lista(grupo)[0]])));
const ESCALA = dicionario([
  ...classe(1, 'basico,elementar,basic,elementary,beginner,a1,a2'),
  ...classe(2, 'intermediario,intermediate,limitado,limited working,conversacao,conversational,b1'),
  ...classe(3, 'avancado,advanced,profissional,professional,professional working,b2'),
  ...classe(4, 'fluente,fluent,fluencia,fluency,proficiente,proficiencia,proficient,proficiency,dominio,profissional completo,full professional,c1,c2'),
  ...classe(5, 'nativo,native,bilingue,bilingual'),
]);

// Item 5 (i): o termo vem logo depois destes tokens, lidos em minúsculas com acento ("à" não é "a").
const OUTRA_PESSOA = [
  'braço direito do', 'braço direito da', 'assessor do', 'assessor da', 'assessora do', 'assessora da',
  'right hand to', 'right hand to the', 'ao', 'aos', 'à', 'às', 'para o', 'para a', 'para os', 'para as',
  'com o', 'com a', 'com os', 'com as', 'junto ao', 'junto à', 'to the', 'with the', 'for the',
].map(lista);

/** Palavras do texto: sequências de [a-z0-9] do texto normalizado, cada uma com o token de origem (minúsculo, com acento). */
function palavras(texto) {
  const saida = [];
  for (const [bruto] of String(texto ?? '').normalize('NFC').toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const semAcento = bruto.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC');
    for (const [palavra] of semAcento.matchAll(/[a-z0-9]+/g)) saida.push({ palavra, bruto });
  }
  return saida;
}
const so = texto => palavras(texto).map(item => item.palavra);

const casaEm = (ws, seq, i) => seq.length > 0 && seq.every((palavra, k) => ws[i + k] === palavra);
const contem = (ws, seq) => ws.some((_, i) => casaEm(ws, seq, i));

function varrer(ws, termos) {
  const achados = [];
  for (let i = 0; i < ws.length;) {
    const termo = termos.find(item => casaEm(ws, item.seq, i));
    if (!termo) { i += 1; continue; }
    achados.push({ inicio: i, fim: i + termo.seq.length - 1, valor: termo.valor });
    i += termo.seq.length;
  }
  return achados;
}

const nivelDe = texto => {
  const niveis = varrer(so(texto), ESCALA).map(item => item.valor);
  return niveis.length ? Math.max(...niveis) : null;
};
const grupoIdioma = texto => {
  const nome = so(texto).find(palavra => IDIOMAS.has(palavra));
  return nome ? IDIOMAS.get(nome) : `outro:${normalizarTexto(texto)}`;
};
function periodoOuNulo(texto) {
  try { return normalizarPeriodo(texto); } catch { return null; }
}
const mesmoPeriodo = (a, b) => Boolean(a && b) && a.inicio === b.inicio && a.fim === b.fim;
const palavrasDeEmpresa = nome => so(normalizarEmpresa(nome));

// Tudo que a veracidade usa da base, calculado uma vez.
function contexto(fatos, preparo) {
  const experiencias = fatos.experiencias.map(exp => {
    const nomes = [exp.empresa, ...(exp.aliases ?? [])];
    return { ...exp, chave: normalizarEmpresa(exp.empresa), chaves: nomes.map(normalizarEmpresa),
      nomes: nomes.map(palavrasDeEmpresa).filter(seq => seq.length), cargoPalavras: so(exp.cargo) };
  });
  const formacao = fatos.formacao.map(item => ({ ...item, nomes: [palavrasDeEmpresa(item.instituicao)].filter(seq => seq.length),
    classes: new Set(varrer(so(item.titulo), GRAU).map(t => t.valor).filter(Boolean)) }));
  const extras = (preparo.empresasExtras ?? []).map(palavrasDeEmpresa).filter(seq => seq.length);
  return {
    experiencias, formacao, extras,
    grupos: [...GRUPOS_PESSOA, ...(preparo.termosHierarquia ?? []).map(so).filter(seq => seq.length).map(seq => [seq])],
    certificacoes: [...CERT_NUCLEO, ...(preparo.certificacoesExtras ?? [])].map(so).filter(seq => seq.length),
    empresas: [...experiencias.flatMap(exp => exp.nomes), ...formacao.flatMap(item => item.nomes), ...extras],
    cursos: fatos.cursos.map(curso => ({ texto: curso, palavras: so(curso) })),
    idiomas: fatos.idiomas.map(item => ({ ...item, grupo: grupoIdioma(item.idioma), nivelNum: nivelDe(item.nivel) })),
  };
}

/** Item 3: a frase tem sinal quando tem ao menos uma das sete categorias. */
function temSinal(frase, ctx) {
  const ws = so(frase);
  if (/\p{N}/u.test(frase)) return true; // dígito: qualquer número Unicode (Nd, Nl, No), inclusive "¹⁴" sobrescrito
  if (ws.some(p => QUANTIDADE.has(p))) return true; // quantidade por extenso
  if (ctx.grupos.some(grupo => grupo.some(seq => contem(ws, seq)))) return true; // hierarquia: termo de pessoa
  if (ws.some(p => COLETIVOS.has(p))) return true; // hierarquia: coletivo de função
  if (ws.some(p => SENIORIDADE.has(p))) return true; // hierarquia: senioridade
  if (varrer(ws, GRAU).some(t => t.valor)) return true; // grau
  if (ws.some(p => CERT_GENERICOS.has(p)) || ctx.certificacoes.some(seq => contem(ws, seq))) return true; // certificação
  if (ws.some(p => IDIOMAS.has(p))) return true; // idioma
  if (ctx.empresas.some(seq => contem(ws, seq))) return true; // empresa ou instituição
  return false;
}

// Texto da unidade: as frases unidas de modo que partir de novo dê as mesmas chaves (a aprovação usa esta chave).
const juntar = frases => frases.reduce((texto, frase) => (texto ? `${texto}${/[.!?]$/.test(texto) ? ' ' : '; '}${frase}` : frase), '');

/** Item 2b: cada frase com sinal abre uma unidade; as sem sinal logo depois, na mesma linha, entram nela. */
function unidades(linhas, ctx) {
  const saida = [];
  for (const linha of linhas) {
    let atual = null;
    for (const frase of linha) {
      if (temSinal(frase, ctx)) { atual = [frase]; saida.push(atual); }
      else if (atual) atual.push(frase);
    }
  }
  return saida.map(frases => ({ texto: juntar(frases), chave: JSON.stringify(frases.map(chaveFrase)) }));
}

// Item 5, exceções (i) a (iii): o termo na posição i não é afirmação de cargo próprio.
function excecaoDeCargo(ws, i, termo, ctx) {
  const antes = ws.slice(0, i).map(item => item.bruto);
  if (OUTRA_PESSOA.some(seq => seq.length <= antes.length && seq.every((t, k) => antes[antes.length - seq.length + k] === t))) return true;
  const depois = ws.slice(i + termo.length).map(item => item.palavra);
  if (termo.join(' ') === 'lead' && depois[0] === 'time') return true;
  if (['dono', 'dona', 'owner'].includes(termo.join(' '))) {
    const pula = ['do', 'da', 'dos', 'das'].includes(depois[0]) ? 1 : depois[0] === 'of' ? (depois[1] === 'the' ? 2 : 1) : 0;
    if (pula) {
      const complemento = depois.slice(pula);
      const empresas = [...ctx.experiencias.flatMap(exp => exp.nomes), ...ctx.extras];
      if (!empresas.some(seq => casaEm(complemento, seq, 0))) return true;
    }
  }
  return false;
}

/** Item 5, texto livre: termos de pessoa da frase que não existem num cargo da base (da empresa citada, se houver). */
function cargosSemBase(frase, ctx) {
  const ws = palavras(frase);
  const nus = ws.map(item => item.palavra);
  const citadas = new Set(ctx.experiencias.filter(exp => exp.nomes.some(seq => contem(nus, seq))).map(exp => exp.chave));
  const cargos = ctx.experiencias.filter(exp => !citadas.size || citadas.has(exp.chave)).map(exp => exp.cargoPalavras);
  const faltam = [];
  for (const grupo of ctx.grupos) {
    for (const termo of grupo) {
      for (let i = 0; i < nus.length; i += 1) {
        if (!casaEm(nus, termo, i) || excecaoDeCargo(ws, i, termo, ctx)) continue;
        if (!cargos.some(cargo => grupo.some(forma => contem(cargo, forma)))) faltam.push(termo.join(' '));
      }
    }
  }
  return { faltam: [...new Set(faltam)], comEmpresa: citadas.size > 0 };
}

/** Item 7, texto livre: classes de grau citadas que a formação (da instituição citada, se houver) não tem. */
function grausSemBase(frase, ctx) {
  const ws = so(frase);
  const graus = varrer(ws, GRAU).map(t => t.valor).filter(Boolean);
  if (!graus.length) return [];
  const citadas = ctx.formacao.filter(item => item.nomes.some(seq => contem(ws, seq)));
  const itens = citadas.length ? citadas : ctx.formacao;
  return [...new Set(graus.filter(grau => (grau === 'generico' ? !itens.length : !itens.some(item => item.classes.has(grau)))))];
}

/** Item 8, texto livre: certificações das listas citadas sem curso da base que as contenha. */
const certificacoesSemBase = (frase, ctx) => {
  const ws = so(frase);
  return ctx.certificacoes.filter(seq => contem(ws, seq) && !ctx.cursos.some(curso => contem(curso.palavras, seq))).map(seq => seq.join(' '));
};

/** Item 8, texto livre: cada idioma pareado com o termo de nível mais próximo (empate: o que vem depois). */
function idiomasAcimaDaBase(frase, ctx) {
  const ws = so(frase);
  const niveis = varrer(ws, ESCALA);
  if (!niveis.length) return [];
  const problemas = [];
  ws.forEach((palavra, i) => {
    if (!IDIOMAS.has(palavra)) return;
    const distancia = t => (t.inicio > i ? t.inicio - i : i - t.fim);
    const nivel = niveis.reduce((melhor, t) => (distancia(t) < distancia(melhor) || (distancia(t) === distancia(melhor) && t.inicio > i) ? t : melhor)).valor;
    const daBase = ctx.idiomas.filter(item => item.grupo === IDIOMAS.get(palavra) && item.nivelNum !== null);
    if (!daBase.length) problemas.push(`${palavra} presente na base com nível reconhecido`);
    else {
      const teto = daBase.reduce((a, b) => (b.nivelNum > a.nivelNum ? b : a));
      if (nivel > teto.nivelNum) problemas.push(`${palavra} até "${teto.nivel}" (escala ${teto.nivelNum}), não ${nivel}`);
    }
  });
  return problemas;
}

/**
 * Confere o CV declarado contra os fatos (com os complementos já juntados).
 * → { aprovado, falhas: [{ checagem, secao, trecho, esperado }], frasesNovas: [{ secao, frase }] }
 */
export function verificar(declarado, fatos, { frasesAprovadas = [], proibidas = [], preparo = {} } = {}) {
  const problemas = [...validarDeclarado(declarado), ...validarFatos(fatos)];
  if (problemas.length) throw new Error(`Veracidade: entrada inválida (${problemas.join('; ')}).`);
  const ctx = contexto(fatos, preparo ?? {});
  const falhas = [], frasesNovas = [];
  const vistas = new Map(), novasVistas = new Set();
  const falhar = (checagem, secao, trecho, esperado, chave) => {
    const id = `${checagem}\u0000${chave}`;
    const existente = vistas.get(id);
    if (existente) {
      if (!existente.esperado.split(' | ').includes(esperado)) existente.esperado += ` | ${esperado}`;
      return;
    }
    const falha = { checagem, secao, trecho, esperado };
    vistas.set(id, falha);
    falhas.push(falha);
  };
  const daFrase = frase => JSON.stringify([chaveFrase(frase)]);
  const doBloco = (secao, trecho) => `${secao}\u0000${trecho}`;

  // Itens 5 e 6: empresa, período e cargo no bloco de experiência.
  for (const exp of declarado.experiencias) {
    const trecho = `${exp.cargo} | ${exp.empresa} | ${exp.periodo}`;
    const chaveEmpresa = normalizarEmpresa(exp.empresa);
    const mesmaEmpresa = ctx.experiencias.filter(base => base.chaves.includes(chaveEmpresa));
    if (!mesmaEmpresa.length) {
      falhar('empresa', 'experiencias', trecho, 'empresa de uma experiência da base (nome ou alias)', doBloco('experiencias', trecho));
      continue;
    }
    const periodo = periodoOuNulo(exp.periodo);
    const candidatos = mesmaEmpresa.filter(base => mesmoPeriodo(periodoOuNulo(base.periodo), periodo));
    if (!candidatos.length) {
      falhar('periodo', 'experiencias', trecho, `período da base: ${mesmaEmpresa.map(base => base.periodo).join(' ou ')}`, doBloco('experiencias', trecho));
      continue;
    }
    const cargoConfere = /* MUTACAO:cargo */ candidatos.some(base => normalizarTexto(base.cargo) === normalizarTexto(exp.cargo));
    if (!cargoConfere) {
      const daBase = candidatos.map(base => base.cargo).join(' ou ');
      falhar('cargo', 'experiencias', `${trecho} (na base: ${daBase})`, `cargo da base: ${daBase}`, doBloco('experiencias', trecho));
    }
    // O local do bloco é o da base daquele bloco: texto a mais nele ("300 obras") não passa sem conferência.
    const localConfere = candidatos.some(base => normalizarTexto(base.local) === normalizarTexto(exp.local));
    if (!localConfere) {
      const daBase = candidatos.map(base => base.local).join(' ou ');
      falhar('local', 'experiencias', `${trecho} | ${exp.local} (na base: ${daBase})`, `local da base: ${daBase}`, doBloco('experiencias', trecho));
    }
  }

  // Item 7, bloco: título, instituição e período iguais a um mesmo item da formação.
  for (const item of declarado.formacao) {
    const periodo = periodoOuNulo(item.periodo);
    const confere = ctx.formacao.some(base => normalizarTexto(base.titulo) === normalizarTexto(item.titulo) &&
      normalizarTexto(base.instituicao) === normalizarTexto(item.instituicao) && mesmoPeriodo(periodoOuNulo(base.periodo), periodo));
    const trecho = `${item.titulo} | ${item.instituicao} | ${item.periodo}`;
    if (!confere) falhar('formacao', 'formacao', trecho, 'um mesmo item da formação com título, instituição e período iguais', doBloco('formacao', trecho));
  }

  // Item 8, bloco: cursos iguais a um curso da base; idiomas com nível declarado ≤ nível da base.
  for (const curso of declarado.cursos) {
    if (!ctx.cursos.some(base => normalizarTexto(base.texto) === normalizarTexto(curso))) {
      falhar('cursos', 'cursos', curso, 'curso igual a um da base ou dos complementos', doBloco('cursos', curso));
    }
  }
  for (const item of declarado.idiomas) {
    const trecho = `${item.idioma} | ${item.nivel}`;
    const daBase = ctx.idiomas.filter(base => base.grupo === grupoIdioma(item.idioma));
    const nivel = nivelDe(item.nivel);
    const reconhecidos = daBase.filter(base => base.nivelNum !== null);
    let esperado = null;
    if (!daBase.length) esperado = 'idioma presente na base';
    else if (nivel === null) esperado = `nível não reconhecido ("${item.nivel}")`;
    else if (!reconhecidos.length) esperado = `nível não reconhecido na base ("${daBase.map(base => base.nivel).join('", "')}")`;
    else {
      const teto = reconhecidos.reduce((a, b) => (b.nivelNum > a.nivelNum ? b : a));
      if (nivel > teto.nivelNum) esperado = `nível até "${teto.nivel}" (escala ${teto.nivelNum})`;
    }
    if (esperado) falhar('idiomas', 'idiomas', trecho, esperado, doBloco('idiomas', trecho));
  }

  // Itens 1 a 4: unidades da base (todo o textoLivre dos fatos, sem olhar a seção) e das aprovadas.
  const unidadesBase = new Set(unidades(partirLinhas(fatos.textoLivre.map(item => item.texto).join('\n')), ctx).map(u => u.chave));
  const aprovadas = new Set(frasesAprovadas.map(item => JSON.stringify(chaveDeEntrada(item.texto))));
  const regras = proibidas.map(item => ({ ...item, regex: item.regex ?? new RegExp(item.padrao, 'u') }));

  for (const secao of ORDEM) {
    const linhas = partirSecao(declarado.textoLivre, secao);
    for (const unidade of unidades(linhas, ctx)) {
      const fraseCasa = /* MUTACAO:frase */ unidadesBase.has(unidade.chave) || aprovadas.has(unidade.chave);
      if (fraseCasa) continue;
      falhar('frase-nova', secao, unidade.texto, 'frase da base ou aprovada', unidade.chave);
      if (!novasVistas.has(unidade.chave)) { novasVistas.add(unidade.chave); frasesNovas.push({ secao, frase: unidade.texto }); }
    }
    for (const frase of linhas.flat()) {
      // Itens 5 e 7 no texto livre: não rodam no `integral` (ele traz as linhas de cargo e de formação da base).
      if (secao !== 'integral') {
        const { faltam, comEmpresa } = cargosSemBase(frase, ctx);
        for (const termo of faltam) falhar('cargo', secao, frase, `termo "${termo}" num cargo da base${comEmpresa ? ' da empresa citada' : ''}`, daFrase(frase));
        for (const grau of grausSemBase(frase, ctx)) falhar('formacao', secao, frase, `grau "${grau}" num item da formação (da instituição citada, se houver)`, daFrase(frase));
      }
      for (const nome of certificacoesSemBase(frase, ctx)) falhar('cursos', secao, frase, `curso da base com "${nome}"`, daFrase(frase));
      for (const problema of idiomasAcimaDaBase(frase, ctx)) falhar('idiomas', secao, frase, problema, daFrase(frase));
      for (const regra of regras) {
        if (regra.regex.test(normalizarTexto(frase))) falhar('proibidas', secao, frase, `sem a afirmação proibida "${regra.id}"`, daFrase(frase));
      }
    }
    // Item 9: padrão que atravessa frase, sobre a seção inteira.
    const inteira = declarado.textoLivre.filter(item => item.secao === secao).map(item => item.texto).join('\n');
    for (const regra of regras) {
      const jaPega = linhas.flat().some(frase => regra.regex.test(normalizarTexto(frase)));
      if (!jaPega && regra.regex.test(normalizarTexto(inteira))) {
        falhar('proibidas', secao, inteira, `sem a afirmação proibida "${regra.id}"`, `secao\u0000${secao}\u0000${normalizarTexto(inteira)}`);
      }
    }
  }

  // Item 9 sobre os blocos estruturados também: proibida vence base em qualquer lugar do CV (lado seguro).
  const blocos = [
    ...declarado.experiencias.map(exp => ['experiencias', `${exp.cargo} | ${exp.empresa} | ${exp.local}`]),
    ...declarado.formacao.map(item => ['formacao', `${item.titulo} | ${item.instituicao}`]),
    ...declarado.cursos.map(curso => ['cursos', curso]),
    ...declarado.idiomas.map(item => ['idiomas', `${item.idioma} | ${item.nivel}`]),
  ];
  for (const [secao, trecho] of blocos) {
    for (const regra of regras) {
      if (regra.regex.test(normalizarTexto(trecho))) falhar('proibidas', secao, trecho, `sem a afirmação proibida "${regra.id}"`, doBloco(secao, trecho));
    }
  }

  return { aprovado: falhas.length === 0, falhas, frasesNovas };
}

/**
 * Chaves das unidades com sinal (item 2b) de todo o textoLivre dos fatos: a parte do retrato da base (17.14)
 * que diz quais frases com sinal a base afirma. Mesma partição e mesmo sinal que `verificar` usa.
 */
export function unidadesComSinal(fatos, preparo = {}) {
  const problemas = validarFatos(fatos);
  if (problemas.length) throw new Error(`Veracidade: fatos inválidos (${problemas.join('; ')}).`);
  const ctx = contexto(fatos, preparo ?? {});
  return unidades(partirLinhas(fatos.textoLivre.map(item => item.texto).join('\n')), ctx).map(u => JSON.parse(u.chave));
}
