// Contrato do preparo (docs/spec.md §3, T11): esquema do CV declarado e dos fatos, e carga dos arquivos da
// camada privada na pasta de dados. Só lê: nenhum caminho daqui grava frases, bases ou complementos.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chaveFrase, normalizarPeriodo, normalizarTexto, partirFrases, pontoDeControle } from './frases.mjs';

export const SECOES = ['titulo', 'perfil', 'habilidades', 'integral', 'gupy'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const exactKeys = (value, required, optional = []) => isObject(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

function periodo(value, label, problems) {
  try { normalizarPeriodo(value); }
  catch (error) { problems.push(`${label}: ${error.message}`); }
}

// Partes comuns de declarado e fatos: experiências, formação, cursos, idiomas e textoLivre.
function validarCorpo(doc, problems, { experienciaExtra = [], secoes = null }) {
  if (!Array.isArray(doc.experiencias)) problems.push('"experiencias" precisa ser uma lista');
  else doc.experiencias.forEach((item, i) => {
    const label = `experiencias[${i}]`;
    if (!exactKeys(item, ['cargo', 'empresa', 'periodo', 'local'], experienciaExtra)) {
      problems.push(`${label} precisa ter só cargo, empresa, periodo e local${experienciaExtra.length ? ' (e aliases)' : ''}`);
      return;
    }
    if (!isText(item.cargo)) problems.push(`${label}: cargo vazio`);
    if (!isText(item.empresa)) problems.push(`${label}: empresa vazia`);
    if (typeof item.local !== 'string') problems.push(`${label}: local precisa ser texto`);
    periodo(item.periodo, label, problems);
    if ('aliases' in item && (!Array.isArray(item.aliases) || !item.aliases.every(isText))) {
      problems.push(`${label}: "aliases" precisa ser uma lista de textos não vazios`);
    }
  });
  if (!Array.isArray(doc.formacao)) problems.push('"formacao" precisa ser uma lista');
  else doc.formacao.forEach((item, i) => {
    if (!exactKeys(item, ['titulo', 'instituicao', 'periodo']) || !isText(item.titulo) || !isText(item.instituicao)) {
      problems.push(`formacao[${i}] precisa ter só titulo, instituicao e periodo, com texto`);
    } else periodo(item.periodo, `formacao[${i}]`, problems);
  });
  if (!Array.isArray(doc.cursos) || !doc.cursos.every(isText)) problems.push('"cursos" precisa ser uma lista de textos não vazios');
  if (!Array.isArray(doc.idiomas) || !doc.idiomas.every(item => exactKeys(item, ['idioma', 'nivel']) && isText(item.idioma) && isText(item.nivel))) {
    problems.push('"idiomas" precisa ser uma lista de { idioma, nivel } com texto');
  }
  if (!Array.isArray(doc.textoLivre)) problems.push('"textoLivre" precisa ser uma lista');
  else doc.textoLivre.forEach((item, i) => {
    if (!exactKeys(item, ['secao', 'texto']) || typeof item.texto !== 'string' || !isText(item.secao) ||
        (secoes && !secoes.includes(item.secao))) {
      problems.push(`textoLivre[${i}] precisa ter só secao e texto${secoes ? `, com secao entre ${secoes.join(', ')}` : ''}`);
    }
  });
}

/** Problemas em português do CV declarado (o que o gerador diz que pôs no CV); lista vazia = válido. */
export function validarDeclarado(doc) {
  if (!isObject(doc)) return ['o CV declarado precisa ser um objeto'];
  const problems = [];
  const campos = ['versao', 'experiencias', 'formacao', 'cursos', 'idiomas', 'textoLivre'];
  for (const key of Object.keys(doc)) if (!campos.includes(key)) problems.push(`campo desconhecido no CV declarado: "${key}"`);
  for (const key of campos) if (!(key in doc)) problems.push(`campo ausente no CV declarado: "${key}"`);
  if (doc.versao !== 1) problems.push('"versao" do CV declarado precisa ser 1');
  validarCorpo(doc, problems, { secoes: SECOES });
  // Sem título e perfil não há texto a checar: nunca aprova por omissão.
  const textos = Array.isArray(doc.textoLivre) ? doc.textoLivre.filter(isObject) : [];
  for (const secao of ['titulo', 'perfil']) {
    const itens = textos.filter(item => item.secao === secao);
    if (!itens.length || itens.some(item => !isText(item.texto))) problems.push(`declarado sem título/perfil: seção "${secao}" ausente ou vazia`);
  }
  return problems;
}

/** Problemas em português dos fatos da base de uma variante; lista vazia = válido. */
export function validarFatos(doc) {
  if (!isObject(doc)) return ['os fatos precisam ser um objeto'];
  const problems = [];
  const campos = ['versao', 'base', 'experiencias', 'formacao', 'cursos', 'idiomas', 'textoLivre'];
  for (const key of Object.keys(doc)) if (!campos.includes(key)) problems.push(`campo desconhecido nos fatos: "${key}"`);
  for (const key of campos) if (!(key in doc)) problems.push(`campo ausente nos fatos: "${key}"`);
  if (doc.versao !== 1) problems.push('"versao" dos fatos precisa ser 1');
  if (typeof doc.base !== 'string' || !/^[A-Za-z0-9_-]+$/.test(doc.base)) problems.push('"base" dos fatos precisa casar ^[A-Za-z0-9_-]+$');
  validarCorpo(doc, problems, { experienciaExtra: ['aliases'] });
  return problems;
}

/** JSON com as chaves de todo objeto ordenadas: a forma usada no hash do retrato e na ordem dos complementos. */
export function jsonCanonico(value) {
  if (Array.isArray(value)) return `[${value.map(jsonCanonico).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jsonCanonico(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** sha256 do retrato em JSON com chaves ordenadas. */
export function hashRetrato(retrato) {
  return createHash('sha256').update(jsonCanonico(retrato)).digest('hex');
}

/** Chave de uma entrada aprovada: as chaves das frases do texto, partido como na veracidade. */
export function chaveDeEntrada(texto) {
  return partirFrases(texto).map(chaveFrase);
}

async function lerJson(dataDir, nome) {
  let bruto;
  try { bruto = await readFile(join(dataDir, nome), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Não foi possível ler ${nome}. O arquivo foi preservado.`, { cause: error });
  }
  try { return JSON.parse(bruto); }
  catch (error) { throw new Error(`${nome} não contém JSON válido. O arquivo foi preservado.`, { cause: error }); }
}

