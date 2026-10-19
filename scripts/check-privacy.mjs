#!/usr/bin/env node
// Guarda de privacidade: varre o repositório e falha se encontrar dado pessoal.
// A lógica de detecção (texto -> achados) é pura e exportada para teste.
// O acesso a git e a disco fica isolado nas funções abaixo, fora da detecção.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveDataDir } from '../src/data-dir.mjs';

const PLACEHOLDER_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'exemplo.com']);

function isPlaceholderEmail(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain.toLowerCase())) return true;
  if (/no-?reply/i.test(local)) return true;
  // O noreply do GitHub existe para esconder o e-mail; é o único aceito no
  // commit público (PREMISSA S18). O login nele continua sujeito à lista privada.
  if (domain.toLowerCase() === 'users.noreply.github.com') return true;
  return false;
}

function findEmails(line) {
  const results = [];
  const regex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let m;
  while ((m = regex.exec(line))) {
    if (!isPlaceholderEmail(m[0])) results.push({ type: 'e-mail', match: m[0] });
  }
  return results;
}

// Telefone formatado exige separador (parênteses, espaço, hífen ou +55).
const PHONE_REGEX =
  /(?:\+55[\s-]?)?\(\d{2}\)[\s-]?9?\d{4}-?\d{4}|\+55[\s-]?\d{2}[\s-]?9?\d{4}-?\d{4}|\b\d{2}[\s-]9?\d{4}-\d{4}\b/g;

// DDDs de fato emitidos pela Anatel. Sem essa lista, qualquer sequência de 11
// dígitos corridos (id longo, hash, código de rastreio) viraria falso positivo.
const VALID_BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Celular brasileiro sem formatação é DDD (2 dígitos) + 9 (nono dígito) + 8
// dígitos, sempre 11 dígitos corridos. Exigir DDD válido e nono dígito "9"
// evita marcar um id de vaga de 10 dígitos (comum neste projeto) ou qualquer
// outra sequência de dígitos sem cara de telefone; por isso sequência de 10
// dígitos nunca é acusada aqui, só de 11.
// Limitação aceita: um identificador puramente numérico de 11 dígitos que por
// coincidência comece com DDD válido seguido de "9" também é acusado como
// celular. Não há como diferenciar os dois só pelo formato; em exemplo ou
// resposta gravada de teste, use identificador fictício de outro tamanho ou
// com prefixo.
function isMobileDigits(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  const ddd = Number(digits.slice(0, 2));
  return digits[2] === '9' && VALID_BR_DDD.has(ddd);
}

function findPhones(line) {
  const results = [];
  const formatted = new RegExp(PHONE_REGEX);
  let m;
  while ((m = formatted.exec(line))) {
    results.push({ type: 'telefone', match: m[0] });
  }
  const plain = /\b\d{11}\b/g;
  while ((m = plain.exec(line))) {
    if (isMobileDigits(m[0])) results.push({ type: 'telefone', match: m[0] });
  }
  return results;
}

