import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { initializeDataDir, loadSearch } from './data-dir.mjs';
import { aplicarFiltro } from './filter.mjs';
import { toDay, toJobs } from './page/view.mjs';
import {
  aplicarRespostas, aprovarBase, aprovarFrase, filtrarAtualizacao, gravarAplicacao, gravarLote, lerDocsDeAprovacao,
  lerResposta, LOTE_MUDOU, lotesPorMensagem, NAO_E_LOTE, prepararLotes, retratosAtuais, selarLote, textoDoLote,
} from './preparo/aprovacao.mjs';
import { conferirPacote, gravarJson, idCanonico, lerJsonOuNada, pastaCandidaturas, pastaSegura, preparar, verificarVariantes } from './preparo/pacote.mjs';
import { conferirPainel, gravarPainel, montarEntrada, resumoDoPainel } from './preparo/painel.mjs';
import { criarClienteTelegram, ErroTelegram, tokenValido } from './telegram.mjs';
import { selecionar } from './preparo/selecao.mjs';
import { contarGupy, TETO_GUPY } from './preparo/texto-gupy.mjs';
import { loadRounds } from './rounds.mjs';
import { limparRetornos, loadState, RETORNOS, setRetorno, setTriage, setTracking } from './state.mjs';
import { runTriage } from './triage-run.mjs';
import { schedule } from './schedule.mjs';
import { setup } from './setup.mjs';

const preparoCommands = ['contar-gupy', 'selecionar', 'verificar-variantes', 'preparar', 'conferir-pacote', 'painel-entrada', 'painel-gravar', 'aprovar-frase',
  'aprovar-base'];
const telegramCommands = ['pedir-aprovacao', 'receber-aprovacao', 'avisar-vaga', 'configurar-telegram'];
export const stateCommands = ['setup', 'paths', 'pending', 'show', 'triage', 'discards', 'track', 'triage-run', 'schedule', 'retorno', ...preparoCommands,
  ...telegramCommands];

// retorno <id> <valor> | retorno <id> --limpar | retorno --limpar-todos (T19; o desfazer da Fase 2).
async function retornoCommand(args, options) {
  const { stdout } = options;
  if (args.length === 1 && args[0] === '--limpar-todos') {
    const alteradas = await limparRetornos(options);
    stdout(`Retorno removido de ${alteradas} ${alteradas === 1 ? 'vaga' : 'vagas'}.`);
    return 0;
  }
  const [id, valor, ...rest] = args;
  if (!id || id.startsWith('--') || valor === undefined || rest.length) usage(`Use retorno <id> <${RETORNOS.join(' | ')}>, retorno <id> --limpar ou retorno --limpar-todos.`);
  if (valor !== '--limpar' && !RETORNOS.includes(valor)) usage(`Retorno inválido: use ${RETORNOS.join(', ')}.`);
  await setRetorno(id, valor === '--limpar' ? null : valor, options);
  stdout(valor === '--limpar' ? 'Retorno removido.' : `Retorno salvo: ${valor}.`);
  return 0;
}
const usage = message => { throw Object.assign(new Error(message), { exitCode: 2 }); };

function flags(args, allowed, switches = []) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const separator = args[i].indexOf('=');
    const key = separator < 0 ? args[i] : args[i].slice(0, separator);
    if (switches.includes(key) && separator >= 0) usage('Esta opção não recebe valor.');
    const value = switches.includes(key) ? true : separator < 0 ? args[++i] : args[i].slice(separator + 1);
    if (![...allowed, ...switches].includes(key) || value === undefined ||
        (key !== '--alert' && Object.hasOwn(values, key))) usage('Opções inválidas ou sem valor.');
    if (key === '--alert') (values[key] ??= []).push(value);
    else values[key] = value;
  }
  return values;
}

function positive(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    usage(`${label} precisa ser um inteiro positivo.`);
  }
  return Number(value);
}

