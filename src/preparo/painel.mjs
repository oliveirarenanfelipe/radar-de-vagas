// Painel de revisão do CV (docs/spec.md, T22): crítica de 7 revisores, sem reescrita. Quem roda os revisores é o
// agente, na sessão dele (skill painel-de-revisao); aqui só se monta a entrada a partir do pacote de uma vaga e se
// valida e grava o painel.md que o agente devolve, num esquema fechado. Sem modelo de linguagem, rede nem processo
// filho. Este é o único arquivo de src/ que lê painel.md (22.9): o texto do painel nunca vira CV.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizarTexto, pontoDeControle } from './frases.mjs';
import { conferirPacote, erro, gravarArquivo, gravarJson, idCanonico, lerJsonOuNada, pastaSegura } from './pacote.mjs';

export const CREDITO = 'Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media';
export const TETO_PAINEL = 200 * 1024;
// Restos da linha de crédito que, no CV, denunciam a linha do autor plantada nele (22.8).
const CREDITO_NO_CV = ['made with /hiring-panel', 'nocodealex', 'chen.media'];
const REVISORES = ['triagem', 'gestor', 'leitor-gestor', 'concorrente', 'ceo', 'recrutadora', 'colega'];
const OUTRO_PAINEL = 'painel de outro CV ou de outra entrada: rode painel-entrada e o painel de novo';
const ABRE_DADO = '<DADO_DA_VAGA>', FECHA_DADO = '</DADO_DA_VAGA>';

const LEITOR = { vereditos: ['CONTRATA', 'TALVEZ', 'DESCARTA'], forma: ['veredito', 'itens'], itens: [1, 3] };
// Ordem e títulos exatos do painel.md (versão 1). `forma` é a sequência de linhas do bloco; "itens" são as `- Trecho`.
const SECOES = [
  { titulo: '# Painel de revisão', id: 'cabecalho' },
  { titulo: '## Triagem automática', id: 'triagem', revisor: 'Triagem automática', vereditos: ['PASSA', 'REPROVA'],
    forma: ['veredito', 'itens', 'Termos da vaga ausentes'], itens: [0, 5] },
  { titulo: '## Gestor', id: 'gestor', revisor: 'Gestor', vereditos: ['ENTREVISTA', 'NÃO'],
    forma: ['veredito', 'Decidiu nos primeiros dez segundos', 'Perguntaria na entrevista', 'itens'], itens: [0, 3] },
  { titulo: '## Leitores isolados', id: 'leitores', forma: [] },
  { titulo: '### Gestor', id: 'leitor-gestor', revisor: 'Leitor: Gestor', ...LEITOR },
  { titulo: '### Concorrente', id: 'concorrente', revisor: 'Leitor: Concorrente', ...LEITOR },
  { titulo: '### CEO', id: 'ceo', revisor: 'Leitor: CEO', ...LEITOR },
  { titulo: '### Recrutadora (30 s)', id: 'recrutadora', revisor: 'Leitor: Recrutadora (30 s)', ...LEITOR },
  { titulo: '### Colega', id: 'colega', revisor: 'Leitor: Colega', ...LEITOR },
  { titulo: '## Erros, do pior para o melhor', id: 'erros' },
  { titulo: '## Fatos que faltam', id: 'fatos' },
];
const ITEM = /^- Trecho: "(.*)" · Motivo: (.*)$/;
const ERRO = /^(\d+)\. Trecho: "(.*)" · Por que reprova: (.*) · Quem apontou: (.*)$/;

const sha256 = dados => createHash('sha256').update(dados).digest('hex');
const ehTitulo = linha => /^\s*#/.test(linha);