// Algoritmo oficial dos dígitos verificadores do CPF. Validar o dígito evita
// marcar qualquer sequência de 11 números (datas, ids, hashes) como CPF.
function isValidCPF(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const calcDigit = (base) => {
    let sum = 0;
    let weight = base.length + 1;
    for (const ch of base) {
      sum += Number(ch) * weight;
      weight -= 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const base = digits.slice(0, 9);
  const d1 = calcDigit(base);
  const d2 = calcDigit(base + String(d1));
  return digits === base + String(d1) + String(d2);
}

// Mesma lógica do CPF, com os pesos oficiais do CNPJ.
function isValidCNPJ(digits) {
  if (!/^\d{14}$/.test(digits)) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;
  const calcDigit = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < base.length; i += 1) sum += Number(base[i]) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const base = digits.slice(0, 12);
  const d1 = calcDigit(base, weights1);
  const d2 = calcDigit(base + String(d1), weights2);
  return digits === base + String(d1) + String(d2);
}

function findCPF(line) {
  const results = [];
  let m;
  const formatted = /\d{3}\.\d{3}\.\d{3}-\d{2}/g;
  while ((m = formatted.exec(line))) {
    if (isValidCPF(m[0].replace(/\D/g, ''))) results.push({ type: 'CPF', match: m[0] });
  }
  const plain = /\b\d{11}\b/g;
  while ((m = plain.exec(line))) {
    if (isValidCPF(m[0])) results.push({ type: 'CPF', match: m[0] });
  }
  return results;
}

function findCNPJ(line) {
  const results = [];
  let m;
  const formatted = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g;
  while ((m = formatted.exec(line))) {
    if (isValidCNPJ(m[0].replace(/\D/g, ''))) results.push({ type: 'CNPJ', match: m[0] });
  }
  const plain = /\b\d{14}\b/g;
  while ((m = plain.exec(line))) {
    if (isValidCNPJ(m[0])) results.push({ type: 'CNPJ', match: m[0] });
  }
  return results;
}

// O nome após "/Users/", "/home/" ou "C:\Users\" só conta como caminho real
// quando é feito de caracteres de nome de verdade; "..." (reticências) é o
// jeito como a própria documentação do projeto se refere ao caminho em
// abstrato e precisa passar.
function isPlaceholderPathSegment(segment) {
  return /^\.+$/.test(segment);
}

const USER_PATH_PATTERNS = [
  // "/Users/" com barra normal também casa dentro de "C:/Users/..." (caminho
  // do Windows escrito com barra normal), então não precisa de padrão à parte.
  /\/Users\/([A-Za-z0-9_.-]+)/g,
  /\/home\/([A-Za-z0-9_.-]+)/g,
  // uma ou mais barras invertidas: dentro de uma string JSON o caminho do
  // Windows aparece com barra dupla no texto cru do arquivo.
  /C:\\+Users\\+([A-Za-z0-9_.-]+)/gi,
  // o mesmo caminho depois que um shell ou um escape comeu as barras invertidas
  /\bC:Users([A-Za-z0-9_.-]+)/gi,
];

function findUserPaths(line) {
  const results = [];
  for (const pattern of USER_PATH_PATTERNS) {
    const regex = new RegExp(pattern);
    let m;
    while ((m = regex.exec(line))) {
      if (isPlaceholderPathSegment(m[1])) continue;
      results.push({ type: 'caminho de usuário', match: m[0] });
    }
  }
  return results;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findPrivateTerms(line, privateTerms) {
  const results = [];
  for (const term of privateTerms) {
    if (!term) continue;
    const regex = new RegExp(escapeRegExp(term), 'gi');
    let m;
    while ((m = regex.exec(line))) {
      results.push({ type: 'termo privado', match: m[0] });
    }
  }
  return results;
}

function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Função pura de detecção: texto -> lista de achados.
 * `allowList` são linhas inteiras que, quando batem exatamente com uma linha
 * do texto, pulam a checagem genérica daquela linha (exceções do
 * .privacy-allow). A lista privada não aceita exceção: os termos dela são
 * procurados mesmo nas linhas do .privacy-allow, senão bastaria copiar a
 * linha com o nome para o .privacy-allow e o nome sairia no público.
 * `privateTerms` são termos adicionais (nomes, empregadores) a procurar.
 */
export function scanContent(text, { allowList = [], privateTerms = [] } = {}) {
  const allowSet = new Set(allowList.map((l) => l.trim()).filter(Boolean));
  const findings = [];
  splitLines(text).forEach((line, idx) => {
    const lineNumber = idx + 1;
    const generic = allowSet.has(line.trim())
      ? []
      : [...findEmails(line), ...findPhones(line), ...findCPF(line), ...findCNPJ(line), ...findUserPaths(line)];
    const lineFindings = [...generic, ...findPrivateTerms(line, privateTerms)];
    for (const f of lineFindings) findings.push({ line: lineNumber, ...f });
  });
  return findings;
}

/** O caminho de um arquivo, conferido como uma linha de texto, sem exceção do .privacy-allow. */
export function scanPath(filePath, privateTerms = []) {
  return scanContent(filePath, { privateTerms }).map(({ type, match }) => ({ type, match }));
}

// ---------- acesso a disco (separado da detecção) ----------

function parsePrivateList(content) {
  return splitLines(content)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function readPrivateTerms(homeDir = homedir()) {
  const file = path.join(homeDir, '.radar-de-vagas', 'privado.txt');
  if (!existsSync(file)) return [];
  return parsePrivateList(readFileSync(file, 'utf8'));
}

/**
 * Lê a lista privada da pasta de dados: `$RADAR_DATA_DIR/privado.txt` ou, sem
 * a variável, `~/.radar-de-vagas/privado.txt` (a mesma regra de
 * `resolveDataDir`). A lista mora fora do repositório e nunca é versionada.
 * Devolve `null` quando o arquivo não existe ou não tem nenhum termo: para o
 * modo `--historico`, lista vazia é lista ausente.
 */
export function loadPrivateList(env = process.env) {
  const file = path.join(resolveDataDir(env), 'privado.txt');
  if (!existsSync(file)) return null;
  const terms = parsePrivateList(readFileSync(file, 'utf8'));
  return terms.length > 0 ? terms : null;
}

export function isBinaryBuffer(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ---------- acesso a git (separado da detecção) ----------
//
// A fonte de verdade é o ÍNDICE do git (o que está preparado para commit e o
// que já está rastreado), nunca o arquivo em disco: depois de um `git add`, a
// pessoa pode sobrescrever o arquivo no disco sem dar `git add` de novo, e o
// que de fato vai pro commit é o conteúdo que já está no índice. No GitHub o
// índice de um checkout limpo é igual ao disco, então o mesmo código serve.

const MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Lista as entradas do índice do git: caminho, sha do blob e modo.
 * Usa `-z` (saída terminada em NUL, sem aspas/escape octal no nome) para que
 * nome de arquivo acentuado ou com espaço não seja perdido no meio do caminho.
 */
export function listIndexEntries(repoRoot) {
  const buffer = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: repoRoot,
    maxBuffer: MAX_BUFFER,
  });
  const raw = buffer.toString('utf8');
  return raw
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tabIndex = entry.indexOf('\t');
      const meta = entry.slice(0, tabIndex);
      const filePath = entry.slice(tabIndex + 1);
      const [mode, sha] = meta.split(' ');
      return { path: filePath, sha, mode };
    });
}

