// Aprovação pela pessoa (docs/spec.md §3, 17.13 e 17.14): o único caminho da ferramenta que grava frases e
// bases aprovadas. Só num terminal interativo e só depois de a pessoa digitar "aprovo". Um agente roda o
// comando sem terminal (isTTY falso) e recebe código 2, sem nada gravado.
//
// T23 (Telegram): este arquivo monta o lote, lê a resposta e decide o que gravar, sem rede. Quem fala com o
// Telegram é src/telegram.mjs, chamado por src/commands.mjs; aqui não entra fetch nem import de telegram.mjs.
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pontoDeControle } from './frases.mjs';
import { carregarFrasesAprovadas, chaveDeEntrada, hashRetrato, jsonCanonico } from './contrato.mjs';
import {
  SEM_PREPARO, carregarCamada, erro, gravarJson, lerFatos, lerJsonOuNada, lerVariantes, pastaCandidaturas, retratoDaBase, situacaoDaBase,
} from './pacote.mjs';
import { executar as executarPonte } from './ponte.mjs';

const SO_NO_TERMINAL = 'aprovação só pela pessoa, no terminal: rode o comando você mesmo. Nada foi gravado.';

/** O texto como JSON e, além disso, todo caractere de controle, formato ou espaço especial como \uXXXX. */
export function formaEscapada(texto) {
  return JSON.stringify(String(texto)).replace(/[\p{C}\p{Z}]/gu, caractere => {
    if (caractere === ' ') return caractere;
    const ponto = caractere.codePointAt(0);
    return ponto > 0xffff ? `\\u{${ponto.toString(16).toUpperCase()}}` : `\\u${ponto.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

function hojeLocal() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

async function confirmar(io, pergunta) {
  const resposta = await io.perguntar(pergunta);
  return String(resposta ?? '').trim() === 'aprovo';
}

/** aprovar-frase <id>: tira a frase de frases-pendentes.json e a grava como aprovada. */
export async function aprovarFrase({ dataDir, id, io }) {
  if (!io?.isTTY) throw erro(SO_NO_TERMINAL, 2);
  const caminhoPendentes = join(pastaCandidaturas(dataDir), 'frases-pendentes.json');
  const pendentes = (await lerJsonOuNada(caminhoPendentes)) ?? { versao: 1, frases: [] };
  const item = pendentes.frases.find(frase => frase.id === id);
  if (!item) throw erro(`frase pendente não encontrada: ${id}`, 2);
  for (const campo of ['frase', 'origem', 'secao']) {
    const ponto = pontoDeControle(item[campo]);
    if (ponto) throw erro(`texto com caractere de controle ${ponto} no campo ${campo}: ${formaEscapada(item[campo])}. Corrija o texto de origem; nada foi gravado.`, 2);
  }
  const aprovadas = await carregarFrasesAprovadas({ dataDir });
  const chave = JSON.stringify(chaveDeEntrada(item.frase));
  const restantes = { ...pendentes, frases: pendentes.frases.filter(frase => frase.id !== id) };
  if (aprovadas.some(aprovada => JSON.stringify(aprovada.chave) === chave)) {
    await gravarJson(caminhoPendentes, restantes);
    io.escrever('Esta frase já está aprovada; ela saiu das pendentes.');
    return 0;
  }
  io.escrever(`Frase: ${item.frase}`);
  io.escrever(`Forma escapada: ${formaEscapada(item.frase)}`);
  io.escrever(`Origem: ${item.origem} · ${formaEscapada(item.origem)}`);
  io.escrever(`Seção: ${item.secao}`);
  if (!await confirmar(io, 'Digite aprovo para aprovar esta frase como verdade sobre você: ')) throw erro('Frase não aprovada; nada foi gravado.');
  const caminhoAprovadas = join(dataDir, 'frases-aprovadas.json');
  const doc = (await lerJsonOuNada(caminhoAprovadas)) ?? { versao: 1, frases: [] };
  doc.frases.push({ texto: item.frase, aprovadaEm: hojeLocal(), origem: item.origem });
  await gravarJson(join(dataDir, 'frases-aprovadas.json'), doc);
  await gravarJson(caminhoPendentes, restantes);
  io.escrever('Frase aprovada.');
  return 0;
}

// Todo texto do retrato, para a recusa de caractere de controle antes de mostrar e gravar.
function* textos(valor) {
  if (typeof valor === 'string') yield valor;
  else if (Array.isArray(valor)) for (const item of valor) yield* textos(item);
  else if (valor && typeof valor === 'object') for (const [chave, item] of Object.entries(valor)) { yield chave; yield* textos(item); }
}

/** aprovar-base <base>: calcula o retrato atual da base, mostra o retrato ou a diferença e grava a aprovação. */
export async function aprovarBase({ dataDir, base, io, search, executar = executarPonte }) {
  if (!io?.isTTY) throw erro(SO_NO_TERMINAL, 2);
  const preparo = search.preparo;
  if (!preparo) throw erro(SEM_PREPARO, 2);
  const opcoes = { preparo, dataDir };
  const saida = await lerVariantes(opcoes, executar);
  const camada = await carregarCamada({ dataDir, preparo });
  const { porBase } = await lerFatos(saida.variantes, opcoes, executar);
  const fatos = porBase.get(base);
  if (!fatos) throw erro(`base desconhecida: ${base} (nenhuma variante usa esta base).`, 2);
  const retrato = retratoDaBase(fatos, { ...camada, preparo });
  for (const texto of textos(retrato)) {
    const ponto = pontoDeControle(texto);
    if (ponto) throw erro(`base "${base}": texto com caractere de controle ${ponto}: ${formaEscapada(texto)}. Corrija o DOCX da base; nada foi gravado.`, 2);
  }
  const situacao = situacaoDaBase(base, retrato, camada.basesAprovadas);
  if (situacao.aprovada) { io.escrever(`A base "${base}" já está aprovada; nada a fazer.`); return 0; }
  const { primeiraVez, acrescentados, removidos, motivos } = situacao.pendente;
  io.escrever(primeiraVez ? `Base "${base}", primeira aprovação. Retrato inteiro:` : `Base "${base}" mudou desde a aprovação (${motivos.join('; ')}).`);
  for (const item of removidos) io.escrever(`- removido: ${item} · ${formaEscapada(item)}`);
  for (const item of acrescentados) io.escrever(`+ ${primeiraVez ? '' : 'acrescentado: '}${item} · ${formaEscapada(item)}`);
  if (!await confirmar(io, 'Digite aprovo para que esta base valha como verdade: ')) throw erro('Base não aprovada; nada foi gravado.');
  const caminho = join(dataDir, 'bases-aprovadas.json');
  const doc = (await lerJsonOuNada(caminho)) ?? { versao: 1, bases: {} };
  doc.bases[base] = { aprovadaEm: hojeLocal(), hash: situacao.hash, retrato };
  await gravarJson(join(dataDir, 'bases-aprovadas.json'), doc);
  const caminhoPendentes = join(pastaCandidaturas(dataDir), 'bases-pendentes.json');
  const pendentes = await lerJsonOuNada(caminhoPendentes);
  if (pendentes?.bases?.[base]) {
    delete pendentes.bases[base];
    await gravarJson(caminhoPendentes, pendentes);
  }
  io.escrever(`Base "${base}" aprovada.`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// T23 · aprovação pelo Telegram (docs/spec.md, 23.2 a 23.7). Funções puras, mais a leitura e a gravação dos
// arquivos da pasta de dados; a rede fica em src/telegram.mjs, ligada por src/commands.mjs.

export const ITENS_POR_LOTE = 10;
export const TETO_MENSAGEM = 4096;
export const TETO_CAPTION = 1024;
export const LOTE_MUDOU = 'o conteúdo do lote mudou desde o envio: rode pedir-aprovacao de novo';
export const NAO_E_LOTE = 'resposta a mensagem que não é lote';
const NOME_DE_BASE = /^[A-Za-z0-9_-]+$/;
const SO_ASCII_VISIVEL = /^[\x20-\x7e]*$/;
const sha256 = dados => createHash('sha256').update(dados).digest('hex');
const pastaDosLotes = dataDir => join(pastaCandidaturas(dataDir), 'lotes-aprovacao');

/** Todo ponto de código fora de U+0020–U+007E vira \uXXXX (ou \u{XXXXX} acima de U+FFFF), inclusive acento. */
export function formaAscii(texto) {
  let saida = '';
  for (const caractere of String(texto)) {
    const ponto = caractere.codePointAt(0);
    if (ponto >= 0x20 && ponto <= 0x7e) saida += caractere;
    else saida += ponto > 0xffff ? `\\u{${ponto.toString(16)}}` : `\\u${ponto.toString(16).padStart(4, '0')}`;
  }
  return saida;
}

const comAscii = texto => (SO_ASCII_VISIVEL.test(texto) ? '' : ` ascii: "${formaAscii(texto)}"`);

/**
 * sha256 dos campos fixados antes do envio: versao, tipo, loteId, chatId e itens. Fica fora o que só se conhece depois
 * do envio (mensagens, fileUniqueId, documentoSha256, enviadoEm) e as decisões. Cobrir o chatId impede que trocar o
 * destino no arquivo do lote passe sem recalcular o hash.
 */
export function hashDoLote({ versao, tipo, loteId, chatId = null, itens }) {
  return sha256(jsonCanonico({ versao, tipo, loteId, chatId, itens }));
}

/** Lote sem envio: itens numerados, loteId (12 hex do sha256 de jsonCanonico(itens)) e o hashDoLote, ainda sem chatId. */
export function montarLote(tipo, itens) {
  const numerados = itens.map((item, i) => ({ n: i + 1, ...item }));
  const lote = { versao: 1, tipo, loteId: sha256(jsonCanonico(numerados)).slice(0, 12), itens: numerados };
  return { ...lote, sha256: hashDoLote(lote) };
}

/** O lote com o chatId do envio e o hash recalculado com ele: é o que o pedir-aprovacao grava. */
export function selarLote(lote, chatId) {
  const selado = { ...lote, chatId };
  return { ...selado, sha256: hashDoLote(selado) };
}

/**
 * Texto da mensagem do lote, só do cabeçalho e dos itens (sem data, sem decisões): o mesmo arquivo de lote dá
 * sempre os mesmos bytes. No lote de frases, a linha ascii só aparece quando o texto tem algo fora do ASCII visível.
 */
export function textoDoLote(lote) {
  if (lote.tipo === 'frases') {
    const total = lote.itens.length;
    return [`Radar de vagas: lote ${lote.loteId}, ${total} ${total === 1 ? 'frase' : 'frases'} para aprovar`, '',
      ...lote.itens.flatMap(item => [`${item.n}. [${item.secao}] ${item.origem}`, `"${item.texto}"`,
        ...(SO_ASCII_VISIVEL.test(item.texto) ? [] : [`ascii: "${formaAscii(item.texto)}"`]), '']),
      'Responda a ESTA mensagem. Lote de 1 item: aprovo. Mais de 1: aprovo 1 3 | nao 2 motivo'].join('\n');
  }
  const [item] = lote.itens;
  return [`Radar de vagas: lote ${lote.loteId}, base ${item.base}`, `hash: ${item.hash}`,
    `itens no retrato: ${item.itensNoRetrato}; acrescentados: ${item.acrescentados}; removidos: ${item.removidos}`,
    'O retrato inteiro está no documento.', 'Responda a ESTE documento com: aprovo'].join('\n');
}

// Itens legíveis do retrato, pela situação contra nenhuma aprovação (pendente.acrescentados = itensDoRetrato).
const itensDoRetrato = retrato => situacaoDaBase('', retrato, {}).pendente.acrescentados;

/** Documento do lote de base: texto puro, o hash na 1ª linha, depois um item do retrato por linha, entre aspas. */
export function documentoDoRetrato(retrato) {
  return `${[hashRetrato(retrato), ...itensDoRetrato(retrato).map(item => `"${item}"${comAscii(item)}`)].join('\n')}\n`;
}

/** Recusa nome de base fora de ^[A-Za-z0-9_-]+$ (o nome vai no caption). */
export function conferirNomeDeBase(base) {
  if (typeof base !== 'string' || !NOME_DE_BASE.test(base)) throw erro(`nome de base inválido: ${formaEscapada(base)}; nada foi enviado.`, 2);
}

/** Lotes de frases: no máximo 10 itens e 4.096 caracteres (UTF-16) por mensagem; nenhum texto é cortado. */
export function lotesDeFrases(pendentes) {
  for (const item of pendentes) {
    for (const campo of ['frase', 'origem', 'secao']) {
      if (typeof item[campo] !== 'string' || !item[campo]) throw erro(`frase pendente ${item.id}: campo ${campo} vazio; nada foi enviado.`, 2);
      const ponto = pontoDeControle(item[campo]);
      if (ponto) throw erro(`texto com caractere de controle ${ponto} no campo ${campo} da frase ${item.id}: ${formaEscapada(item[campo])}. Corrija o texto de origem; nada foi enviado.`, 2);
    }
    if (/\s{2}|^\s|\s$/u.test(item.frase)) throw erro(`texto com espaço duplo ou nas pontas: corrija a variante (frase ${item.id}); nada foi enviado.`, 2);
  }
  const lote = grupo => montarLote('frases', grupo.map(({ id, frase, secao, origem }) => ({ tipo: 'frase', id, texto: frase, secao, origem })));
  const cabe = grupo => grupo.length <= ITENS_POR_LOTE && textoDoLote(lote(grupo)).length <= TETO_MENSAGEM;
  const lotes = [];
  let atual = [];
  for (const item of pendentes) {
    if (!cabe([item])) throw erro(`frase longa demais para uma mensagem: ${item.id} (o lote de 1 item passa de ${TETO_MENSAGEM} caracteres); nada foi enviado.`, 2);
    if (cabe([...atual, item])) atual.push(item);
    else { lotes.push(lote(atual)); atual = [item]; }
  }
  if (atual.length) lotes.push(lote(atual));
  return lotes;
}

/** Lote de uma base (null se ela já está aprovada), com a recusa de controle em cada item e o teto do caption. */
export function loteDeBase({ base, retrato, basesAprovadas }) {
  conferirNomeDeBase(base);
  const itens = itensDoRetrato(retrato);
  for (const item of itens) {
    const ponto = pontoDeControle(item);
    if (ponto) throw erro(`base "${base}": item do retrato com caractere de controle ${ponto}: ${formaEscapada(item)}. Corrija o DOCX da base; nada foi enviado.`, 2);
  }
  const situacao = situacaoDaBase(base, retrato, basesAprovadas);
  if (situacao.aprovada) return null;
  const lote = montarLote('base', [{ tipo: 'base', base, hash: situacao.hash, itensNoRetrato: itens.length,
    acrescentados: situacao.pendente.acrescentados.length, removidos: situacao.pendente.removidos.length }]);
  if (textoDoLote(lote).length > TETO_CAPTION) throw erro(`o texto do lote da base "${base}" passa de ${TETO_CAPTION} caracteres (teto do caption); nada foi enviado.`, 2);
  return lote;
}

/** Retratos atuais das bases pedidas, pela ponte (como o aprovar-base), e as bases aprovadas da camada. */
export async function retratosAtuais({ dataDir, search, bases, executar = executarPonte }) {
  const preparo = search.preparo;
  if (!preparo) throw erro(SEM_PREPARO, 2);
  const opcoes = { preparo, dataDir };
  const saida = await lerVariantes(opcoes, executar);
  const camada = await carregarCamada({ dataDir, preparo });
  const { porBase } = await lerFatos(saida.variantes, opcoes, executar);
  const retratos = new Map();
  for (const base of bases) {
    const fatos = porBase.get(base);
    if (!fatos) throw erro(`base desconhecida: ${base} (nenhuma variante usa esta base).`, 2);
    retratos.set(base, retratoDaBase(fatos, { ...camada, preparo }));
  }
  return { retratos, basesAprovadas: camada.basesAprovadas };
}

/**
 * Lotes a enviar: frases de frases-pendentes.json (todas ou as pedidas) e bases de bases-pendentes.json (todas ou as
 * pedidas). Tudo é conferido antes de qualquer envio. Devolve [{ lote, documento? }] e as bases já aprovadas.
 */
export async function prepararLotes({ dataDir, frases = null, bases = null, carregarBusca, executar = executarPonte }) {
  const todasAsPendentes = frases === null && bases === null;
  const docFrases = (await lerJsonOuNada(join(pastaCandidaturas(dataDir), 'frases-pendentes.json'))) ?? { versao: 1, frases: [] };
  const docBases = (await lerJsonOuNada(join(pastaCandidaturas(dataDir), 'bases-pendentes.json'))) ?? { versao: 1, bases: {} };
  const escolhidas = frases ?? (todasAsPendentes ? null : []);
  const pendentes = escolhidas === null ? docFrases.frases : escolhidas.map(id => {
    const item = docFrases.frases.find(frase => frase.id === id);
    if (!item) throw erro(`frase pendente não encontrada: ${id}`, 2);
    return item;
  });
  const nomes = bases ?? (todasAsPendentes ? Object.keys(docBases.bases ?? {}) : []);
  for (const base of nomes) conferirNomeDeBase(base);
  const lotes = lotesDeFrases(pendentes).map(lote => ({ lote }));
  const jaAprovadas = [];
  if (nomes.length) {
    const { retratos, basesAprovadas } = await retratosAtuais({ dataDir, search: await carregarBusca(), bases: nomes, executar });
    for (const base of nomes) {
      const retrato = retratos.get(base);
      const lote = loteDeBase({ base, retrato, basesAprovadas });
      if (lote) lotes.push({ lote, documento: documentoDoRetrato(retrato) });
      else jaAprovadas.push(base);
    }
  }
  return { lotes, jaAprovadas };
}

export async function gravarLote(dataDir, lote) {
  await mkdir(pastaDosLotes(dataDir), { recursive: true });
  const caminho = join(pastaDosLotes(dataDir), `${lote.loteId}.json`);
  await gravarJson(caminho, lote);
  return caminho;
}

/** Os lotes gravados, por message_id: Map<messageId, [{ lote, caminho }]> (mais de um = lote adulterado). */
export async function lotesPorMensagem(dataDir) {
  const mapa = new Map();
  let nomes;
  try { nomes = await readdir(pastaDosLotes(dataDir)); }
  catch (error) { if (error.code === 'ENOENT') return mapa; throw error; }
  for (const nome of nomes.filter(item => /^[0-9a-f]{12}\.json$/.test(item)).sort()) {
    const caminho = join(pastaDosLotes(dataDir), nome);
    let lote;
    try { lote = await lerJsonOuNada(caminho); } catch { continue; }
    for (const id of Array.isArray(lote?.mensagens) ? lote.mensagens : []) {
      if (!mapa.has(id)) mapa.set(id, []);
      mapa.get(id).push({ lote, caminho });
    }
  }
  return mapa;
}

const OBJETO = valor => valor !== null && typeof valor === 'object' && !Array.isArray(valor);

/**
 * Atualização do Telegram que pode valer como resposta: só `message`, da pessoa (`from.id` e `chat.id` iguais ao
 * chatId, conversa privada), respondendo a uma mensagem do próprio bot, sem encaminhamento, sem trecho citado e sem
 * remetente de bot, canal ou conta comercial. Devolve { mensagem } ou { motivo } (o motivo não leva texto nem nome).
 */
export function filtrarAtualizacao(update, { chatId, botId }) {
  if (!OBJETO(update?.message)) {
    const tipos = Object.keys(update ?? {}).filter(chave => chave !== 'update_id' && /^[a-z_]{1,40}$/.test(chave));
    return { motivo: `atualização do tipo ${tipos.join(', ') || 'desconhecido'} não é lida` };
  }
  const mensagem = update.message;
  if (mensagem.from?.is_bot === true) return { motivo: 'remetente é um bot' };
  if (mensagem.from?.id !== chatId) return { motivo: 'remetente não é a pessoa configurada' };
  if (mensagem.chat?.id !== chatId || mensagem.chat?.type !== 'private') return { motivo: 'fora da conversa privada com a pessoa' };
  if (['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date'].some(chave => mensagem[chave] != null)) {
    return { motivo: 'mensagem encaminhada' };
  }
  if (['via_bot', 'sender_chat', 'sender_business_bot', 'business_connection_id'].some(chave => mensagem[chave] != null) || mensagem.is_automatic_forward) {
    return { motivo: 'mensagem enviada por bot, canal ou conta comercial' };
  }
  if (mensagem.quote != null) return { motivo: 'resposta a um trecho do lote (citação)' };
  if (mensagem.external_reply != null) return { motivo: 'resposta a mensagem de outra conversa' };
  if (!OBJETO(mensagem.reply_to_message)) return { motivo: 'sem resposta ao lote' };
  if (mensagem.reply_to_message.from?.id !== botId) return { motivo: 'resposta a mensagem que não é do bot' };
  if (!Number.isSafeInteger(mensagem.message_id) || !Number.isSafeInteger(mensagem.date)) return { motivo: 'mensagem sem id ou sem data' };
  return { mensagem };
}

/**
 * Gramática fechada (23.4), depois de NFC, sem acento, minúsculo e espaços colapsados: "aprovo" (só em lote de 1),
 * "aprovo N [N...]" (distintos, de 1 ao tamanho) ou "nao N [motivo que começa por letra]". Fora disso, inválida inteira.
 */
export function lerResposta(texto, tamanho) {
  const invalida = motivo => ({ ok: false, motivo });
  if (typeof texto !== 'string' || !texto.trim()) return invalida('mensagem sem texto');
  const ponto = pontoDeControle(texto);
  if (ponto) return invalida(`texto com caractere de controle ${ponto}`);
  const normal = texto.normalize('NFC').normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const foraDoLote = numeros => numeros.find(n => n > tamanho);
  if (normal === 'aprovo') return tamanho === 1 ? { ok: true, decisao: 'aprovada', itens: [1] } : invalida('com mais de um item, diga os números');
  let achado = /^aprovo((?: [1-9]\d{0,3})+)$/.exec(normal);
  if (achado) {
    const itens = achado[1].trim().split(' ').map(Number);
    if (new Set(itens).size !== itens.length) return invalida('número repetido');
    const fora = foraDoLote(itens);
    if (fora !== undefined) return invalida(`item ${fora} fora do lote (1 a ${tamanho})`);
    return { ok: true, decisao: 'aprovada', itens };
  }
  achado = /^nao ([1-9]\d{0,3})(?: (\p{L}.*))?$/u.exec(normal);
  if (achado) {
    const n = Number(achado[1]);
    if (n > tamanho) return invalida(`item ${n} fora do lote (1 a ${tamanho})`);
    return { ok: true, decisao: 'recusada', itens: [n], motivo: achado[2] ?? null };
  }
  return invalida('fora da gramática (aprovo | aprovo N... | nao N motivo)');
}

function dataLocal(segundos) {
  const data = new Date(segundos * 1000);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

function loteBemFormado(lote) {
  return OBJETO(lote) && lote.versao === 1 && ['frases', 'base'].includes(lote.tipo) && typeof lote.sha256 === 'string' &&
    typeof lote.loteId === 'string' && Array.isArray(lote.itens) && lote.itens.length > 0 &&
    lote.itens.every((item, i) => OBJETO(item) && item.n === i + 1) && (lote.decisoes === undefined || OBJETO(lote.decisoes)) &&
    (lote.tipo === 'frases' ? lote.itens.every(item => typeof item.texto === 'string' && typeof item.origem === 'string')
      : lote.itens.length === 1 && typeof lote.itens[0].base === 'string');
}

/** Os arquivos que a aplicação lê e pode mudar, como estão na pasta de dados (ausente = vazio). */
export async function lerDocsDeAprovacao(dataDir) {
  const [frasesPendentes, frasesAprovadas, basesAprovadas, basesPendentes] = await Promise.all([
    lerJsonOuNada(join(pastaCandidaturas(dataDir), 'frases-pendentes.json')), lerJsonOuNada(join(dataDir, 'frases-aprovadas.json')),
    lerJsonOuNada(join(dataDir, 'bases-aprovadas.json')), lerJsonOuNada(join(pastaCandidaturas(dataDir), 'bases-pendentes.json')),
  ]);
  return { frasesPendentes: frasesPendentes ?? { versao: 1, frases: [] }, frasesAprovadas: frasesAprovadas ?? { versao: 1, frases: [] },
    basesAprovadas: basesAprovadas ?? { versao: 1, bases: {} }, basesPendentes: basesPendentes ?? null };
}

/**
 * Decide, sem gravar, o que uma resposta válida muda (23.5, 23.6). Confere: integridade e chatId do lote (no hash);
 * reply_to_message.chat.id igual ao chatId configurado e ao do lote; texto do lote
 * igual byte a byte ao que o Telegram diz que a pessoa leu (text ou caption) e lote sem edit_date; itens ainda sem
 * decisão contra as pendentes (frase) ou contra o retrato atual (base); no lote de base, file_unique_id e bytes baixados.
 * Devolve { ok: false, motivo, jaAplicada? } ou { ok: true, lote, frasesAprovadas?, frasesPendentes?, basesAprovadas?,
 * basesPendentes?, gravados }.
 */
export function aplicarRespostas({ lote, resposta, mensagem, chatId, docs, retratoAtual = null, bytesBaixados = null }) {
  const recusa = motivo => ({ ok: false, motivo });
  if (!loteBemFormado(lote)) return recusa(LOTE_MUDOU);
  if (lote.loteId !== sha256(jsonCanonico(lote.itens)).slice(0, 12) || hashDoLote(lote) !== lote.sha256) return recusa(LOTE_MUDOU);
  if (lote.chatId !== chatId) return recusa(LOTE_MUDOU);
  const lido = mensagem.reply_to_message;
  // A mensagem lida tem de estar na conversa configurada, a mesma para onde o lote foi enviado.
  if (lido.chat?.id !== chatId || lido.chat?.id !== lote.chatId) return recusa('resposta a mensagem de outra conversa');
  if (lido.edit_date !== undefined) return recusa(LOTE_MUDOU);
  if (textoDoLote(lote) !== (lote.tipo === 'frases' ? lido.text : lido.caption)) return recusa(LOTE_MUDOU);

  const decisoes = { ...(lote.decisoes ?? {}) };
  const decididos = resposta.itens.filter(n => Object.hasOwn(decisoes, String(n)));
  if (decididos.length) {
    if (decididos.length === resposta.itens.length && decididos.every(n => decisoes[n].messageId === mensagem.message_id)) {
      return { ok: false, jaAplicada: true, motivo: 'resposta já aplicada' };
    }
    return recusa(`resposta inválida: item ${decididos[0]} já decidido`);
  }
  const citados = resposta.itens.map(n => lote.itens[n - 1]);

  // (3) e (5): cada item citado, ainda sem decisão, tem de ser o mesmo de agora.
  if (lote.tipo === 'frases') {
    for (const item of citados) {
      const atual = docs.frasesPendentes.frases.find(frase => frase.id === item.id);
      if (!atual || atual.frase !== item.texto || atual.secao !== item.secao) return recusa(LOTE_MUDOU);
    }
  } else {
    const [item] = citados;
    if (!retratoAtual || hashRetrato(retratoAtual) !== item.hash) return recusa(LOTE_MUDOU);
    if (typeof lote.fileUniqueId !== 'string' || lido.document?.file_unique_id !== lote.fileUniqueId) return recusa(LOTE_MUDOU);
    const esperado = Buffer.from(documentoDoRetrato(retratoAtual), 'utf8');
    if (!bytesBaixados || !Buffer.from(bytesBaixados).equals(esperado) || sha256(esperado) !== lote.documentoSha256) return recusa(LOTE_MUDOU);
  }

  const em = dataLocal(mensagem.date);
  for (const n of resposta.itens) {
    decisoes[n] = { decisao: resposta.decisao, messageId: mensagem.message_id, em, ...(resposta.decisao === 'recusada' ? { motivo: resposta.motivo } : {}) };
  }
  const novoLote = { ...structuredClone(lote), decisoes };
  if (resposta.decisao === 'recusada') return { ok: true, lote: novoLote, gravados: [] };

  if (lote.tipo === 'frases') {
    const frasesAprovadas = structuredClone(docs.frasesAprovadas);
    const chaves = new Set(frasesAprovadas.frases.map(item => JSON.stringify(chaveDeEntrada(item.texto))));
    const gravados = [];
    for (const item of citados) {
      const chave = JSON.stringify(chaveDeEntrada(item.texto));
      if (chaves.has(chave)) continue;
      chaves.add(chave);
      frasesAprovadas.frases.push({ texto: item.texto, aprovadaEm: em, origem: `${item.origem} · telegram:${mensagem.message_id}` });
      gravados.push(item.id);
    }
    const ids = new Set(citados.map(item => item.id));
    const frasesPendentes = { ...docs.frasesPendentes, frases: docs.frasesPendentes.frases.filter(frase => !ids.has(frase.id)) };
    return { ok: true, lote: novoLote, frasesAprovadas, frasesPendentes, gravados };
  }
  const [item] = citados;
  const basesAprovadas = structuredClone(docs.basesAprovadas);
  basesAprovadas.bases[item.base] = { aprovadaEm: em, hash: item.hash, retrato: retratoAtual };
  let basesPendentes = null;
  if (docs.basesPendentes?.bases?.[item.base]) {
    basesPendentes = structuredClone(docs.basesPendentes);
    delete basesPendentes.bases[item.base];
  }
  return { ok: true, lote: novoLote, basesAprovadas, basesPendentes, gravados: [item.base] };
}

/** Grava o que aplicarRespostas decidiu: aprovações, depois pendentes, depois o lote (temporário + rename cada um). */
export async function gravarAplicacao(dataDir, resultado, caminhoDoLote) {
  if (resultado.frasesAprovadas) await gravarJson(join(dataDir, 'frases-aprovadas.json'), resultado.frasesAprovadas);
  if (resultado.basesAprovadas) await gravarJson(join(dataDir, 'bases-aprovadas.json'), resultado.basesAprovadas);
  if (resultado.frasesPendentes) await gravarJson(join(pastaCandidaturas(dataDir), 'frases-pendentes.json'), resultado.frasesPendentes);
  if (resultado.basesPendentes) await gravarJson(join(pastaCandidaturas(dataDir), 'bases-pendentes.json'), resultado.basesPendentes);
  await gravarJson(caminhoDoLote, resultado.lote);
}