// Terminal de verdade para a aprovação; os testes injetam `io` ({ isTTY, perguntar, escrever }).
function terminal(stdout) {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), escrever: stdout,
    async perguntar(pergunta) {
      const leitor = createInterface({ input: process.stdin, output: process.stdout });
      try { return await leitor.question(pergunta); } finally { leitor.close(); }
    },
    // Sem eco: o que a pessoa digita (o token) não aparece na tela nem fica no histórico do terminal.
    async perguntarSegredo(pergunta) {
      process.stdout.write(pergunta);
      const leitor = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      leitor._writeToOutput = () => {};
      try { return await leitor.question(''); } finally { leitor.close(); process.stdout.write('\n'); }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// T23 · Telegram (docs/spec.md 23.1, 23.2 a 23.7, 23.9, 23.11). Este trecho só liga as peças: lê a configuração,
// chama a rede por src/telegram.mjs e entrega os dados a src/preparo/aprovacao.mjs, que decide e grava as aprovações.

const sha256 = dados => createHash('sha256').update(dados).digest('hex');
const CONFIGURE = 'configure o Telegram';
const PRAZO_CONFIGURAR_MS = 5 * 60 * 1000;
const ESPERA_ENTRE_LEITURAS_MS = 2000;

/**
 * token e chatId: de telegram.json na pasta de dados (com ele presente, o ambiente é ignorado) ou do par
 * RADAR_TELEGRAM_TOKEN/RADAR_TELEGRAM_CHAT_ID que o main tirou de process.env. Nenhuma mensagem ecoa o conteúdo.
 */
async function configuracaoTelegram({ dataDir, ambienteTelegram = {} }) {
  let bruto;
  try { bruto = await readFile(join(dataDir, 'telegram.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') usage('não foi possível ler telegram.json; nada foi enviado.'); }
  let token, chatId;
  if (bruto !== undefined) {
    let doc;
    // A mensagem do JSON.parse pode trazer parte do arquivo (inclusive o token): fica de fora.
    try { doc = JSON.parse(bruto); } catch { usage('telegram.json não é JSON válido; nada foi enviado.'); }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) usage(`${CONFIGURE}: telegram.json precisa ser { "token": "...", "chatId": 123 }.`);
    const desconhecida = Object.keys(doc).find(chave => !['token', 'chatId'].includes(chave));
    if (desconhecida !== undefined) usage(`${CONFIGURE}: chave desconhecida em telegram.json (${/^[A-Za-z_]{1,30}$/.test(desconhecida) ? desconhecida : 'nome não mostrado'}); só token e chatId.`);
    ({ token, chatId } = doc);
    if (!tokenValido(token)) usage(`${CONFIGURE}: campo token de telegram.json ausente ou fora do formato <número>:<30 ou mais caracteres>.`);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) usage(`${CONFIGURE}: campo chatId de telegram.json precisa ser um inteiro positivo.`);
    return { token, chatId };
  }
  token = ambienteTelegram.RADAR_TELEGRAM_TOKEN;
  const chat = ambienteTelegram.RADAR_TELEGRAM_CHAT_ID;
  if (token === undefined && chat === undefined) usage(`${CONFIGURE}: rode configurar-telegram (grava telegram.json) ou defina RADAR_TELEGRAM_TOKEN e RADAR_TELEGRAM_CHAT_ID.`);
  if (token === undefined) usage(`${CONFIGURE}: falta RADAR_TELEGRAM_TOKEN (o par vai inteiro).`);
  if (chat === undefined) usage(`${CONFIGURE}: falta RADAR_TELEGRAM_CHAT_ID (o par vai inteiro).`);
  if (!tokenValido(token)) usage(`${CONFIGURE}: RADAR_TELEGRAM_TOKEN fora do formato <número>:<30 ou mais caracteres>.`);
  chatId = /^\d{1,15}$/.test(chat) ? Number(chat) : NaN;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) usage(`${CONFIGURE}: RADAR_TELEGRAM_CHAT_ID precisa ser um inteiro positivo.`);
  return { token, chatId };
}

// O endereço da API, o fetch, o prazo, o relógio e o sleep só vêm do código (os testes injetam `telegramApi`).
function clienteTelegram(token, options) {
  const { apiBase, fetch, prazoMs, sleep, agora } = options.telegramApi ?? {};
  return criarClienteTelegram(Object.fromEntries(Object.entries({ token, apiBase, fetch, prazoMs, sleep, agora })
    .filter(([, valor]) => valor !== undefined)));
}

function relogioTelegram(options) {
  const { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), agora = Date.now } = options.telegramApi ?? {};
  return { sleep, agora };
}