const falha = (nome, mensagem) => new Error(`Erro de carga em ${nome}: ${mensagem}`);

function dataValida(texto) {
  return typeof texto === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(texto) &&
    Number.isFinite(Date.parse(texto)) && new Date(texto).toISOString().slice(0, 10) === texto;
}

function hojeLocal() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

// Texto que vai à tela de aprovação não pode ter Cc nem Cf (spec: "Texto sem caractere de controle").
function semControle(nome, onde, campo, texto) {
  const ponto = pontoDeControle(texto);
  if (ponto) throw falha(nome, `${onde}, campo ${campo}: caractere de controle ${ponto}.`);
}

/** afirmacoes-proibidas.json: [{ id, padrao, descricao }] com o padrão compilado; ausente = lista vazia. */
export async function carregarProibidas({ dataDir }) {
  const nome = 'afirmacoes-proibidas.json';
  const lista = await lerJson(dataDir, nome);
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) throw falha(nome, 'o arquivo precisa ser uma lista de { id, padrao, descricao }.');
  return lista.map((item, i) => {
    if (!exactKeys(item, ['id', 'padrao', 'descricao']) || !isText(item.id) || !isText(item.padrao) || typeof item.descricao !== 'string') {
      throw falha(nome, `item ${i} precisa ter só id, padrao e descricao, com texto.`);
    }
    try { return { ...item, regex: new RegExp(item.padrao, 'u') }; }
    catch (error) { throw falha(nome, `item ${i} ("${item.id}"): regex inválida (${error.message}).`); }
  });
}

// Fonte circular: o próprio CV ou registro de estado dele. "cv" e "resume" delimitados por fora de [a-z0-9] ("_" separa).
export const FONTES_CIRCULARES_NUCLEO = ['curriculo', 'curriculum', '(?:^|[^a-z0-9])(?:cv|resume)(?:[^a-z0-9]|$)'];
const CAMPOS_COMPLEMENTO = { curso: ['texto'], idioma: ['idioma', 'nivel'], formacao: ['titulo', 'instituicao', 'periodo'] };
const FONTES = ['comprovante', 'registro-de-plataforma', 'fala-datada'];

/** fatos-complementares.json: fatos estruturados com fonte primária; ausente = lista vazia. Item inválido é erro, nunca ignorado. */
export async function carregarComplementos({ dataDir, preparo = {} }) {
  const nome = 'fatos-complementares.json';
  const lista = await lerJson(dataDir, nome);
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) throw falha(nome, 'o arquivo precisa ser uma lista de itens com tipo e fonte.');
  const padroes = [...FONTES_CIRCULARES_NUCLEO, ...(preparo.fontesCirculares ?? [])].map(padrao => ({ padrao, regex: new RegExp(padrao, 'u') }));
  lista.forEach((item, i) => {
    const campos = CAMPOS_COMPLEMENTO[item?.tipo];
    if (!campos) throw falha(nome, `item ${i}: tipo precisa ser curso, idioma ou formacao.`);
    if (!exactKeys(item, ['tipo', 'fonte', ...campos]) || !campos.every(campo => isText(item[campo]))) {
      throw falha(nome, `item ${i}: o tipo ${item.tipo} precisa de ${campos.join(', ')} em texto, e fonte.`);
    }
    if (item.tipo === 'formacao') {
      try { normalizarPeriodo(item.periodo); } catch (error) { throw falha(nome, `item ${i}: ${error.message}`); }
    }
    const fonte = item.fonte;
    if (!exactKeys(fonte, ['tipo', 'referencia', 'data']) || !FONTES.includes(fonte.tipo) || !isText(fonte.referencia) || !dataValida(fonte.data)) {
      throw falha(nome, `item ${i}: fonte precisa ter só tipo (${FONTES.join(', ')}), referencia e data AAAA-MM-DD.`);
    }
    const referencia = normalizarTexto(fonte.referencia);
    const circular = padroes.find(({ regex }) => regex.test(referencia));
    if (circular) throw falha(nome, `item ${i}: fonte circular (a referência casa "${circular.padrao}"); o próprio CV ou registro dele não vale como fonte.`);
  });
  return lista;
}

