// Cliente da Bot API do Telegram (T23). Único arquivo de src/ que fala com o Telegram.
//
// O que este módulo faz e o que ele não faz:
// - faz as chamadas HTTP; não lê configuração, não lê o ambiente do processo, não grava arquivo (sem node:fs);
// - o endereço da API (apiBase) só muda por opção de código (o teste passa o servidor falso);
//   a configuração da pessoa nunca troca o endereço, então editar a pasta de dados não desvia o token;
// - o token nunca sai em mensagem de erro, em stack nem em `cause`: toda URL e todo texto vindo
//   da rede passam por `redigirToken`, que troca o token por `***` (a URL fica `.../bot***/metodo`).
//
// API exportada:
//   criarClienteTelegram({ token, apiBase?, fetch?, prazoMs?, sleep?, agora? }) -> cliente
//     token: '^\d+:[A-Za-z0-9_-]{30,}$'; fora disso lança ErroTelegram tipo 'entrada' sem requisição.
//     prazoMs: prazo de cada requisição (padrão PRAZO_MS = 15000), por AbortSignal.timeout.
//     sleep(ms) e agora() injetáveis (padrão: setTimeout e Date.now).
//   cliente.quemSouEu()                         -> result do getMe ({ id, is_bot, username, ... })
//   cliente.lerWebhook()                        -> result do getWebhookInfo ({ url, pending_update_count, ... })
//   cliente.enviarTexto(chatId, texto, { responderA? })
//                                               -> result do sendMessage (a Message, com `text` e `message_id`)
//     texto puro: nunca manda parse_mode. responderA cita a mensagem (reply_parameters, sem exigir que ela exista).
//   cliente.enviarDocumento(chatId, { nome, bytes, caption?, tipo? })
//                                               -> result do sendDocument (a Message, com `caption` e `document`)
//   cliente.lerAtualizacoes({ offset?, limit = 100, timeout = 0, allowedUpdates? })
//                                               -> array de Update, como o servidor devolveu
//   cliente.baixarArquivo(fileId)               -> { bytes: Uint8Array, filePath, fileUniqueId }
//     getFile seguido do download em `${apiBase}/file/bot<token>/<file_path>` (teto TETO_ARQUIVO_BYTES).
//   ErroTelegram: { message, tipo, codigo, status?, metodo }
//     tipo: 'entrada' (codigo 2, nada foi enviado) | 'autorizacao' (401/403, "token inválido ou bot bloqueado")
//           | 'limite' (429 esgotado) | 'servidor' (5xx esgotado) | 'prazo' | 'conexao'
//           | 'resposta' (ok:false, JSON inválido, HTTP 4xx, formato inesperado) | 'tamanho'; todos codigo 1 menos 'entrada'.
//   redigirToken(texto, token) -> texto sem o token.
//   tokenValido(token), FORMATO_TOKEN, PRAZO_MS, INTERVALO_ENVIO_MS, TETO_RETRY_AFTER_MS,
//   TENTATIVAS_429, ESPERAS_5XX_MS, TETO_ARQUIVO_BYTES.
//
// Política de rede (23.8): 429 espera `parameters.retry_after` (teto 60 s) e tenta até 3 vezes ao todo;
// 5xx espera 1 s, 2 s e 4 s antes de cada nova tentativa (até 4 ao todo); 401 e 403 não tentam de novo;
// prazo estourado e conexão recusada não tentam de novo (um envio repetido às cegas pode duplicar a mensagem);
// entre dois envios (sendMessage, sendDocument, inclusive novas tentativas) há pelo menos 1 s.

export const FORMATO_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
export const PRAZO_MS = 15000;
export const INTERVALO_ENVIO_MS = 1000;
export const TETO_RETRY_AFTER_MS = 60000;
export const TENTATIVAS_429 = 3;
export const ESPERAS_5XX_MS = [1000, 2000, 4000];
export const TETO_ARQUIVO_BYTES = 20 * 1024 * 1024;

const API_PADRAO = 'https://api.telegram.org';
const METODOS_DE_ENVIO = new Set(['sendMessage', 'sendDocument']);