// pedir-aprovacao [--frase <id>]... [--base <base>]... [--previa]
async function pedirAprovacao(args, ctx) {
  const { dataDir, stdout } = ctx;
  const frases = [], bases = [];
  let previa = false;
  for (let i = 0; i < args.length; i++) {
    const [chave, valorJunto] = args[i].includes('=') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i]];
    if (chave === '--previa' && valorJunto === undefined) { previa = true; continue; }
    const valor = valorJunto ?? args[++i];
    if (!['--frase', '--base'].includes(chave) || valor === undefined || valor === '') usage('Use pedir-aprovacao [--frase <id>]... [--base <base>]... [--previa].');
    (chave === '--frase' ? frases : bases).push(valor);
  }
  const config = previa ? null : await configuracaoTelegram(ctx);
  const pedidas = frases.length || bases.length;
  const { lotes, jaAprovadas } = await prepararLotes({ dataDir, frases: pedidas ? frases : null, bases: pedidas ? bases : null,
    carregarBusca: () => loadSearch(ctx) });
  for (const base of jaAprovadas) stdout(`A base "${base}" já está aprovada; fica fora do lote.`);
  if (!lotes.length) { stdout('Nada pendente de aprovação.'); return 0; }
  if (previa) {
    for (const { lote, documento } of lotes) {
      stdout(`--- Lote ${lote.loteId} (${lote.tipo === 'frases' ? 'frases' : 'base'}): ${lote.itens.length} ${lote.itens.length === 1 ? 'item' : 'itens'}`);
      if (documento) stdout(`Documento retrato-${lote.itens[0].base}.txt: ${documento.split('\n').filter(Boolean).length - 1} itens do retrato. Legenda:`);
      stdout(textoDoLote(lote));
    }
    stdout(`Prévia: ${lotes.length} ${lotes.length === 1 ? 'lote' : 'lotes'}; nada foi enviado nem gravado.`);
    return 0;
  }
  const cliente = clienteTelegram(config.token, ctx);
  for (const { lote, documento } of lotes) {
    const texto = textoDoLote(lote);
    const enviadoEm = () => new Date().toISOString();
    if (lote.tipo === 'frases') {
      const mensagem = await cliente.enviarTexto(config.chatId, texto);
      if (mensagem.text !== texto) throw Object.assign(new Error(`o Telegram alterou o texto do lote ${lote.loteId}; o lote não foi gravado (a resposta nunca bateria).`), { exitCode: 1 });
      await gravarLote(dataDir, { ...selarLote(lote, config.chatId), mensagens: [mensagem.message_id], enviadoEm: enviadoEm(), decisoes: {} });
    } else {
      const bytes = Buffer.from(documento, 'utf8');
      const mensagem = await cliente.enviarDocumento(config.chatId, { nome: `retrato-${lote.itens[0].base}.txt`, bytes, caption: texto, tipo: 'text/plain' });
      if (mensagem.caption !== texto) throw Object.assign(new Error(`o Telegram alterou o texto do lote ${lote.loteId}; o lote não foi gravado (a resposta nunca bateria).`), { exitCode: 1 });
      const fileUniqueId = mensagem.document?.file_unique_id;
      if (typeof fileUniqueId !== 'string' || !fileUniqueId) throw Object.assign(new Error(`o Telegram não devolveu o documento do lote ${lote.loteId}; o lote não foi gravado.`), { exitCode: 1 });
      await gravarLote(dataDir, { ...selarLote(lote, config.chatId), mensagens: [mensagem.message_id], fileUniqueId, documentoSha256: sha256(bytes),
        enviadoEm: enviadoEm(), decisoes: {} });
    }
    stdout(`Lote ${lote.loteId} enviado (${lote.tipo === 'frases' ? `${lote.itens.length} ${lote.itens.length === 1 ? 'frase' : 'frases'}` : `base ${lote.itens[0].base}`}).`);
  }
  return 0;
}

