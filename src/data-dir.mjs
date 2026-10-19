import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizarEmpresa, normalizarTexto } from './preparo/frases.mjs';

const repositoryDir = fileURLToPath(new URL('../', import.meta.url));
const companySources = ['greenhouse', 'lever', 'ashby', 'inhire'];

/** Resolve sem criar. RADAR_DATA_DIR deve ser absoluto e ficar fora do repositório. */
export function resolveDataDir(env = process.env) {
  const value = env.RADAR_DATA_DIR ?? join(homedir(), '.radar-de-vagas');
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('A variável RADAR_DATA_DIR precisa indicar uma pasta absoluta.');
  }
  return resolve(value);
}

// Resolve também os pais existentes para impedir escrita por um atalho simbólico.
async function physicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), relative(parent, path));
  }
}

/** Cria apenas a pasta; usado também pelo estado, sem alterar a busca. */
export async function ensureDataDir(dataDir = resolveDataDir()) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) {
    throw new Error('A pasta de dados precisa ter um caminho absoluto.');
  }
  const target = await physicalPath(resolve(dataDir));
  const root = await realpath(repositoryDir);
  const inside = relative(root, target);
  if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) {
    throw new Error('A pasta de dados precisa ficar fora do repositório.');
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

function exampleSearch() {
  return {
    aviso: 'EXEMPLO FICTÍCIO: substitua os termos e as empresas inventadas antes de coletar.',
    termos: ['planejamento', 'inteligência de mercado'],
    localidade: 'Brasil',
    modelo: 'remoto',
    idadeMaximaDias: 30,
    detalhesNovosPorFonte: 150,
    prazoFonteSegundos: 600,
    fontes: { gupy: true, linkedin: false },
    empresas: {
      greenhouse: ['aurora-ficticia'],
      lever: ['nebulosa-ficticia'],
      ashby: ['orbita-ficticia'],
      inhire: ['constelacao-ficticia'],
    },
  };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const optionalSources = ['solides', 'infojobs'];
const ufs = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

// Lista não vazia de objetos não vazios, cada par aceito por `accepts`.
const validFilters = (list, accepts) => Array.isArray(list) && list.length > 0 &&
  list.every(filter => isObject(filter) && Object.keys(filter).length > 0 &&
    Object.entries(filter).every(([key, value]) => accepts(key, value)));

// O filtro é lido depois da coleta (src/filter.mjs); todos os campos são opcionais.
function validateFilter(filter) {
  if (!isObject(filter)) return ['"filtro" precisa ser um objeto'];
  const problems = [];
  for (const key of Object.keys(filter)) {
    if (!['local', 'remoto', 'titulo'].includes(key)) problems.push(`campo desconhecido em "filtro": "${key}"`);
  }
  if ('local' in filter) {
    const local = filter.local;
    if (!isObject(local) || Object.keys(local).some(key => !['ufs', 'cidades'].includes(key))) {
      problems.push('"filtro.local" precisa ser um objeto só com "ufs" e "cidades"');
    } else {
      if ('ufs' in local && (!Array.isArray(local.ufs) || !local.ufs.every(uf => ufs.includes(uf)))) {
        problems.push('"filtro.local.ufs" precisa ser uma lista de siglas de UF em maiúsculas (uma das 27)');
      }
      if ('cidades' in local && (!Array.isArray(local.cidades) || !local.cidades.every(isText))) {
        problems.push('"filtro.local.cidades" precisa ser uma lista de textos não vazios');
      }
    }
  }
  if ('remoto' in filter && !['brasil', 'qualquer-pais', 'nao'].includes(filter.remoto)) {
    problems.push('"filtro.remoto" precisa ser "brasil", "qualquer-pais" ou "nao"');
  }
  if ('titulo' in filter) {
    const title = filter.titulo;
    if (!isObject(title) || Object.keys(title).some(key => !['ligado', 'sinonimos'].includes(key))) {
      problems.push('"filtro.titulo" precisa ser um objeto só com "ligado" e "sinonimos"');
    } else {
      if ('ligado' in title && typeof title.ligado !== 'boolean') problems.push('"filtro.titulo.ligado" precisa ser true ou false');
      if ('sinonimos' in title && (!Array.isArray(title.sinonimos) || !title.sinonimos.every(isText))) {
        problems.push('"filtro.titulo.sinonimos" precisa ser uma lista de textos não vazios');
      }
    }
  }
  return problems;
}

const PLACEHOLDERS = ['{variante}', '{pasta}', '{pdf}'];

// Comando externo declarado: nome no PATH ou caminho absoluto; placeholder só como argumento inteiro.
function validateCommand(command, key) {
  const label = `"preparo.${key}"`;
  if (!isObject(command) || Object.keys(command).some(field => !['comando', 'args'].includes(field)) ||
      !isText(command.comando) || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string')) {
    return [`${label} precisa ser { comando, args } com comando em texto e args uma lista de textos`];
  }
  const problems = [];
  if (/[\\/]/.test(command.comando) && !isAbsolute(command.comando)) problems.push(`${label}: comando relativo; use o nome do programa ou um caminho absoluto`);
  for (const arg of command.args) {
    if (/[{}]/.test(arg) && !PLACEHOLDERS.includes(arg)) {
      problems.push(`${label}: argumento "${arg}" com placeholder inválido; use ${PLACEHOLDERS.join(', ')} só como argumento inteiro`);
    }
  }
  return problems;
}

/** busca.json.preparo (Fase 2): chaves fechadas; lista com erro de digitação nunca vira lista vazia em silêncio. */
function validatePreparo(preparo) {
  if (!isObject(preparo)) return ['"preparo" precisa ser um objeto'];
  const commands = ['variantes', 'fatos', 'gerarCv', 'gateCv'];
  const lists = ['termosHierarquia', 'empresasExtras', 'certificacoesExtras', 'fontesCirculares'];
  const problems = [];
  for (const key of Object.keys(preparo)) {
    if (!commands.includes(key) && !lists.includes(key)) problems.push(`campo desconhecido em preparo: "${key}"`);
  }
  for (const key of commands) if (key in preparo) problems.push(...validateCommand(preparo[key], key));
  for (const key of lists) {
    if (!(key in preparo)) continue;
    const list = preparo[key];
    if (!Array.isArray(list) || !list.every(isText)) {
      problems.push(`"preparo.${key}" precisa ser uma lista de textos não vazios`);
    } else if (key === 'termosHierarquia' && list.some(term => !/^[a-z0-9 ]+$/.test(normalizarTexto(term)))) {
      problems.push('"preparo.termosHierarquia": cada termo, normalizado, só pode ter letras sem acento, números e espaços');
    } else if (key === 'empresasExtras' && list.some(name => !normalizarEmpresa(name))) {
      problems.push('"preparo.empresasExtras": nome que vira vazio sem os sufixos societários (como "Ltda.")');
    } else if (key === 'fontesCirculares') {
      for (const pattern of list) {
        try { new RegExp(pattern, 'u'); }
        catch { problems.push(`"preparo.fontesCirculares": regex inválida "${pattern}"`); }
      }
    }
  }
  return problems;
}

/** Lista de problemas em português; não modifica a busca. */
export function validateSearch(search) {
  if (!isObject(search)) return ['a busca precisa ser um objeto'];
  const problems = [];
  const allowed = ['aviso', 'termos', 'localidade', 'modelo', 'idadeMaximaDias', 'fontes', 'empresas', 'detalhesNovosPorFonte', 'prazoFonteSegundos', 'tetoTriagemPorRodada', 'agente', 'gupyFiltros', 'pausaLinkedinSegundos', 'solidesFiltros', 'infojobsFiltros', 'filtro', 'preparo'];
  for (const key of Object.keys(search)) {
    if (!allowed.includes(key)) problems.push(`campo desconhecido na busca: "${key}"`);
  }
  if ('aviso' in search && !isText(search.aviso)) problems.push('"aviso" precisa ser texto não vazio');
  if (!Array.isArray(search.termos) || search.termos.length === 0 || !search.termos.every(isText)) {
    problems.push('"termos" precisa ser uma lista não vazia de textos não vazios');
  }
  if (search.localidade !== null && !isText(search.localidade)) {
    problems.push('"localidade" precisa ser texto não vazio ou null');
  }
  if (![null, 'remoto', 'híbrido', 'presencial'].includes(search.modelo)) {
    problems.push('"modelo" precisa ser "remoto", "híbrido", "presencial" ou null');
  }
  if (search.idadeMaximaDias !== null && (!Number.isSafeInteger(search.idadeMaximaDias) || search.idadeMaximaDias < 1)) {
    problems.push('"idadeMaximaDias" precisa ser um inteiro positivo ou null');
  }
  if ('agente' in search && !['claude', 'codex'].includes(search.agente)) {
    problems.push('"agente" precisa ser "claude" ou "codex", ou ficar ausente');
  }
  if ('gupyFiltros' in search && (!Array.isArray(search.gupyFiltros) || search.gupyFiltros.length === 0 ||
      !search.gupyFiltros.every(filter => isObject(filter) && Object.keys(filter).length > 0 &&
        Object.entries(filter).every(([key, value]) => ['state', 'city', 'workplaceType'].includes(key) && isText(value))))) {
    problems.push('"gupyFiltros" precisa ser uma lista não vazia de objetos com state, city ou workplaceType em texto');
  }
  for (const key of ['detalhesNovosPorFonte', 'prazoFonteSegundos', 'tetoTriagemPorRodada', 'pausaLinkedinSegundos']) {
    if (key in search && (!Number.isSafeInteger(search[key]) || search[key] < 1 ||
        (key === 'prazoFonteSegundos' && search[key] > 2147483))) {
      problems.push(`"${key}" precisa ser um inteiro positivo${key === 'prazoFonteSegundos' ? ' até 2147483' : ''}`);
    }
  }
  if ('solidesFiltros' in search && !validFilters(search.solidesFiltros, (key, value) =>
      ['locations', 'jobsType', 'seniorities', 'contractsType'].includes(key) && isText(value))) {
    problems.push('"solidesFiltros" precisa ser uma lista não vazia de objetos com locations, jobsType, seniorities ou contractsType em texto');
  }
  if ('infojobsFiltros' in search && !validFilters(search.infojobsFiltros, (key, value) =>
      (key === 'local' && typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) ||
      (key === 'homeOffice' && typeof value === 'boolean'))) {
    problems.push('"infojobsFiltros" precisa ser uma lista não vazia de objetos com "local" (minúsculas, números e hífen, sem espaço) e "homeOffice" true ou false');
  }
  if ('filtro' in search) problems.push(...validateFilter(search.filtro));
  if ('preparo' in search) problems.push(...validatePreparo(search.preparo));
  if (!isObject(search.fontes) || Object.keys(search.fontes).some(key => !optionalSources.includes(key) && !['gupy', 'linkedin'].includes(key)) ||
      typeof search.fontes.gupy !== 'boolean' || typeof search.fontes.linkedin !== 'boolean' ||
      optionalSources.some(key => key in search.fontes && typeof search.fontes[key] !== 'boolean')) {
    problems.push('"fontes" precisa conter "gupy" e "linkedin" com valores true ou false; "solides" e "infojobs" são opcionais, também true ou false');
  }
  if (!isObject(search.empresas) || Object.keys(search.empresas).some(key => !companySources.includes(key)) ||
      companySources.some(key => !Array.isArray(search.empresas[key]) || !search.empresas[key].every(isText))) {
    problems.push('"empresas" precisa conter listas de identificadores não vazios para greenhouse, lever, ashby e inhire (listas vazias são permitidas)');
  }
  return problems;
}

/** Cria busca.json uma única vez. Um arquivo existente, mesmo inválido, é preservado. */
export async function initializeDataDir({ dataDir = resolveDataDir() } = {}) {
  const directory = await ensureDataDir(dataDir);
  const destination = join(directory, 'busca.json');
  try {
    await lstat(destination);
    return directory;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Não foi possível acessar busca.json.', { cause: error });
  }
  const temporary = join(directory, `.busca-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(exampleSearch(), null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // Publica completo e sem substituir um arquivo criado por outra execução.
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch (error) {
    throw new Error('Não foi possível criar o arquivo busca.json.', { cause: error });
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return directory;
}

/** Inicializa quando necessário e devolve os campos em português de busca.json. */
export async function loadSearch(options = {}) {
  const directory = await initializeDataDir(options);
  let search;
  try {
    search = JSON.parse(await readFile(join(directory, 'busca.json'), 'utf8'));
  } catch (error) {
    throw new Error('Não foi possível ler busca.json: confira se o arquivo contém JSON válido. O arquivo foi preservado.', { cause: error });
  }
  const problems = validateSearch(search);
  if (problems.length) throw new Error(`Busca inválida em busca.json: ${problems.join('; ')}. O arquivo foi preservado.`);
  return search;
}