/** Lê o conteúdo de um blob do índice pelo sha, sem passar pelo disco. */
export function readBlobContent(repoRoot, sha) {
  return execFileSync('git', ['cat-file', '-p', sha], { cwd: repoRoot, maxBuffer: MAX_BUFFER });
}

/**
 * Lê as exceções de `.privacy-allow` do próprio índice do git, nunca do
 * disco: uma linha só vira exceção depois de um `git add` nela, senão
 * qualquer edição no arquivo em disco liberaria dado pessoal sem deixar
 * rastro no commit. Se `.privacy-allow` não estiver no índice, a lista é
 * vazia. `entries` é opcional, para reaproveitar uma listagem já feita.
 */
export function readAllowList(repoRoot, entries) {
  const indexEntries = entries ?? listIndexEntries(repoRoot);
  const entry = indexEntries.find((e) => e.path === '.privacy-allow');
  if (!entry) return [];
  const content = readBlobContent(repoRoot, entry.sha).toString('utf8');
  return splitLines(content).filter((l) => l.trim() && !l.trim().startsWith('#'));
}

/**
 * Varre o índice do git a partir da raiz do repositório informada (não do
 * diretório atual), o que permite testar contra um repositório temporário.
 */
export function scanRepository(repoRoot, { privateTerms = [], useAllowList = true } = {}) {
  const entries = listIndexEntries(repoRoot);
  const allowList = useAllowList ? readAllowList(repoRoot, entries) : [];
  const findings = [];
  const errors = [];

  for (const entry of entries) {
    // O nome do arquivo também vai a público: nome, e-mail ou caminho de
    // usuário no caminho é achado como no conteúdo, sem exceção.
    for (const f of scanPath(entry.path, privateTerms)) findings.push({ file: entry.path, inPath: true, ...f });

    if (entry.mode === '160000') continue; // submódulo: não tem conteúdo de arquivo próprio

    let buffer;
    try {
      buffer = readBlobContent(repoRoot, entry.sha);
    } catch (err) {
      errors.push({ file: entry.path, message: err.message });
      continue;
    }

    if (isBinaryBuffer(buffer)) continue;

    const fileFindings = scanContent(buffer.toString('utf8'), { allowList, privateTerms });
    for (const f of fileFindings) findings.push({ file: entry.path, ...f });
  }

  return { findings, errors };
}

