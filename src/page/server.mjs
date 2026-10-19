import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDataDir, resolveDataDir, validateSearch } from '../data-dir.mjs';
import { aplicarFiltro } from '../filter.mjs';
import { lerJsonOuNada, pastaSegura } from '../preparo/pacote.mjs';
import { loadRounds } from '../rounds.mjs';
import { loadState, setMark, setRetorno, setTracking } from '../state.mjs';
import { indicadores, renderPage, toDay, toJobs } from './view.mjs';

const bodyLimit = 16 * 1024;
const assets = new Map([
  ['/page.css', ['text/css; charset=utf-8', new URL('./page.css', import.meta.url)]],
  ['/page.mjs', ['text/javascript; charset=utf-8', new URL('./page.mjs', import.meta.url)]],
  ['/view.mjs', ['text/javascript; charset=utf-8', new URL('./view.mjs', import.meta.url)]],
]);

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(response, status, content, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(content) : content);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      if (error) { request.resume(); reject(error); }
      else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > bodyLimit) finish(failure(413, 'O corpo excede o limite de 16 KiB.'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        finish(failure(400, 'Envie um corpo JSON válido.'));
      }
    };
    const onAborted = () => finish(failure(400, 'A requisição foi interrompida.'));
    const onError = () => finish(failure(400, 'Não foi possível ler a requisição.'));
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
  });
}

function validateMark(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['status', 'cutReason'].includes(key)) ||
      !['applied', 'discarded'].includes(value.status)) {
    throw failure(400, 'Envie uma marcação válida ou null para desfazer.');
  }
  if (value.status === 'discarded' &&
      (typeof value.cutReason !== 'string' || !value.cutReason.trim())) {
    throw failure(400, 'Escreva o motivo para descartar a vaga.');
  }
  if (value.status === 'applied' && value.cutReason != null) {
    throw failure(400, 'A marcação inscrevi não recebe motivo de descarte.');
  }
  return { status: value.status, cutReason: value.status === 'discarded' ? value.cutReason.trim() : null };
}

// Filtro lido a cada requisição, sem criar busca.json (a página não grava nada): ausente ou sem `filtro` = mostra tudo.
async function readJudge(directory) {
  let search;
  try { search = JSON.parse(await readFile(join(directory, 'busca.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Não foi possível ler busca.json para aplicar o filtro. O arquivo foi preservado.');
  }
  const problems = validateSearch(search);
  if (problems.length) throw new Error(`Busca inválida em busca.json, o filtro não foi aplicado: ${problems.join('; ')}.`);
  if (!search.filtro) return undefined;
  return job => aplicarFiltro(job, search.filtro, search.termos);
}

// Variante de cada candidatura inscrita, lida do pacote.json dela (sem pacote, fica de fora e vira "sem pacote").
async function loadIndicadores(state, options) {
  const variantes = {};
  for (const [id, entry] of Object.entries(state.jobs)) {
    if (entry.mark?.status !== 'applied') continue;
    const pacote = await lerJsonOuNada(join(pastaSegura(options.dataDir, id), 'pacote.json')).catch(() => undefined);
    if (typeof pacote?.variante === 'string') variantes[id] = pacote.variante;
  }
  return indicadores(toJobs(state), variantes);
}

function validateRetorno(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'retorno') ||
      !(value.retorno === null || typeof value.retorno === 'string')) {
    throw failure(400, 'Envie { retorno } com um valor da lista ou null para desfazer.');
  }
  return value.retorno;
}

async function loadDay(state, options) {
  const [rounds, judge] = await Promise.all([loadRounds(options), readJudge(options.dataDir)]);
  return toDay(state, rounds, judge);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function validateTracking(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['stage', 'next', 'notes'].includes(key)) ||
      typeof value.stage !== 'string' || !value.stage.trim() ||
      (value.next !== undefined && value.next !== null && typeof value.next !== 'string') ||
      (value.notes !== undefined && typeof value.notes !== 'string')) {
    throw failure(400, 'Informe uma etapa e textos válidos para o acompanhamento.');
  }
  return { stage: value.stage.trim(), next: value.next ?? null, notes: value.notes ?? '' };
}