export class ErroTelegram extends Error {
  constructor(mensagem, { tipo, metodo, status } = {}) {
    super(mensagem);
    this.name = 'ErroTelegram';
    this.tipo = tipo;
    this.codigo = tipo === 'entrada' ? 2 : 1;
    this.metodo = metodo;
    if (status !== undefined) this.status = status;
  }
}

export function tokenValido(token) {
  return typeof token === 'string' && FORMATO_TOKEN.test(token);
}

export function redigirToken(texto, token) {
  let saida = String(texto);
  if (typeof token === 'string' && token) {
    for (const forma of new Set([token, encodeURIComponent(token)])) saida = saida.split(forma).join('***');
  }
  // Qualquer coisa com cara de token que tenha escapado (outro token, URL de outro bot).
  return saida.replace(/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi, 'bot***');
}

function esperarPadrao(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// partes: [nome, texto] ou [nome, bytes, nomeDoArquivo, tipo]. Os bytes de cada parte vão sem conversão.
function multipart(partes) {
  const fronteira = `radar-${crypto.randomUUID()}`;
  const codificar = texto => new TextEncoder().encode(texto);
  const pedacos = [];
  for (const [nome, valor, arquivo, tipo] of partes) {
    const cabecalho = arquivo === undefined
      ? `--${fronteira}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n`
      : `--${fronteira}\r\nContent-Disposition: form-data; name="${nome}"; filename="${arquivo}"\r\nContent-Type: ${tipo}\r\n\r\n`;
    pedacos.push(codificar(cabecalho), typeof valor === 'string' ? codificar(valor) : valor, codificar('\r\n'));
  }
  pedacos.push(codificar(`--${fronteira}--\r\n`));
  const corpo = new Uint8Array(pedacos.reduce((soma, p) => soma + p.length, 0));
  let posicao = 0;
  for (const pedaco of pedacos) {
    corpo.set(pedaco, posicao);
    posicao += pedaco.length;
  }
  return { corpo, contentType: `multipart/form-data; boundary=${fronteira}` };
}

function chatIdValido(chatId) {
  return Number.isSafeInteger(chatId) && chatId > 0;
}

export function criarClienteTelegram({
  token,
  apiBase = API_PADRAO,
  fetch: fetchImpl = globalThis.fetch,
  prazoMs = PRAZO_MS,
  sleep = esperarPadrao,
  agora = Date.now,
} = {}) {
  if (!tokenValido(token)) {
    throw new ErroTelegram('configure o Telegram: token fora do formato <número>:<30 ou mais caracteres>', { tipo: 'entrada' });
  }
  const base = String(apiBase).replace(/\/+$/, '');
  let ultimoEnvio = null;

  const urlDoMetodo = metodo => `${base}/bot${token}/${metodo}`;
  const redigir = texto => redigirToken(texto, token);
  const erro = (mensagem, opcoes) => new ErroTelegram(redigir(mensagem), opcoes);

  async function respeitarIntervalo() {
    if (ultimoEnvio === null) return;
    const falta = ultimoEnvio + INTERVALO_ENVIO_MS - agora();
    if (falta > 0) await sleep(falta);
  }

  // Uma requisição crua: devolve { status, bytes } ou lança ErroTelegram de prazo/conexão.
  async function requisitar(url, metodo, opcoes) {
    try {
      const resposta = await fetchImpl(url, { ...opcoes, redirect: 'error', signal: AbortSignal.timeout(prazoMs) });
      const bytes = new Uint8Array(await resposta.arrayBuffer());
      return { status: resposta.status, bytes };
    } catch (causa) {
      if (causa?.name === 'TimeoutError' || causa?.name === 'AbortError') {
        throw erro(`Telegram ${metodo}: prazo de ${prazoMs} ms estourado em ${url}`, { tipo: 'prazo', metodo });
      }
      // A causa original não vai junto: a mensagem do fetch pode trazer a URL com o token.
      throw erro(`Telegram ${metodo}: falha de conexão em ${url} (${causa?.cause?.code ?? causa?.name ?? 'erro'})`, { tipo: 'conexao', metodo });
    }
  }

  function lerJson(bytes, url, metodo, status) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw erro(`Telegram ${metodo}: resposta não é JSON válido (HTTP ${status}) em ${url}`, { tipo: 'resposta', metodo, status });
    }
  }

  async function chamar(metodo, opcoes) {
    const url = urlDoMetodo(metodo);
    const envio = METODOS_DE_ENVIO.has(metodo);
    let esperas429 = 0;
    let esperas5xx = 0;
    for (;;) {
      if (envio) await respeitarIntervalo();
      const { status, bytes } = await requisitar(url, metodo, opcoes);
      if (envio) ultimoEnvio = agora();
      if (status === 401 || status === 403) {
        throw erro(`Telegram ${metodo}: token inválido ou bot bloqueado (HTTP ${status}) em ${url}`, { tipo: 'autorizacao', metodo, status });
      }
      if (status === 429) {
        if (esperas429 + 1 >= TENTATIVAS_429) {
          throw erro(`Telegram ${metodo}: limite de envio do Telegram (HTTP 429) depois de ${TENTATIVAS_429} tentativas em ${url}`, { tipo: 'limite', metodo, status });
        }
        let corpo = null;
        try { corpo = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* sem retry_after: espera 1 s */ }
        const segundos = Number(corpo?.parameters?.retry_after);
        const ms = Number.isFinite(segundos) && segundos > 0 ? Math.min(segundos * 1000, TETO_RETRY_AFTER_MS) : INTERVALO_ENVIO_MS;
        esperas429 += 1;
        await sleep(ms);
        continue;
      }
      if (status >= 500) {
        if (esperas5xx >= ESPERAS_5XX_MS.length) {
          throw erro(`Telegram ${metodo}: servidor do Telegram com erro (HTTP ${status}) depois de ${ESPERAS_5XX_MS.length + 1} tentativas em ${url}`, { tipo: 'servidor', metodo, status });
        }
        await sleep(ESPERAS_5XX_MS[esperas5xx]);
        esperas5xx += 1;
        continue;
      }
      const corpo = lerJson(bytes, url, metodo, status);
      if (status < 200 || status >= 300 || corpo?.ok !== true || !('result' in corpo)) {
        // Redige antes de cortar: cortado primeiro, um token ecoado na descrição sairia pela metade, sem casar a redação.
        const descricao = typeof corpo?.description === 'string' ? `: ${redigir(corpo.description).slice(0, 200)}` : '';
        throw erro(`Telegram ${metodo}: recusado (HTTP ${status})${descricao} em ${url}`, { tipo: 'resposta', metodo, status });
      }
      return corpo.result;
    }
  }

  const chamarJson = (metodo, parametros = {}) => chamar(metodo, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parametros),
  });

  function exigir(condicao, mensagem, metodo) {
    if (!condicao) throw erro(mensagem, { tipo: 'entrada', metodo });
  }

  function exigirMensagem(result, metodo) {
    if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.message_id)) {
      throw erro(`Telegram ${metodo}: resposta sem message_id`, { tipo: 'resposta', metodo });
    }
    return result;
  }

  return {
    async quemSouEu() {
      const result = await chamarJson('getMe');
      if (!result || !Number.isSafeInteger(result.id) || result.is_bot !== true) {
        throw erro('Telegram getMe: resposta sem id de bot', { tipo: 'resposta', metodo: 'getMe' });
      }
      return result;
    },

    async lerWebhook() {
      const result = await chamarJson('getWebhookInfo');
      if (!result || typeof result.url !== 'string') {
        throw erro('Telegram getWebhookInfo: resposta sem url', { tipo: 'resposta', metodo: 'getWebhookInfo' });
      }
      return result;
    },

    async enviarTexto(chatId, texto, { responderA } = {}) {
      exigir(chatIdValido(chatId), 'enviarTexto: chatId tem de ser inteiro positivo', 'sendMessage');
      exigir(typeof texto === 'string' && texto.length > 0, 'enviarTexto: texto vazio', 'sendMessage');
      exigir(responderA === undefined || Number.isSafeInteger(responderA), 'enviarTexto: responderA tem de ser inteiro', 'sendMessage');
      // A resposta citada não é obrigatória: se a mensagem da pessoa sumiu, o aviso sai solto.
      const citacao = responderA === undefined ? {} : { reply_parameters: { message_id: responderA, allow_sending_without_reply: true } };
      return exigirMensagem(await chamarJson('sendMessage', { chat_id: chatId, text: texto, ...citacao }), 'sendMessage');
    },

    async enviarDocumento(chatId, { nome, bytes, caption, tipo = 'application/octet-stream' } = {}) {
      exigir(chatIdValido(chatId), 'enviarDocumento: chatId tem de ser inteiro positivo', 'sendDocument');
      exigir(typeof nome === 'string' && /^[^\\/"\u0000-\u001f\u007f]+$/.test(nome), 'enviarDocumento: nome de arquivo inválido', 'sendDocument');
      exigir(bytes instanceof Uint8Array && bytes.length > 0, 'enviarDocumento: bytes vazios', 'sendDocument');
      exigir(caption === undefined || typeof caption === 'string', 'enviarDocumento: caption tem de ser texto', 'sendDocument');
      exigir(/^[\w./+-]+$/.test(tipo), 'enviarDocumento: tipo inválido', 'sendDocument');
      // Multipart montado à mão: o FormData do Node troca "\n" por "\r\n" nos campos de texto,
      // e o caption tem de chegar byte a byte igual ao textoDoLote (23.2, 23.5).
      const { corpo, contentType } = multipart([
        ['chat_id', String(chatId)],
        ...(caption === undefined ? [] : [['caption', caption]]),
        ['document', bytes, nome, tipo],
      ]);
      return exigirMensagem(await chamar('sendDocument', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: corpo,
      }), 'sendDocument');
    },

    async lerAtualizacoes({ offset, limit = 100, timeout = 0, allowedUpdates } = {}) {
      exigir(offset === undefined || Number.isSafeInteger(offset), 'lerAtualizacoes: offset tem de ser inteiro', 'getUpdates');
      exigir(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'lerAtualizacoes: limit entre 1 e 100', 'getUpdates');
      exigir(Number.isInteger(timeout) && timeout >= 0 && timeout * 1000 < prazoMs, 'lerAtualizacoes: timeout tem de caber no prazo', 'getUpdates');
      const parametros = { limit, timeout };
      if (offset !== undefined) parametros.offset = offset;
      if (allowedUpdates !== undefined) parametros.allowed_updates = allowedUpdates;
      const result = await chamarJson('getUpdates', parametros);
      if (!Array.isArray(result)) throw erro('Telegram getUpdates: resposta não é lista', { tipo: 'resposta', metodo: 'getUpdates' });
      return result;
    },

    async baixarArquivo(fileId) {
      exigir(typeof fileId === 'string' && fileId.length > 0, 'baixarArquivo: file_id vazio', 'getFile');
      const info = await chamarJson('getFile', { file_id: fileId });
      const filePath = info?.file_path;
      if (typeof filePath !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(filePath) || filePath.split('/').includes('..')) {
        throw erro('Telegram getFile: file_path ausente ou inválido', { tipo: 'resposta', metodo: 'getFile' });
      }
      if (Number.isFinite(info.file_size) && info.file_size > TETO_ARQUIVO_BYTES) {
        throw erro(`Telegram getFile: arquivo de ${info.file_size} bytes passa do teto`, { tipo: 'tamanho', metodo: 'getFile' });
      }
      const url = `${base}/file/bot${token}/${filePath}`;
      const { status, bytes } = await requisitar(url, 'download', { method: 'GET' });
      if (status === 401 || status === 403) {
        throw erro(`Telegram download: token inválido ou bot bloqueado (HTTP ${status}) em ${url}`, { tipo: 'autorizacao', metodo: 'download', status });
      }
      if (status !== 200) throw erro(`Telegram download: HTTP ${status} em ${url}`, { tipo: 'resposta', metodo: 'download', status });
      if (bytes.length > TETO_ARQUIVO_BYTES) throw erro(`Telegram download: arquivo passa do teto em ${url}`, { tipo: 'tamanho', metodo: 'download' });
      return { bytes, filePath, fileUniqueId: info.file_unique_id };
    },
  };
}
