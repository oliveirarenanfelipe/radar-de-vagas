import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureDataDir, resolveDataDir } from './data-dir.mjs';

// ponytail: guarda só as 50 rodadas mais recentes; a página do dia lê apenas a última.
export const MAX_ROUNDS = 50;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function validRound(round) {
  return exactKeys(round, ['inicio', 'fim', 'interrompida', 'porFonte', 'totalNovas']) &&
    isTimestamp(round.inicio) && isTimestamp(round.fim) && round.inicio <= round.fim &&
    typeof round.interrompida === 'boolean' && isCount(round.totalNovas) && isObject(round.porFonte) &&
    Object.entries(round.porFonte).every(([name, counts]) => /^[a-z0-9_-]+$/.test(name) &&
      exactKeys(counts, ['vistas', 'novas', 'erros']) && Object.values(counts).every(isCount));
}

async function readRounds(directory) {
  let content;
  try {
    content = await readFile(join(directory, 'rodadas.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Não foi possível ler rodadas.json. O arquivo foi preservado.', { cause: error });
  }
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (!exactKeys(data, ['schemaVersion', 'rodadas']) || data.schemaVersion !== 1 ||
        !Array.isArray(data.rodadas) || !data.rodadas.every(validRound)) throw new Error('formato inesperado');
    return data.rodadas;
  } catch (error) {
    throw new Error('Registro de rodadas inválido ou corrompido em rodadas.json. O arquivo foi preservado; corrija ou remova o arquivo para registrar novas rodadas.', { cause: error });
  }
}

/** Lista das rodadas gravadas, da mais antiga para a mais recente; arquivo ausente equivale a lista vazia. */
export async function loadRounds({ dataDir = resolveDataDir() } = {}) {
  return readRounds(await ensureDataDir(dataDir));
}

/** Acrescenta uma rodada. Só a coleta grava, e sob coleta.lock; a escrita é temporário + rename. */
export async function recordRound(round, { dataDir = resolveDataDir() } = {}) {
  if (!validRound(round)) throw new Error('Rodada inválida: não foi gravada em rodadas.json.');
  const directory = await ensureDataDir(dataDir);
  const rounds = [...await readRounds(directory), structuredClone(round)].slice(-MAX_ROUNDS);
  const temporary = join(directory, `.rodadas-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, rodadas: rounds }, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, join(directory, 'rodadas.json'));
  } catch (error) {
    throw new Error('Não foi possível gravar rodadas.json de forma atômica.', { cause: error });
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return rounds;
}