/** frases-aprovadas.json: entradas com a chave calculada; ausente = nada aprovado. */
export async function carregarFrasesAprovadas({ dataDir, hoje = hojeLocal() }) {
  const nome = 'frases-aprovadas.json';
  const doc = await lerJson(dataDir, nome);
  if (doc === undefined) return [];
  if (!exactKeys(doc, ['versao', 'frases']) || doc.versao !== 1 || !Array.isArray(doc.frases)) {
    throw falha(nome, 'o arquivo precisa ser { versao: 1, frases: [...] }.');
  }
  const vistas = new Map();
  return doc.frases.map((item, i) => {
    if (!exactKeys(item, ['texto', 'aprovadaEm', 'origem'])) throw falha(nome, `item ${i} precisa ter só texto, aprovadaEm e origem.`);
    if (typeof item.texto !== 'string' || typeof item.origem !== 'string') throw falha(nome, `item ${i}: texto e origem precisam ser texto.`);
    semControle(nome, `item ${i}`, 'texto', item.texto);
    semControle(nome, `item ${i}`, 'origem', item.origem);
    const chave = chaveDeEntrada(item.texto);
    if (!chave.length || !chave.every(Boolean)) throw falha(nome, `item ${i}: texto vazio ou só com pontuação.`);
    if (!dataValida(item.aprovadaEm)) throw falha(nome, `item ${i}: aprovadaEm precisa ser uma data AAAA-MM-DD que existe.`);
    if (item.aprovadaEm > hoje) throw falha(nome, `item ${i}: aprovadaEm no futuro (${item.aprovadaEm}).`);
    if (!item.origem.trim()) throw falha(nome, `item ${i}: origem vazia.`);
    const forma = JSON.stringify(chave);
    if (vistas.has(forma)) throw falha(nome, `item ${i}: mesma frase do item ${vistas.get(forma)} (chave repetida).`);
    vistas.set(forma, i);
    return { ...item, chave };
  });
}

const CAMPOS_RETRATO = ['experiencias', 'formacao', 'cursos', 'idiomas', 'complementos', 'unidadesComSinal', 'preparo', 'proibidasSha256'];

// Todo texto do retrato, em qualquer profundidade (inclusive chaves de objeto).
function* textos(valor, caminho) {
  if (typeof valor === 'string') yield [caminho, valor];
  else if (Array.isArray(valor)) for (const [i, item] of valor.entries()) yield* textos(item, `${caminho}[${i}]`);
  else if (isObject(valor)) for (const [chave, item] of Object.entries(valor)) { yield [`${caminho} (chave)`, chave]; yield* textos(item, `${caminho}.${chave}`); }
}

/** bases-aprovadas.json: bases com o hash conferido contra o retrato gravado; ausente = nenhuma base aprovada. */
export async function carregarBasesAprovadas({ dataDir }) {
  const nome = 'bases-aprovadas.json';
  const doc = await lerJson(dataDir, nome);
  if (doc === undefined) return {};
  if (!exactKeys(doc, ['versao', 'bases']) || doc.versao !== 1 || !isObject(doc.bases)) {
    throw falha(nome, 'o arquivo precisa ser { versao: 1, bases: { ... } }.');
  }
  for (const [base, item] of Object.entries(doc.bases)) {
    if (!/^[A-Za-z0-9_-]+$/.test(base)) throw falha(nome, `base "${base}": nome precisa casar ^[A-Za-z0-9_-]+$.`);
    if (!exactKeys(item, ['aprovadaEm', 'hash', 'retrato']) || !dataValida(item.aprovadaEm) || typeof item.hash !== 'string') {
      throw falha(nome, `base "${base}" precisa ter só aprovadaEm (AAAA-MM-DD), hash e retrato.`);
    }
    if (!exactKeys(item.retrato, CAMPOS_RETRATO)) throw falha(nome, `base "${base}": retrato precisa ter só ${CAMPOS_RETRATO.join(', ')}.`);
    for (const [caminho, texto] of textos(item.retrato, 'retrato')) semControle(nome, `base "${base}"`, caminho, texto);
    // Detecta retrato mexido sem recalcular o hash; não detecta edição deliberada (limite declarado, §6).
    if (hashRetrato(item.retrato) !== item.hash) throw falha(nome, `base "${base}": o hash não confere com o retrato gravado (arquivo editado à mão não vale).`);
  }
  return doc.bases;
}