/** Inicia em loopback; porta ocupada usa uma porta livre. close() é assíncrono. */
export async function startServer({ dataDir = resolveDataDir(), port = 4317 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('A porta precisa ser um inteiro entre 0 e 65535.');
  }
  const directory = await ensureDataDir(dataDir);
  const options = { dataDir: directory };
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    try {
      const authority = `127.0.0.1:${server.address().port}`;
      const origin = `http://${authority}`;
      // Host também é conferido nas leituras para recusar DNS rebinding.
      if (request.headers.host !== authority) throw failure(403, 'Host não autorizado.');
      if (request.method === 'POST' && (request.headers.origin !== origin ||
          (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))) {
        throw failure(403, 'Origem não autorizada. Use a página local do radar.');
      }
      const path = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const [type, file] = assets.get(path);
        send(response, 200, await readFile(file), type);
        return;
      }
      if (request.method === 'GET' && (path === '/' || path === '/api/jobs')) {
        const state = await loadState(options);
        const jobs = toJobs(state);
        // rodadas.json corrompido não derruba a página: a vista do dia mostra o erro e a tabela continua.
        // O mesmo GET leva a vista do dia, para o botão Atualizar não precisar de uma segunda requisição.
        const day = await loadDay(state, options).catch(error => ({ erro: error.message }));
        const dados = await loadIndicadores(state, options);
        if (path === '/') send(response, 200, renderPage(jobs, state.sources, day, dados), 'text/html; charset=utf-8');
        else send(response, 200, { jobs, sources: state.sources, dia: day, indicadores: dados });
        return;
      }
      if (request.method === 'GET' && path === '/api/indicadores') {
        send(response, 200, await loadIndicadores(await loadState(options), options));
        return;
      }
      if (request.method === 'GET' && path === '/api/dia') {
        const state = await loadState(options);
        let day;
        try { day = await loadDay(state, options); }
        catch (error) { throw failure(500, error.message); }
        send(response, 200, day);
        return;
      }
      const match = /^\/api\/jobs\/([^/]+)\/(mark|tracking|retorno)$/.exec(path);
      if (request.method === 'POST' && match) {
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw failure(415, 'Envie os dados como application/json.');
        }
        if (Number(request.headers['content-length']) > bodyLimit) {
          request.resume();
          throw failure(413, 'O corpo excede o limite de 16 KiB.');
        }
        let id;
        try { id = decodeURIComponent(match[1]); }
        catch { throw failure(400, 'Identificador malformado.'); }
        const block = match[2];
        const value = ({ mark: validateMark, tracking: validateTracking, retorno: validateRetorno })[block](await readBody(request));
        const state = await loadState(options);
        const canonical = Object.hasOwn(state.jobs, id) ? id
          : Object.hasOwn(state.aliases, id) ? state.aliases[id] : null;
        if (canonical === null) throw failure(404, 'Vaga não encontrada.');
        // id é somente chave de estado, nunca compõe um caminho no disco.
        if (block === 'retorno') {
          const updated = await setRetorno(id, value, options);
          send(response, 200, { id: canonical, tracking: updated.jobs[canonical].tracking });
          return;
        }
        const updated = await (block === 'mark' ? setMark : setTracking)(id, value, options);
        send(response, 200, { id: canonical, [block]: updated.jobs[canonical][block] });
        return;
      }
      throw failure(404, 'Página ou rota não encontrada.');
    } catch (error) {
      if (!response.destroyed) send(response, error.status ?? 500, {
        error: error.status ? error.message : 'Não foi possível acessar o estado. Confira estado.json e tente novamente.',
      });
    }
  });
  try { await listen(server, port); }
  catch (error) {
    if (error.code !== 'EADDRINUSE' || port === 0) throw error;
    await listen(server, 0);
  }
  let closing;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      closing ??= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return closing;
    },
  };
}