// ---------- histórico (todo blob alcançável e os metadados de todo commit) ----------
//
// O que a árvore de hoje não tem pode estar num commit antigo, e quem clona o
// repositório recebe o histórico inteiro. Por isso o modo `--historico` lê
// cada blob alcançável uma vez (`git rev-list --all --objects`) e o nome, o
// e-mail e a mensagem de todo commit.

const HISTORY_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Lê vários objetos com um processo só (`git cat-file --batch`), sem
 * conversão de fim de linha. Devolve um Map sha -> Buffer.
 */
export function readBlobs(repoRoot, shas) {
  const result = new Map();
  if (shas.length === 0) return result;
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: `${shas.join('\n')}\n`,
    maxBuffer: HISTORY_MAX_BUFFER,
  });
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString('utf8').split(' ');
    if (header[1] === 'missing') throw new Error(`objeto ausente: ${header[0]}`);
    const size = Number(header[2]);
    result.set(header[0], out.subarray(eol + 1, eol + 1 + size));
    pos = eol + 1 + size + 1;
  }
  return result;
}

/** Todo blob alcançável por qualquer ref, uma vez cada, com o primeiro caminho em que aparece. */
export function listReachableBlobs(repoRoot) {
  const raw = execFileSync('git', ['rev-list', '--all', '--objects'], {
    cwd: repoRoot,
    maxBuffer: HISTORY_MAX_BUFFER,
  }).toString('utf8');
  const pathBySha = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const sha = space === -1 ? line : line.slice(0, space);
    if (!pathBySha.has(sha)) pathBySha.set(sha, space === -1 ? '' : line.slice(space + 1));
  }
  if (pathBySha.size === 0) return [];
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: repoRoot,
    input: `${[...pathBySha.keys()].join('\n')}\n`,
    maxBuffer: HISTORY_MAX_BUFFER,
  }).toString('utf8');
  const blobs = [];
  for (const line of types.split('\n')) {
    const [sha, type] = line.split(' ');
    if (type === 'blob') blobs.push({ sha, path: pathBySha.get(sha) });
  }
  return blobs;
}