// receber-aprovacao: lê as atualizações novas, grava o que a pessoa aprovou e avança o offset (23.3 a 23.7).
async function receberAprovacao(args, ctx) {
  const { dataDir, stdout } = ctx;
  if (args.length) usage('receber-aprovacao não recebe argumentos.');
  const config = await configuracaoTelegram(ctx);
  const cliente = clienteTelegram(config.token, ctx);
  const bot = await cliente.quemSouEu();
  const pasta = pastaCandidaturas(dataDir);
  const caminhoOffset = join(pasta, 'telegram-offset.json');
  const docOffset = await lerJsonOuNada(caminhoOffset);
  if (docOffset !== undefined && (docOffset?.versao !== 1 || !Number.isSafeInteger(docOffset.offset))) {
    throw Object.assign(new Error('candidaturas/telegram-offset.json fora do formato { versao: 1, offset }; o arquivo foi preservado.'), { exitCode: 1 });
  }
  const offset = docOffset?.offset;
  const atualizacoes = (await cliente.lerAtualizacoes({ ...(offset === undefined ? {} : { offset }), limit: 100, timeout: 0 }))
    .filter(update => Number.isSafeInteger(update?.update_id) && (offset === undefined || update.update_id >= offset))
    .sort((a, b) => a.update_id - b.update_id);
  if (!atualizacoes.length) { stdout('0 atualizações novas.'); return 0; }
  const gravarOffset = ctx.gravarOffset ?? gravarJson;
  const caminhoIgnorados = join(pasta, 'telegram-ignorados.json');
  let busca;
  let gravadas = 0;
  for (const update of atualizacoes) {
    const ignorar = async motivo => {
      const doc = (await lerJsonOuNada(caminhoIgnorados)) ?? { versao: 1, ignorados: [] };
      doc.ignorados = [...(Array.isArray(doc.ignorados) ? doc.ignorados : []), { update_id: update.update_id, motivo, em: new Date().toISOString() }].slice(-500);
      await mkdir(pasta, { recursive: true });
      await gravarJson(caminhoIgnorados, doc);
      stdout(`Atualização ${update.update_id} ignorada: ${motivo}.`);
    };
    const filtro = filtrarAtualizacao(update, { chatId: config.chatId, botId: bot.id });
    if (filtro.motivo) await ignorar(filtro.motivo);
    else {
      const { mensagem } = filtro;
      const achados = (await lotesPorMensagem(dataDir)).get(mensagem.reply_to_message.message_id) ?? [];
      if (!achados.length) await ignorar(NAO_E_LOTE);
      else if (achados.length > 1) await ignorar(LOTE_MUDOU);
      else {
        const { lote, caminho } = achados[0];
        const resposta = lerResposta(mensagem.text, Array.isArray(lote?.itens) ? lote.itens.length : 0);
        if (!resposta.ok) await ignorar(`resposta inválida, nada aplicado: ${resposta.motivo}`);
        else {
          let retratoAtual = null, bytesBaixados = null, semBase = false;
          if (lote.tipo === 'base' && typeof lote.itens?.[0]?.base === 'string') {
            try {
              busca ??= await loadSearch(ctx);
              retratoAtual = (await retratosAtuais({ dataDir, search: busca, bases: [lote.itens[0].base] })).retratos.get(lote.itens[0].base);
            } catch (error) { if (error.exitCode !== 2) throw error; semBase = true; }
            const fileId = mensagem.reply_to_message.document?.file_id;
            if (!semBase && typeof fileId === 'string' && fileId) bytesBaixados = (await cliente.baixarArquivo(fileId)).bytes;
          }
          const resultado = aplicarRespostas({ lote, resposta, mensagem, chatId: config.chatId, docs: await lerDocsDeAprovacao(dataDir),
            retratoAtual, bytesBaixados });
          if (resultado.jaAplicada) stdout(`Atualização ${update.update_id}: resposta já aplicada antes; nada duplicado.`);
          else if (!resultado.ok) await ignorar(resultado.motivo);
          else {
            await gravarAplicacao(dataDir, resultado, caminho);
            gravadas++;
            stdout(resposta.decisao === 'recusada'
              ? `Lote ${lote.loteId}: item ${resposta.itens[0]} recusado pela pessoa; continua pendente.`
              : `Lote ${lote.loteId}: aprovado pela pessoa ${resposta.itens.length === 1 ? 'o item' : 'os itens'} ${resposta.itens.join(', ')}.`);
          }
        }
      }
    }
    // O offset só avança depois das gravações desta atualização (23.7).
    await mkdir(pasta, { recursive: true });
    await gravarOffset(caminhoOffset, { versao: 1, offset: update.update_id + 1 });
  }
  stdout(`${atualizacoes.length} ${atualizacoes.length === 1 ? 'atualização lida' : 'atualizações lidas'}; ${gravadas} ${gravadas === 1 ? 'resposta aplicada' : 'respostas aplicadas'}.`);
  return 0;
}