// Linha de dado que começa com "#" ganha "\" na frente: o bloco da vaga nunca abre seção no painel-entrada.md.
const neutralizar = texto => String(texto ?? '').replace(/\r\n|\r/g, '\n').replace(/^(\s*)#/gm, '$1\\#')
  .replaceAll(FECHA_DADO, '<\\/DADO_DA_VAGA>');

const textoDaSecao = (declarado, secao) => (declarado.textoLivre ?? []).filter(item => item.secao === secao)
  .map(item => String(item.texto).replace(/\r\n|\r/g, '\n').replace(/\n+$/, '')).join('\n');

/** Linhas do CV contra as quais o trecho citado é conferido: as seções integral e gupy do cv-declarado.json (22.3). */
function linhasDoCv(declarado) {
  return ['integral', 'gupy'].flatMap(secao => textoDaSecao(declarado, secao).split('\n'))
    .map(normalizarTexto).filter(Boolean);
}

/**
 * A linha do autor dentro do CV (qualquer seção do texto livre) é recusada (22.8). Caracteres de formato (\p{Cf}:
 * U+200B, U+00AD, U+2060...) saem antes da busca, senão "noco<U+200B>dealex" passaria. Homóglifo de outro alfabeto
 * (o "о" cirílico no lugar do "o") não é coberto: limite declarado.
 */
function conferirCvSemCredito(declarado) {
  const semFormato = texto => normalizarTexto(String(texto ?? '').replace(/\p{Cf}/gu, ''));
  const plantado = (declarado.textoLivre ?? []).some(item => CREDITO_NO_CV.some(resto => semFormato(item.texto).includes(resto)));
  if (plantado) throw erro('crédito do painel dentro do CV: o CV não pode levar a linha do autor.');
}

async function lerDeclarado(pasta) {
  const declarado = await lerJsonOuNada(join(pasta, 'cv-declarado.json'));
  if (!declarado || !Array.isArray(declarado.textoLivre)) throw erro('sem cv-declarado.json na pasta da vaga: refaça o preparar.');
  return declarado;
}

async function lerTexto(caminho) {
  try { return await readFile(caminho, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Pasta e pacote de uma vaga cujo PDF ainda é o do preparo (a mensagem do conferirPacote vale como está).
async function pacoteConferido({ dataDir, state, id }) {
  await conferirPacote({ dataDir, state, id });
  const canonico = idCanonico(state, id);
  const pasta = pastaSegura(dataDir, canonico);
  return { canonico, pasta, pacote: await lerJsonOuNada(join(pasta, 'pacote.json')) };
}

/** Texto de painel-entrada.md: determinístico (mesma vaga e mesmo pacote, mesmos bytes; sem data). */
export function textoDaEntrada({ id, job, pacote, declarado }) {
  const vaga = [`título: ${job.title ?? ''}`, `empresa: ${job.company ?? ''}`, `fonte: ${job.source ?? ''}`,
    `link de candidatura: ${job.applyUrl ?? job.url ?? ''}`, 'descrição:', String(job.description ?? '')].join('\n');
  const gupy = textoDaSecao(declarado, 'gupy');
  return ['# Entrada do painel', `vaga: ${id}`, `pdf: ${pacote.pdf}`, `pdfSha256: ${pacote.pdfSha256}`, '',
    '## Vaga', ABRE_DADO, neutralizar(vaga), FECHA_DADO, '',
    '## Currículo', textoDaSecao(declarado, 'integral'),
    ...(gupy ? ['', '## Texto da Gupy', gupy] : []), ''].join('\n');
}

/** Grava candidaturas/<pasta da vaga>/painel-entrada.md a partir do pacote conferido (22.1). */
export async function montarEntrada({ dataDir, state, id }) {
  const { canonico, pasta, pacote } = await pacoteConferido({ dataDir, state, id });
  const declarado = await lerDeclarado(pasta);
  conferirCvSemCredito(declarado);
  if (!textoDaSecao(declarado, 'integral').trim()) throw erro('cv-declarado.json sem a seção integral: refaça o preparar.');
  const texto = textoDaEntrada({ id: canonico, job: state.jobs[canonico].job, pacote, declarado });
  const caminho = join(pasta, 'painel-entrada.md');
  await gravarArquivo(caminho, texto);
  return { caminho, sha256: sha256(Buffer.from(texto, 'utf8')) };
}

/** O texto entre <DADO_DA_VAGA> e </DADO_DA_VAGA> do painel-entrada.md (o fechamento dentro do dado vem neutralizado). */
function vagaDaEntrada(entrada) {
  const inicio = entrada.indexOf(`\n${ABRE_DADO}\n`);
  if (inicio < 0) return '';
  const fim = entrada.indexOf(`\n${FECHA_DADO}\n`, inicio);
  return fim < 0 ? '' : entrada.slice(inicio + ABRE_DADO.length + 2, fim);
}

/**
 * Lê painel.md no esquema fechado. Devolve os problemas (linha, seção e motivo, em português) e a estrutura lida
 * (vereditos, trechos citados, erros, termos). Não confere trecho, vaga nem hash: isso é do validarPainel.
 */
export function lerPainel(texto) {
  const problemas = [];
  const problema = (linha, secao, mensagem) => problemas.push(`linha ${linha} · ${secao}: ${mensagem}`);
  const estrutura = { cabecalho: {}, vereditos: [], trechos: [], erros: [], termos: [] };
  if (Buffer.byteLength(texto, 'utf8') > TETO_PAINEL) {
    problema(1, 'arquivo', `painel grande demais (mais de ${TETO_PAINEL / 1024} KiB)`);
    return { problemas, estrutura };
  }
  const linhas = texto.split('\n');
  // "\n" é a única quebra aceita: "\r", outro Cc, Cf e separadores de linha recusam o arquivo antes de ler o resto.
  linhas.forEach((linha, i) => {
    const ponto = pontoDeControle(linha);
    if (ponto) problema(i + 1, 'arquivo', `caractere de controle ${ponto}`);
  });
  if (problemas.length) return { problemas, estrutura };

  // A linha de crédito é a última não vazia, exata; o que vem antes dela é o corpo.
  let ultima = linhas.length - 1;
  while (ultima >= 0 && !linhas[ultima].trim()) ultima--;
  let corpo = linhas;
  if (ultima >= 0 && linhas[ultima] === CREDITO) corpo = linhas.slice(0, ultima);
  else problema(Math.max(ultima, 0) + 1, 'crédito', 'linha de crédito do autor ausente ou alterada');

  // Blocos por título: cada título conhecido uma vez, na ordem; título desconhecido é recusado (22.2).
  const blocos = new Map();
  let atual = null;
  corpo.forEach((linha, i) => {
    const numero = i + 1;
    if (ehTitulo(linha)) {
      const secao = SECOES.find(item => item.titulo === linha);
      if (!secao) { problema(numero, linha.trim(), 'seção desconhecida'); atual = null; return; }
      if (blocos.has(secao.id)) { problema(numero, linha, 'seção repetida'); atual = null; return; }
      atual = { secao, numero, linhas: [] };
      blocos.set(secao.id, atual);
      return;
    }
    if (!linha.trim()) return;
    if (!atual) problema(numero, 'fora de seção', `linha fora do esquema: "${linha}"`);
    else atual.linhas.push({ numero, texto: linha });
  });
  for (const secao of SECOES) if (!blocos.has(secao.id)) problema(1, secao.titulo, 'seção faltando');
  const presentes = [...blocos.values()];
  const esperada = SECOES.filter(secao => blocos.has(secao.id));
  const foraDeOrdem = presentes.findIndex((bloco, i) => bloco.secao !== esperada[i]);
  if (foraDeOrdem >= 0) problema(presentes[foraDeOrdem].numero, presentes[foraDeOrdem].secao.titulo, 'seções fora de ordem');

  for (const { secao, numero, linhas: doBloco } of presentes) {
    if (secao.id === 'cabecalho') lerCabecalho(doBloco, numero, estrutura, problema);
    else if (secao.id === 'erros') lerErros(doBloco, numero, estrutura, problema);
    else if (secao.id === 'fatos') lerFatos(doBloco, numero, problema);
    else lerRevisor(secao, doBloco, numero, estrutura, problema);
  }
  return { problemas, estrutura };
}

function lerCabecalho(linhas, numero, estrutura, problema) {
  const titulo = '# Painel de revisão';
  const chaves = ['vaga', 'pdfSha256', 'entradaSha256'];
  chaves.forEach((chave, i) => {
    const linha = linhas[i];
    const achado = linha && new RegExp(`^${chave}: (.*)$`).exec(linha.texto);
    if (!achado) { problema(linha?.numero ?? numero, titulo, `falta a linha "${chave}: ..."`); return; }
    const valor = achado[1].trim();
    if (chave !== 'vaga' && !/^[0-9a-f]{64}$/.test(valor)) problema(linha.numero, titulo, `${chave} precisa ter 64 caracteres hexadecimais`);
    estrutura.cabecalho[chave] = { valor, linha: linha.numero };
  });
  for (const linha of linhas.slice(chaves.length)) problema(linha.numero, titulo, `linha fora do esquema: "${linha.texto}"`);
}

function lerRevisor(secao, linhas, numero, estrutura, problema) {
  let i = 0, itens = 0;
  for (const parte of secao.forma) {
    if (parte === 'itens') {
      for (; i < linhas.length && linhas[i].texto.startsWith('- '); i++) {
        const { numero: linha, texto } = linhas[i];
        itens++;
        const achado = ITEM.exec(texto);
        if (!achado) { problema(linha, secao.titulo, `item fora do esquema (- Trecho: "..." · Motivo: ...): "${texto}"`); continue; }
        if (!achado[2].trim()) problema(linha, secao.titulo, 'item sem motivo');
        estrutura.trechos.push({ linha, secao: secao.titulo, trecho: achado[1] });
      }
      continue;
    }
    const rotulo = parte === 'veredito' ? 'Veredito' : parte;
    const linha = linhas[i];
    if (!linha || !linha.texto.startsWith(`${rotulo}: `)) {
      problema(linha?.numero ?? numero, secao.titulo, `falta a linha "${rotulo}: ..." nesta posição`);
      return;
    }
    i++;
    const valor = linha.texto.slice(rotulo.length + 2).trim();
    if (!valor) problema(linha.numero, secao.titulo, `"${rotulo}" vazio`);
    if (parte === 'veredito') {
      if (!secao.vereditos.includes(valor)) problema(linha.numero, secao.titulo, `veredito fora da lista (${secao.vereditos.join(', ')}): "${valor}"`);
      estrutura.vereditos.push({ revisor: secao.revisor, veredito: valor });
    } else if (parte === 'Termos da vaga ausentes' && valor !== 'nenhum') {
      estrutura.termos.push(...valor.split(',').map(termo => ({ linha: linha.numero, termo: termo.trim() })));
    }
  }
  const [minimo, maximo] = secao.itens ?? [0, 0];
  if (secao.forma.includes('itens') && (itens < minimo || itens > maximo)) {
    problema(numero, secao.titulo, `${itens} itens "- Trecho" (de ${minimo} a ${maximo})`);
  }
  for (const linha of linhas.slice(i)) problema(linha.numero, secao.titulo, `linha fora do esquema: "${linha.texto}"`);
}

function lerErros(linhas, numero, estrutura, problema) {
  const titulo = '## Erros, do pior para o melhor';
  if (linhas.length === 1 && linhas[0].texto === 'Nenhum erro apontado.') return;
  if (!linhas.length) problema(numero, titulo, 'sem itens: numere os erros ou escreva "Nenhum erro apontado."');
  linhas.forEach(({ numero: linha, texto }, i) => {
    const achado = ERRO.exec(texto);
    if (!achado) { problema(linha, titulo, `linha fora do esquema (N. Trecho: "..." · Por que reprova: ... · Quem apontou: ...): "${texto}"`); return; }
    const [, ordem, trecho, porQue, quem] = achado;
    if (Number(ordem) !== i + 1) problema(linha, titulo, `erros numerados fora de sequência: esperado ${i + 1}, veio ${ordem}`);
    if (!porQue.trim()) problema(linha, titulo, '"Por que reprova" vazio');
    const ids = quem.split(',').map(item => item.trim()).filter(Boolean);
    if (!ids.length) problema(linha, titulo, '"Quem apontou" vazio');
    for (const revisor of ids) {
      if (!REVISORES.includes(revisor)) problema(linha, titulo, `revisor desconhecido em "Quem apontou" (${REVISORES.join(', ')}): "${revisor}"`);
    }
    estrutura.trechos.push({ linha, secao: titulo, trecho });
    estrutura.erros.push({ trecho, porQue: porQue.trim(), quem: ids });
  });
}

function lerFatos(linhas, numero, problema) {
  const titulo = '## Fatos que faltam';
  if (!linhas.length) problema(numero, titulo, 'sem itens: escreva as perguntas ("- ...") ou "- nenhum"');
  const nenhum = linhas.some(linha => linha.texto === '- nenhum');
  for (const { numero: linha, texto } of linhas) {
    if (!/^- \S/.test(texto)) problema(linha, titulo, `linha fora do esquema (- <pergunta>): "${texto}"`);
    else if (nenhum && linhas.length > 1 && texto === '- nenhum') problema(linha, titulo, '"- nenhum" só vale como linha única');
  }
}

/**
 * Problemas do painel.md frente à entrada e ao pacote atuais (22.2 a 22.5); lista vazia = válido. `entrada` é o texto
 * de painel-entrada.md; `declarado`, o cv-declarado.json do pacote (o trecho é conferido contra ele, não contra a
 * entrada re-lida); `id`, o id canônico da vaga.
 */
export function validarPainel(texto, { entrada, pacote, declarado, id = pacote?.id }) {
  const { problemas, estrutura } = lerPainel(texto);
  const { cabecalho } = estrutura;
  const esperado = { vaga: id, pdfSha256: pacote?.pdfSha256, entradaSha256: sha256(Buffer.from(String(entrada ?? ''), 'utf8')) };
  for (const chave of Object.keys(esperado)) {
    if (cabecalho[chave] && cabecalho[chave].valor !== esperado[chave]) problemas.push(`linha ${cabecalho[chave].linha} · # Painel de revisão: ${OUTRO_PAINEL} (${chave})`);
  }
  const cv = linhasDoCv(declarado ?? {});
  for (const { linha, secao, trecho } of estrutura.trechos) {
    const normal = normalizarTexto(trecho);
    // Trecho de uma palavra só ("e", "de") está em quase toda linha: citar exige ao menos 2 palavras de 2+ letras
    // (número não conta: "de 14" é curto demais).
    if ((normal.match(/\p{L}{2,}/gu) ?? []).length < 2) {
      problemas.push(`linha ${linha} · ${secao}: trecho não está no CV: "${trecho}" (curto demais: cite ao menos duas palavras do CV)`);
    } else if (!cv.some(linhaDoCv => linhaDoCv.includes(normal))) {
      problemas.push(`linha ${linha} · ${secao}: trecho não está no CV: "${trecho}"`);
    }
  }
  const vaga = normalizarTexto(vagaDaEntrada(String(entrada ?? '')));
  for (const { linha, termo } of estrutura.termos) {
    const normal = normalizarTexto(termo);
    if (!normal || !vaga.includes(normal)) problemas.push(`linha ${linha} · ## Triagem automática: termo não está na vaga: "${termo}"`);
  }
  return problemas;
}

// Entrada, pacote e declarado atuais da vaga, para validar o painel contra eles.
async function contexto({ dataDir, state, id }) {
  const { canonico, pasta, pacote } = await pacoteConferido({ dataDir, state, id });
  const declarado = await lerDeclarado(pasta);
  conferirCvSemCredito(declarado);
  const entrada = await lerTexto(join(pasta, 'painel-entrada.md'));
  if (entrada === undefined) throw erro('sem painel-entrada.md na pasta da vaga: rode painel-entrada.');
  return { canonico, pasta, pacote, declarado, entrada };
}

/**
 * Valida <arquivo> e, se passar, grava-o como painel.md (temporário + rename) e acrescenta `painel` ao pacote.json,
 * sem mudar as outras chaves (22.6). Recusado: nada é gravado e o erro traz a lista de problemas.
 */
export async function gravarPainel({ dataDir, state, id, arquivo }) {
  const canonico = idCanonico(state, id);
  if (!canonico) throw erro('Vaga não encontrada no estado.', 2);
  let tamanho;
  try { tamanho = (await stat(arquivo)).size; }
  catch (error) {
    if (error.code === 'ENOENT') throw erro(`arquivo do painel não encontrado: ${arquivo}`, 2);
    throw error;
  }
  const { pasta, pacote, declarado, entrada } = await contexto({ dataDir, state, id: canonico });
  // Grande demais recusa sem ler o resto (22.4).
  if (tamanho > TETO_PAINEL) throw erro(`painel recusado; nada foi gravado.\n- painel grande demais (mais de ${TETO_PAINEL / 1024} KiB)`);
  const bytes = await readFile(arquivo);
  let texto;
  try { texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw erro('painel recusado; nada foi gravado.\n- o arquivo não é texto UTF-8'); }
  const problemas = validarPainel(texto, { entrada, pacote, declarado, id: canonico });
  if (problemas.length) throw erro(`painel recusado; nada foi gravado.\n${problemas.map(item => `- ${item}`).join('\n')}`);
  const caminho = join(pasta, 'painel.md');
  await gravarArquivo(caminho, texto);
  const painel = { sha256: sha256(bytes), entradaSha256: sha256(Buffer.from(entrada, 'utf8')), gravadoEm: new Date().toISOString() };
  await gravarJson(join(pasta, 'pacote.json'), { ...pacote, painel });
  return { caminho, painel };
}

/**
 * Confere o painel do pacote (22.7, 22.8), depois do conferirPacote: CV sem a linha do autor; painel.md com o sha256
 * gravado. Sem `painel` no pacote não é erro (PREMISSA S13). Devolve { estado, mensagem } para a linha da saída.
 */
export async function conferirPainel({ dataDir, state, id }) {
  const { pasta, pacote } = await pacoteConferido({ dataDir, state, id });
  conferirCvSemCredito(await lerDeclarado(pasta));
  const caminho = join(pasta, 'painel.md');
  let bytes;
  try { bytes = await readFile(caminho); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!pacote.painel) {
    return bytes
      ? { estado: 'anterior', mensagem: 'Painel: o painel.md da pasta é de um pacote anterior; rode painel-entrada de novo' }
      : { estado: 'nao-rodado', mensagem: 'Painel: não rodado' };
  }
  if (!bytes || sha256(bytes) !== pacote.painel.sha256) throw erro('painel mudou depois de gravado: rode o painel de novo.');
  return { estado: 'conferido', mensagem: 'Painel conferido', caminho };
}

/** Os 7 vereditos e até 5 erros do painel já conferido, só para mostrar à pessoa; null sem painel conferido. */
export async function resumoDoPainel({ dataDir, state, id }) {
  const conferido = await conferirPainel({ dataDir, state, id });
  if (conferido.estado !== 'conferido') return null;
  const { estrutura } = lerPainel(await readFile(conferido.caminho, 'utf8'));
  return { vereditos: estrutura.vereditos, erros: estrutura.erros.slice(0, 5).map(({ trecho, porQue }) => ({ trecho, porQue })) };
}
