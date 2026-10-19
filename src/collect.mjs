import { setTimeout as delay } from 'node:timers/promises';
import { ensureDataDir, loadSearch, resolveDataDir } from './data-dir.mjs';
import { makeId, validateJob } from './job.mjs';
import { createFetch } from './network.mjs';
import { recordRound } from './rounds.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { sources as registeredSources, validateSource } from './sources/index.mjs';
import { addJobs, loadState } from './state.mjs';

/** Código de saída de uma coleta barrada por outra em andamento (EX_TEMPFAIL); distinto do 1 de "nenhuma fonte rodou". */
export const COLLECT_LOCKED = 75;

function knownIds(state, source) {
  const prefix = `${source}:`;
  // A chave estável pode pertencer à fonte cujo anúncio foi substituído na fusão.
  const ids = [...Object.keys(state.jobs), ...Object.keys(state.aliases),
    ...Object.values(state.jobs).flatMap(entry => [
      makeId(entry.job.source, entry.job.sourceId), ...entry.seen.alsoAt.map(item => item.id),
    ])];
  return new Set(ids.filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)));
}

function validateResult(result, source) {
  if (!result || !Array.isArray(result.jobs) || !Array.isArray(result.errors)) {
    throw new Error('Retorno inválido: a fonte precisa devolver listas de vagas e erros.');
  }
  for (const job of result.jobs) {
    const problems = validateJob(job);
    if (problems.length || job.source !== source) {
      throw new Error(`Vaga inválida no retorno da fonte: ${problems.join('; ') || 'fonte divergente'}.`);
    }
  }
  if (result.observed !== undefined && (!Array.isArray(result.observed) ||
      !result.observed.every(id => typeof id === 'string' && id.trim()))) {
    throw new Error('Identificadores reencontrados inválidos no retorno da fonte.');
  }
  for (const error of result.errors) {
    if (!error || Object.keys(error).length !== 3 ||
        !['target', 'step', 'message'].every(key => typeof error[key] === 'string' && error[key].trim())) {
      throw new Error('Erro inválido no retorno da fonte: informe alvo, etapa e mensagem.');
    }
  }
}

/**
 * Executa as fontes habilitadas e persiste cada rodada pelo dono da coleta.
 * sources, fetch, sleep e log são injetáveis; dataDir deve ficar fora do repositório.
 * Retorna { sources: [{ source, label, seen, new, errors }], totalNew, warnings }.
 * seen conta vagas devolvidas e IDs reencontrados; new conta inserções sob trava, sem aliases.
 * Fontes por empresa sem empresas configuradas não são executadas.
 */
export async function collect({
  dataDir = resolveDataDir(), sources = registeredSources,
  fetch: fetchImpl = globalThis.fetch, sleep = delay, log = () => {}, timeoutMs, sourceTimeoutMs, signal,
} = {}) {
  if (!Array.isArray(sources)) throw new Error('O registro de fontes precisa ser uma lista.');
  const names = new Set();
  for (const source of sources) {
    const problems = validateSource(source);
    if (problems.length) throw new Error(`Fonte inválida: ${problems.join('; ')}.`);
    if (names.has(source.name)) throw new Error('O registro contém fontes repetidas.');
    names.add(source.name);
  }

  // A trava vem antes de ler busca e estado: uma coleta barrada não lê nem grava nada.
  const release = acquireRunLock(await ensureDataDir(dataDir), 'coleta.lock');
  if (!release) {
    const error = new Error('outra coleta em andamento (coleta.lock); esta não coletou nada.');
    error.exitCode = COLLECT_LOCKED;
    throw error;
  }
  try {
    return await collectRound({ dataDir, sources, fetchImpl, sleep, log, timeoutMs, sourceTimeoutMs, signal });
  } finally { release(); }
}

async function collectRound({ dataDir, sources, fetchImpl, sleep, log, timeoutMs, sourceTimeoutMs, signal }) {
  // inicio e fim cercam todas as gravações: firstSeenAt das vagas novas cai dentro da janela da rodada.
  const inicio = new Date().toISOString();
  // loadSearch garante a pasta e cria a busca fictícia apenas se ela não existir.
  const search = await loadSearch({ dataDir });
  let state = await loadState({ dataDir });
  const fetch = createFetch({ fetch: fetchImpl, timeoutMs });
  const summary = { sources: [], totalNew: 0, warnings: search.aviso ? [search.aviso] : [] };

  for (const source of sources) {
    if (signal?.aborted) break;
    const enabled = Object.hasOwn(search.fontes, source.name)
      ? search.fontes[source.name] : source.defaultEnabled;
    const companies = Object.hasOwn(search.empresas, source.name) ? search.empresas[source.name] : [];
    if (!enabled || (source.kind === 'company' && companies.length === 0)) continue;

    log(`${source.label}: fonte iniciada.`);
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Coleta interrompida pela pessoa.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error('Prazo total da fonte excedido; seguindo para a próxima fonte.')),
      sourceTimeoutMs ?? (search.prazoFonteSegundos ?? 600) * 1000);
    let result, rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try {
      result = await Promise.race([aborted, Promise.resolve().then(() => source.collect({
        search: structuredClone(search), companies: [...companies],
        known: knownIds(state, source.name),
        fetch: (url, options) => fetch(url, { ...options, signal: controller.signal }),
        sleep, log, signal: controller.signal,
      }))]);
      validateResult(result, source.name);
    } catch (error) {
      result = { jobs: [], errors: [{ target: source.name, step: 'coleta',
        message: typeof error?.message === 'string' && error.message.trim()
          ? error.message : 'Falha inesperada ao executar a fonte.',
      }] };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', rejectAbort);
    }

    // Erros de persistência são fatais: não anunciar sucesso sem gravar os dados.
    const persisted = await addJobs(result.jobs, {
      dataDir, sources, returnStats: true,
      observed: (result.observed ?? []).map(id => makeId(source.name, id)), runs: [{ source: source.name, errors: result.errors }],
    });
    state = persisted.state;
    const added = persisted.inserted;
    const seen = result.jobs.length + new Set((result.observed ?? [])
      .filter(id => !result.jobs.some(job => job.sourceId === id))).size;
    log(`${source.label}: fonte concluída, ${seen} vagas vistas, ${added} novas; estado salvo.`);
    summary.sources.push({ source: source.name, label: source.label,
      seen, new: added, errors: structuredClone(result.errors) });
    summary.totalNew += added;
  }
  if (signal?.aborted) summary.warnings.push('Coleta interrompida; fontes concluídas foram preservadas.');
  // O estado já está salvo; um rodadas.json corrompido faz a coleta falhar aqui, sem perder as vagas.
  await recordRound({
    inicio, fim: new Date().toISOString(), interrompida: Boolean(signal?.aborted),
    porFonte: Object.fromEntries(summary.sources.map(item =>
      // Empresa sem vagas ("vazia") é aviso, não erro da fonte.
      [item.source, { vistas: item.seen, novas: item.new, erros: item.errors.filter(error => error.step !== 'vazia').length }])),
    totalNovas: summary.totalNew,
  }, { dataDir });
  return summary;
}