/** O commit mais antigo que traz o blob (`--find-object`), para o achado apontar onde ele entrou. */
function firstCommitWithBlob(repoRoot, sha) {
  const out = execFileSync('git', ['log', '--all', '--reverse', '--format=%H', `--find-object=${sha}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: HISTORY_MAX_BUFFER,
  });
  return out.split('\n').find(Boolean) ?? '?';
}

/**
 * Todo caminho que já existiu em algum commit alcançável, com o commit mais
 * antigo que o toca. Um arquivo só entra no histórico por um commit que o
 * cria, então a lista de arquivos tocados por commit (`-m` inclui os merges)
 * cobre todos os nomes, inclusive os que já foram apagados ou renomeados.
 */
export function listHistoryPaths(repoRoot) {
  if (!hasAnyCommit(repoRoot)) return [];
  const raw = execFileSync('git', ['log', '--all', '--no-renames', '-m', '--name-only', '-z', '--format=%x01%H'], {
    cwd: repoRoot,
    maxBuffer: HISTORY_MAX_BUFFER,
  }).toString('utf8');
  const commitByPath = new Map();
  for (const record of raw.split('\x01')) {
    const [sha, ...paths] = record.split('\0');
    if (!sha) continue;
    // `git log` sai do mais novo para o mais antigo: o último visto é o mais antigo.
    for (const p of paths) {
      const filePath = p.replace(/^\n/, '');
      if (filePath) commitByPath.set(filePath, sha);
    }
  }
  return [...commitByPath].map(([filePath, commit]) => ({ path: filePath, commit }));
}

function hasAnyCommit(repoRoot) {
  return (
    execFileSync('git', ['rev-list', '--all', '--max-count=1'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== ''
  );
}

/** Nome, e-mail e mensagem de todo commit alcançável. */
export function listCommits(repoRoot) {
  if (!hasAnyCommit(repoRoot)) return [];
  const raw = execFileSync('git', ['log', '--all', '-z', '--format=%H%n%an%n%ae%n%cn%n%ce%n%B'], {
    cwd: repoRoot,
    maxBuffer: HISTORY_MAX_BUFFER,
  }).toString('utf8');
  return raw
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const lines = record.split('\n');
      const [sha, authorName, authorEmail, committerName, committerEmail] = lines;
      return { sha, authorName, authorEmail, committerName, committerEmail, message: lines.slice(5).join('\n') };
    });
}

// O e-mail do commit fica público para quem clonar. Só passa o noreply do
// GitHub (`<id>+<conta>@users.noreply.github.com`, a forma antiga sem id, e o
// `noreply@github.com` que o próprio GitHub usa como committer) e os domínios
// de exemplo.
export function isAcceptedCommitEmail(email) {
  if (/^(?:\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$/i.test(email)) return true;
  if (/^noreply@github\.com$/i.test(email)) return true;
  const at = email.lastIndexOf('@');
  return at > 0 && PLACEHOLDER_EMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase());
}

/**
 * Varre o histórico. `skipBlobs` são os blobs que a varredura da árvore já
 * leu (o índice), para o mesmo conteúdo não sair duas vezes.
 * `authorName` é a única exceção da lista privada: o nome dado em `--autor`
 * na exportação, e só nos campos nome de autor e nome de committer, quando o
 * valor é exatamente esse nome. Arquivo e mensagem continuam checados.
 */
export function scanHistory(
  repoRoot,
  { privateTerms = [], allowList = [], skipBlobs = new Set(), skipPaths = new Set(), authorName } = {},
) {
  const findings = [];
  const errors = [];

  for (const { path: filePath, commit } of listHistoryPaths(repoRoot)) {
    if (skipPaths.has(filePath)) continue;
    for (const f of scanPath(filePath, privateTerms)) findings.push({ commit, file: filePath, inPath: true, ...f });
  }

  const blobs = listReachableBlobs(repoRoot).filter((b) => !skipBlobs.has(b.sha));
  let contents;
  try {
    contents = readBlobs(
      repoRoot,
      blobs.map((b) => b.sha),
    );
  } catch (err) {
    errors.push({ file: '(histórico)', message: err.message });
    contents = new Map();
  }
  for (const blob of blobs) {
    const buffer = contents.get(blob.sha);
    if (!buffer || isBinaryBuffer(buffer)) continue;
    const blobFindings = scanContent(buffer.toString('utf8'), { allowList, privateTerms });
    if (blobFindings.length === 0) continue;
    const commit = firstCommitWithBlob(repoRoot, blob.sha);
    for (const f of blobFindings) findings.push({ commit, file: blob.path, ...f });
  }

  for (const c of listCommits(repoRoot)) {
    if (!isAcceptedCommitEmail(c.authorEmail)) {
      findings.push({ commit: c.sha, field: 'autor', type: 'e-mail de autor', match: c.authorEmail });
    }
    if (!isAcceptedCommitEmail(c.committerEmail)) {
      findings.push({ commit: c.sha, field: 'committer', type: 'e-mail de committer', match: c.committerEmail });
    }
    const names = [
      ['nome de autor', c.authorName],
      ['nome de committer', c.committerName],
    ];
    for (const [field, value] of names) {
      const terms = authorName !== undefined && value === authorName ? [] : privateTerms;
      for (const f of scanContent(value, { allowList, privateTerms: terms })) {
        findings.push({ commit: c.sha, field, type: f.type, match: f.match });
      }
    }
    for (const f of scanContent(c.message, { allowList, privateTerms })) {
      findings.push({ commit: c.sha, field: 'mensagem', line: f.line, type: f.type, match: f.match });
    }
  }

  return { findings, errors };
}

/**
 * Uma linha por achado. O texto achado sai escapado (entre aspas, com
 * caractere de controle visível) e nunca a linha inteira: o resto da linha
 * pode ter outro dado que não devia ir parar num log.
 */
export function formatFinding(f) {
  const match = JSON.stringify(f.match);
  if (f.inPath) {
    const where = f.commit ? `histórico ${f.commit} ` : '';
    return `${where}${f.file} (nome do arquivo) - ${f.type}: ${match}`;
  }
  if (f.commit && f.file !== undefined) return `histórico ${f.commit} ${f.file}:${f.line} - ${f.type}: ${match}`;
  if (f.commit) {
    const where = f.line ? `${f.field}:${f.line}` : f.field;
    return `commit ${f.commit} (${where}) - ${f.type}: ${match}`;
  }
  return `${f.file}:${f.line} - ${f.type}: ${match}`;
}

function compareFindings(a, b) {
  const ka = formatFinding(a);
  const kb = formatFinding(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Árvore (índice) e, se pedido, histórico, com a lista privada dada.
 * Devolve os achados na ordem de saída: árvore na ordem do índice, histórico
 * ordenado, para duas varreduras iguais darem a mesma saída byte a byte.
 */
export function scanAll(repoRoot, { privateTerms = [], history = false, authorName, useAllowList = true } = {}) {
  const entries = listIndexEntries(repoRoot);
  const tree = scanRepository(repoRoot, { privateTerms, useAllowList });
  if (!history) return tree;
  const allowList = useAllowList ? readAllowList(repoRoot, entries) : [];
  const skipBlobs = new Set(entries.map((e) => e.sha));
  const skipPaths = new Set(entries.map((e) => e.path));
  const hist = scanHistory(repoRoot, { privateTerms, allowList, skipBlobs, skipPaths, authorName });
  return {
    findings: [...tree.findings, ...hist.findings.sort(compareFindings)],
    errors: [...tree.errors, ...hist.errors],
  };
}

function resolveRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const opts = { history: false, authorName: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--historico') opts.history = true;
    else if (argv[i] === '--nome-autor' && i + 1 < argv.length) opts.authorName = argv[(i += 1)];
    else throw new Error(`argumento desconhecido: ${argv[i]}`);
  }
  return opts;
}

function main() {
  let opts;
  let privateList;
  try {
    opts = parseArgs(process.argv.slice(2));
    privateList = loadPrivateList();
  } catch (err) {
    console.error(`Guarda de privacidade: ${err.message}`);
    console.error('Uso: node scripts/check-privacy.mjs [--historico [--nome-autor "<nome do commit>"]]');
    process.exit(2);
  }
  if (opts.history && privateList === null) {
    console.error(
      'Guarda de privacidade: lista privada ausente. O modo --historico exige privado.txt na pasta de dados ' +
        '(RADAR_DATA_DIR ou ~/.radar-de-vagas), com um termo por linha.',
    );
    process.exit(2);
  }

  const repoRoot = resolveRepoRoot();
  const { findings, errors } = scanAll(repoRoot, {
    privateTerms: privateList ?? [],
    history: opts.history,
    authorName: opts.authorName,
  });

  // Erro de leitura nunca é silencioso: conta como achado para efeito de saída.
  for (const err of errors) {
    console.error(`Guarda de privacidade: erro ao ler ${err.file} do git: ${err.message}`);
  }

  if (findings.length > 0) {
    console.error('Guarda de privacidade encontrou possível dado pessoal:');
    for (const f of findings) {
      console.error(formatFinding(f));
    }
    console.error(`\nTotal: ${findings.length} achado(s).`);
  }

  if (findings.length === 0 && errors.length === 0) {
    const scope = opts.history ? 'Árvore e histórico limpos.' : 'Repositório limpo.';
    console.log(`Guarda de privacidade: nenhum achado. ${scope}`);
    process.exit(0);
  }

  process.exit(1);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