// avisar-vaga <id>: confere o pacote e o painel antes de qualquer envio e manda o resumo, o texto da Gupy e o PDF (23.9).
async function avisarVaga(args, ctx) {
  const { dataDir, stdout } = ctx;
  if (args.length !== 1 || args[0].startsWith('--')) usage('Use avisar-vaga <id>.');
  const config = await configuracaoTelegram(ctx);
  const state = await loadState(ctx);
  const id = args[0];
  const { pdf } = await conferirPacote({ dataDir, state, id });
  const painel = await conferirPainel({ dataDir, state, id });
  const resumo = await resumoDoPainel({ dataDir, state, id });
  const canonico = idCanonico(state, id);
  const pasta = pastaSegura(dataDir, canonico);
  const pacote = await lerJsonOuNada(join(pasta, 'pacote.json'));
  const job = state.jobs[canonico].job;
  const veracidade = await lerJsonOuNada(join(pasta, 'veracidade.json'));
  const ficha = await readFile(join(pasta, 'ficha.md'), 'utf8').catch(() => '');
  const gate = /^- Gate do CV: (.+)$/m.exec(ficha)?.[1] ?? 'aprovado';
  const linhasDoPainel = resumo
    ? ['Painel:', ...resumo.vereditos.map(({ revisor, veredito }) => `- ${revisor}: ${veredito}`),
      ...(resumo.erros.length ? ['Erros principais:', ...resumo.erros.map(({ trecho, porQue }, i) => `${i + 1}. "${trecho}": ${porQue}`)] : [])]
    : [painel.mensagem];
  const texto = [`Pacote pronto: ${job.title}`, `Empresa: ${job.company}`, `Fonte: ${job.source}`, `Link de candidatura: ${job.applyUrl ?? job.url}`,
    `Variante do CV: ${pacote.variante}`, `Por que esta variante: ${pacote.porque}`,
    `Veracidade: ${veracidade?.aprovado ? 'aprovada' : 'não confirmada'}`, `Gate do CV: ${gate}`, '', ...linhasDoPainel,
    '', 'Nada foi enviado à empresa: a candidatura é sua.'].join('\n');
  let gupy = null;
  if (pacote.textoGupy) {
    gupy = await readFile(join(pasta, 'texto-gupy.txt'), 'utf8').catch(() => null);
    if (!gupy || !gupy.trim()) throw Object.assign(new Error('o pacote é da Gupy e texto-gupy.txt sumiu da pasta: refaça o preparar. Nada foi enviado.'), { exitCode: 1 });
  }
  const bytes = await readFile(pdf);
  if (sha256(bytes) !== pacote.pdfSha256) throw Object.assign(new Error('PDF mudou depois do preparo: refaça o preparar. Nada foi enviado.'), { exitCode: 1 });
  for (const parte of [texto, gupy].filter(Boolean)) {
    if (parte.length > 4096) throw Object.assign(new Error('mensagem acima de 4.096 caracteres; nada foi enviado.'), { exitCode: 1 });
  }
  const cliente = clienteTelegram(config.token, ctx);
  const mensagens = { resumo: (await cliente.enviarTexto(config.chatId, texto)).message_id };
  if (gupy) mensagens.textoGupy = (await cliente.enviarTexto(config.chatId, gupy)).message_id;
  mensagens.pdf = (await cliente.enviarDocumento(config.chatId, { nome: basename(pdf), bytes, tipo: 'application/pdf' })).message_id;
  await gravarJson(join(pasta, 'avisos-telegram.json'), { versao: 1, id: canonico, enviadoEm: new Date().toISOString(), pdfSha256: pacote.pdfSha256, mensagens });
  stdout(`Vaga ${canonico} enviada ao Telegram: resumo${gupy ? ', texto da Gupy' : ''} e PDF.`);
  return 0;
}

// Atualização com o código de configuração: só em conversa privada, da própria pessoa, sem encaminhamento.
function motivoDoCodigo(update, codigo) {
  const mensagem = update?.message;
  if (!mensagem || typeof mensagem !== 'object') return 'atualização que não é mensagem';
  if (mensagem.chat?.type !== 'private') return 'mensagem fora de conversa privada';
  if (mensagem.from?.is_bot === true) return 'remetente é um bot';
  if (!Number.isSafeInteger(mensagem.from?.id) || mensagem.from.id !== mensagem.chat?.id) return 'remetente diferente da conversa';
  if (['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'via_bot', 'sender_chat'].some(chave => mensagem[chave] != null)) {
    return 'mensagem encaminhada ou enviada por bot ou canal';
  }
  if (typeof mensagem.text !== 'string' || mensagem.text.trim() !== codigo) return 'mensagem sem o código';
  return null;
}

// configurar-telegram: feito pela pessoa, no terminal dela, uma vez, com um bot só do radar (23.11).
async function configurarTelegram(args, ctx) {
  const { dataDir } = ctx;
  if (args.length) usage('configurar-telegram não recebe argumentos.');
  const io = ctx.io ?? terminal(ctx.stdout);
  if (!io?.isTTY) usage('configuração do Telegram só pela pessoa, no terminal: rode o comando você mesmo. Nada foi gravado.');
  const escrever = io.escrever ?? ctx.stdout;
  const token = String(await (io.perguntarSegredo ?? io.perguntar)('Token do bot (do BotFather; não aparece na tela): ') ?? '').trim();
  if (!tokenValido(token)) usage(`${CONFIGURE}: token fora do formato <número>:<30 ou mais caracteres>. Nada foi gravado.`);
  const cliente = clienteTelegram(token, ctx);
  const { sleep, agora } = relogioTelegram(ctx);
  const bot = await cliente.quemSouEu();
  const webhook = await cliente.lerWebhook();
  if (webhook.url) usage('este bot já é usado por outro serviço (tem webhook ativo): crie um bot só para o radar. Nada foi gravado.');
  if (Number(webhook.pending_update_count) > 0) {
    usage(`este bot tem ${Number(webhook.pending_update_count)} atualizações pendentes de outro uso: crie um bot só para o radar (outro programa que lê o mesmo bot consome as respostas). Nada foi gravado.`);
  }
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  escrever(`Do celular, abra a conversa privada com @${bot.username ?? 'o bot'} e mande só este código: ${codigo}`);
  escrever('Esperando até 5 minutos...');
  const prazo = agora() + PRAZO_CONFIGURAR_MS;
  let offset, chatId = null;
  while (chatId === null && agora() < prazo) {
    const atualizacoes = await cliente.lerAtualizacoes({ ...(offset === undefined ? {} : { offset }), limit: 100, timeout: 0 });
    for (const update of atualizacoes.filter(item => Number.isSafeInteger(item?.update_id)).sort((a, b) => a.update_id - b.update_id)) {
      offset = update.update_id + 1;
      const motivo = motivoDoCodigo(update, codigo);
      if (motivo === null) { chatId = update.message.from.id; break; }
      escrever(`Mensagem ignorada: ${motivo}.`);
    }
    if (chatId === null) await sleep(ESPERA_ENTRE_LEITURAS_MS);
  }
  if (chatId === null) throw Object.assign(new Error('5 minutos sem o código: nada foi gravado. Rode configurar-telegram de novo.'), { exitCode: 1 });
  await gravarJson(join(dataDir, 'telegram.json'), { token, chatId });
  await mkdir(pastaCandidaturas(dataDir), { recursive: true });
  await gravarJson(join(pastaCandidaturas(dataDir), 'telegram-offset.json'), { versao: 1, offset });
  await cliente.enviarTexto(chatId, 'radar configurado');
  escrever(`Telegram configurado com o bot @${bot.username ?? 'sem nome'}; a confirmação foi enviada ao seu chat.`);
  return 0;
}

async function telegramCommand(command, args, options) {
  const dataDir = await initializeDataDir(options);
  const ctx = { ...options, dataDir };
  try {
    if (command === 'pedir-aprovacao') return await pedirAprovacao(args, ctx);
    if (command === 'receber-aprovacao') return await receberAprovacao(args, ctx);
    if (command === 'avisar-vaga') return await avisarVaga(args, ctx);
    return await configurarTelegram(args, ctx);
  } catch (error) {
    // Erro da rede já sai redigido (bot***); aqui só vira o código de saída do comando.
    if (error instanceof ErroTelegram) throw Object.assign(new Error(error.message), { exitCode: error.codigo });
    throw error;
  }
}

async function preparoCommand(command, args, options) {
  const { stdout, stderr } = options;
  const json = value => stdout(JSON.stringify(value, null, 2));
  if (command === 'contar-gupy') {
    if (args.length !== 1 || args[0].startsWith('--')) usage('Use contar-gupy <arquivo>.');
    let texto;
    try { texto = await readFile(args[0], 'utf8'); } catch { usage(`Não foi possível ler o arquivo ${args[0]}.`); }
    const contagem = contarGupy(texto);
    if (contagem.aprovado) { stdout(`${contagem.caracteres} caracteres (teto ${TETO_GUPY})`); return 0; }
    stdout(`${contagem.caracteres} caracteres (teto ${TETO_GUPY}): REPROVADO${contagem.caracteres <= TETO_GUPY && contagem.motivo ? ` (${contagem.motivo})` : ''}`);
    return 1;
  }
  const dataDir = await initializeDataDir(options);
  const context = { ...options, dataDir };
  if (command === 'selecionar') {
    const value = flags(args, ['--rodadas']);
    const rodadas = value['--rodadas'] === undefined ? undefined : positive(value['--rodadas'], 'O número de rodadas');
    const [search, state, rounds] = await Promise.all([loadSearch(context), loadState(context), loadRounds(context)]);
    const judge = search.filtro ? job => aplicarFiltro(job, search.filtro, search.termos) : undefined;
    // Sem --rodadas, as vagas do dia (última rodada); com ele, a janela das últimas N rodadas, com as cortadas marcadas.
    const entradas = rodadas === undefined
      ? (({ mostradas, cortadas }) => [...mostradas, ...cortadas])(toDay(state, rounds, judge))
      : toJobs(state).map(entry => {
        const veredito = judge?.(entry.job);
        return veredito && !veredito.passa ? { ...entry, motivo: veredito.motivo } : entry;
      });
    const resultado = rounds.length ? selecionar(entradas, { quantidade: 5, rodadas, rounds })
      : { ok: false, selecionadas: [], faltam: 5, restricaoFalhou: 'sem rodada registrada' };
    json({ ok: resultado.ok, restricaoFalhou: resultado.restricaoFalhou, faltam: resultado.faltam,
      selecionadas: resultado.selecionadas.map(({ id, job, triage }) => ({ id, titulo: job.title, empresa: job.company,
        fonte: job.source, estrelas: triage.fit, link: job.applyUrl ?? job.url })) });
    if (!resultado.ok) { stderr(`A seleção não fechou a regra: ${resultado.restricaoFalhou}.`); return 1; }
    return 0;
  }
  if (command === 'verificar-variantes') {
    if (args.length) usage('Este comando não recebe argumentos.');
    const resultado = await verificarVariantes({ dataDir, search: await loadSearch(context) });
    stdout(`${resultado.total} variantes verificadas; ${resultado.bloqueadas.length} bloqueadas.`);
    for (const { variante, falhas } of resultado.bloqueadas) stdout(`- ${variante}: ${[...new Set(falhas.map(falha => falha.checagem))].join(', ')}`);
    if (resultado.basesPendentes.length) stdout(`Bases pendentes de aprovação: ${resultado.basesPendentes.join(', ')}.`);
    return resultado.bloqueadas.length ? 1 : 0;
  }
  if (command === 'aprovar-frase' || command === 'aprovar-base') {
    if (args.length !== 1 || args[0].startsWith('--')) usage(`Use ${command} <${command === 'aprovar-frase' ? 'id' : 'base'}>.`);
    const io = options.io ?? terminal(stdout);
    if (command === 'aprovar-frase') return aprovarFrase({ dataDir, id: args[0], io });
    return aprovarBase({ dataDir, base: args[0], io, search: await loadSearch(context) });
  }
  const [id, ...rest] = args;
  if (!id || id.startsWith('--')) usage('Informe o identificador da vaga.');
  const state = await loadState(context);
  if (command === 'conferir-pacote') {
    if (rest.length) usage('Use conferir-pacote <id>.');
    const { pdf } = await conferirPacote({ dataDir, state, id });
    stdout(`PDF conferido: ${pdf}`);
    // O painel é conferido depois do PDF, sem mudar pacote.mjs (22.7, 22.8).
    stdout((await conferirPainel({ dataDir, state, id })).mensagem);
    return 0;
  }
  if (command === 'painel-entrada') {
    if (rest.length) usage('Use painel-entrada <id>.');
    const { caminho, sha256 } = await montarEntrada({ dataDir, state, id });
    stdout(`Entrada do painel: ${caminho}`);
    stdout(`sha256: ${sha256}`);
    return 0;
  }
  if (command === 'painel-gravar') {
    if (rest.length !== 1 || rest[0].startsWith('--')) usage('Use painel-gravar <id> <arquivo>.');
    const { caminho } = await gravarPainel({ dataDir, state, id, arquivo: rest[0] });
    stdout(`Painel gravado: ${caminho}`);
    return 0;
  }
  // preparar: o contador de rede envolve o fetch do processo durante a execução (17.5).
  const value = flags(rest, ['--variante', '--porque']);
  if (value['--porque'] !== undefined && value['--variante'] === undefined) usage('--porque só vale junto de --variante.');
  const search = await loadSearch(context);
  const original = globalThis.fetch, real = options.fetch ?? original;
  let requisicoes = 0;
  globalThis.fetch = (...argumentos) => { requisicoes++; return real(...argumentos); };
  try {
    const { pasta } = await preparar({ dataDir, search, state, id, variante: value['--variante'], porque: value['--porque'],
      requisicoes: () => requisicoes });
    stdout(`Pacote pronto em ${pasta}.`);
    return 0;
  } finally {
    globalThis.fetch = original;
    stdout(`Requisições de rede: ${requisicoes}`);
  }
}

export async function stateCommand(command, args, options) {
  const { stdout, stderr } = options;
  if (preparoCommands.includes(command)) return preparoCommand(command, args, options);
  if (telegramCommands.includes(command)) return telegramCommand(command, args, options);
  if (command === 'retorno') return retornoCommand(args, options);
  const json = value => stdout(JSON.stringify(value));
  if (['setup', 'paths', 'discards', 'triage-run'].includes(command) && args.length) usage('Este comando não recebe argumentos.');
  if (command === 'setup') return setup(options);
  if (command === 'paths') {
    const dataDir = await initializeDataDir(options);
    const resumes = join(dataDir, 'curriculos'), interviews = join(dataDir, 'entrevistas');
    await mkdir(resumes, { recursive: true });
    await mkdir(interviews, { recursive: true });
    json({ dataDir, profile: join(dataDir, 'perfil.md'), search: join(dataDir, 'busca.json'),
      ruler: join(dataDir, 'regua.md'), resumes, interviews });
  } else if (command === 'pending') {
    const value = flags(args, ['--limit'], ['--incluir-cortadas']);
    const explicit = value['--limit'] === undefined ? null : positive(value['--limit'], 'O limite');
    const search = await loadSearch(options);
    const limit = explicit ?? search.tetoTriagemPorRodada ?? 30;
    const state = await loadState(options);
    const candidates = Object.entries(state.jobs).filter(([, entry]) => !entry.triage && !entry.mark)
      .map(([id, { job, seen }]) => ({ id, job, seen }))
      .sort((a, b) => b.seen.firstSeenAt.localeCompare(a.seen.firstSeenAt) || a.id.localeCompare(b.id));
    // As cortadas saem antes do teto, senão o teto é gasto nelas (decisão P4, reversível com a opção).
    const skipCut = search.filtro && !value['--incluir-cortadas'];
    const pending = skipCut ? candidates.filter(({ job }) => aplicarFiltro(job, search.filtro, search.termos).passa) : candidates;
    json(pending.slice(0, limit));
    stderr(`${Math.max(0, pending.length - limit)} vagas ficaram para a próxima rodada.`);
    if (skipCut) stderr(`${candidates.length - pending.length} vagas cortadas pelo filtro ficaram fora da triagem. Use --incluir-cortadas para vê-las.`);
  } else if (command === 'discards') {
    const state = await loadState(options);
    json(Object.entries(state.jobs).filter(([, entry]) => entry.mark?.status === 'discarded')
      .map(([id, { job, mark }]) => ({ id, title: job.title, company: job.company,
        cutReason: mark.cutReason, markedAt: mark.markedAt })));
  } else if (command === 'triage-run') {
    return runTriage(options);
  } else if (command === 'schedule') {
    const [action, ...rest] = args;
    if (!['on', 'off', 'status'].includes(action)) usage('Use schedule on, off ou status.');
    const value = flags(rest, action === 'on' ? ['--hours'] : []);
    const hours = positive(value['--hours'] ?? 6, 'O intervalo');
    if (hours > 744) usage('O intervalo máximo é 744 horas (31 dias).');
    const result = await schedule(action, { ...options, hours });
    stdout(`Agendamento ${result.enabled ? 'ligado' : 'desligado'}.${result.enabled ? ` Próxima execução: ${result.nextRun ?? 'não informada pelo sistema'}.` : ''}`);
    stderr('Com a máquina desligada, o radar não roda. A retomada depende de ligar e entrar na conta do usuário.');
  } else {
    const [id, ...rest] = args;
    if (!id || id.startsWith('--')) usage('Informe o identificador da vaga.');
    const value = flags(rest, command === 'triage' ? ['--fit', '--reason', '--alert']
      : command === 'track' ? ['--stage', '--next', '--notes'] : [],
    command === 'track' ? ['--clear-next', '--clear-notes'] : []);
    let block;
    if (command === 'triage') {
      const fit = positive(value['--fit'], 'A nota');
      if (fit > 5 || !value['--reason']?.trim() || value['--alert']?.some(alert => !alert.trim())) {
        usage('Use nota de 1 a 5, motivo e alertas não vazios.');
      }
      block = { fit, reason: value['--reason'], alerts: value['--alert'] ?? [] };
    } else if (command === 'track') {
      if (!value['--stage']?.trim()) usage('Informe a etapa com --stage.');
      block = { stage: value['--stage'] };
      for (const field of ['next', 'notes']) {
        if (value[`--clear-${field}`] && Object.hasOwn(value, `--${field}`)) {
          usage(`Use --${field} ou --clear-${field}, sem combinar as duas opções.`);
        }
        if (Object.hasOwn(value, `--${field}`)) block[field] = value[`--${field}`];
        if (value[`--clear-${field}`]) block[field] = field === 'next' ? null : '';
      }
    }
    const state = await loadState(options);
    const canonical = Object.hasOwn(state.jobs, id) ? id : Object.hasOwn(state.aliases, id) ? state.aliases[id] : null;
    if (!canonical) usage('Vaga não encontrada.');
    if (command === 'show') json(state.jobs[canonical]);
    else {
      await (command === 'triage' ? setTriage : setTracking)(id, block, options);
      stdout(command === 'triage' ? 'Triagem salva.' : 'Acompanhamento salvo.');
    }
  }
  return 0;
}
