#!/usr/bin/env node
// Exportação da versão pública: copia uma lista fechada de arquivos do índice
// do git para um repositório novo, com um commit só e autor neutro, e roda a
// guarda de privacidade da árvore e do histórico no destino.
//
// Uso: node scripts/exportar-publico.mjs <destino> --autor "Nome <id+conta@users.noreply.github.com>"
//
// Não publica: não cria repositório remoto, não adiciona remoto, não envia
// nada. Publicar é ato da pessoa, no terminal dela; o script só imprime o
// comando no fim.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatFinding, listIndexEntries, loadPrivateList, readBlobs, scanAll } from './check-privacy.mjs';

/** O que vai ao público. Item com barra no fim é pasta (tudo que está no índice dentro dela). */
export const INCLUIR = [
  'src/',
  'bin/',
  'test/',
  'skills/',
  'scripts/',
  'examples/',
  'decisions/',
  '.claude-plugin/',
  '.github/workflows/checks.yml',
  '.githooks/',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CONTEXT.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'PRD.md',
  'CHANGELOG.md',
  'docs/contrato-de-fonte.md',
  'docs/estado-local.md',
  'docs/referencia.md',
  'package.json',
  '.gitignore',
  '.gitattributes',
  '.privacy-allow',
];

/** Único arquivo renomeado: o CLAUDE.md público substitui o da casa. */
export const MAPEAMENTO = { 'publico/CLAUDE.md': 'CLAUDE.md' };

/** O que nunca vai, mesmo se alguém puser na lista de dentro (a lista incoerente é recusada). */
export const EXCLUIR = [
  'CLAUDE.md',
  'DECISIONS.md',
  'docs/PRD.md',
  'docs/spec.md',
  'docs/spec.aprovada',
  'docs/trabalho-avulso.md',
  'docs/backlog.md',
  'docs/stories/',
  'HANDOFF.md',
  'STATUS.md',
  'LESSONS.md',
  'projeto.yml',
  'testar_fumaca.py',
  '.github/workflows/testes.yml',
];

const MENSAGEM_DO_COMMIT = 'Radar de Vagas: versão pública';
const MARCADOR = 'radar-publico';
const NOREPLY_GITHUB = /^\d+\+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?@users\.noreply\.github\.com$/;
const MAX_BUFFER = 512 * 1024 * 1024;

const ALLOWLIST = '.privacy-allow';

class ErroDeUso extends Error {}

/**
 * As exceções da origem não vão ao público: uma linha liberada no repositório
 * de trabalho liberaria a mesma linha no destino. O arquivo vai só com os
 * comentários, para quem clonar saber onde pôr as próprias exceções.
 */
function soComentarios(buffer) {
  const linhas = buffer.toString('utf8').split(/\r?\n/);
  return linhas.filter((l) => l.trim() === '' || l.trim().startsWith('#')).join('\n').replace(/\n+$/, '\n');
}

function casa(item, caminho) {
  return item.endsWith('/') ? caminho.startsWith(item) : caminho === item;
}

/** `Nome <email>` -> { nome, email }; o e-mail só pode ser o noreply do GitHub (PREMISSA S18). */
export function lerAutor(texto) {
  const m = /^\s*([^<>]*?)\s*<([^<>\s]+)>\s*$/.exec(texto ?? '');
  if (!m || !m[1]) throw new ErroDeUso('--autor precisa ser "Nome <email>".');
  if (!NOREPLY_GITHUB.test(m[2])) {
    throw new ErroDeUso(
      'use o e-mail noreply do GitHub: o e-mail do commit fica público ' +
        '(formato <id>+<conta>@users.noreply.github.com, em github.com/settings/emails).',
    );
  }
  return { nome: m[1], email: m[2] };
}

function lerArgumentos(argv) {
  let destino;
  let autor;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--autor') {
      if (i + 1 >= argv.length) throw new ErroDeUso('--autor sem valor.');
      autor = argv[(i += 1)];
    } else if (argv[i].startsWith('--')) {
      throw new ErroDeUso(`opção desconhecida: ${argv[i]}`);
    } else if (destino === undefined) {
      destino = argv[i];
    } else {
      throw new ErroDeUso(`argumento a mais: ${argv[i]}`);
    }
  }
  if (destino === undefined) throw new ErroDeUso('falta o <destino>.');
  if (autor === undefined) throw new ErroDeUso('falta --autor: o script nunca usa o user.email da máquina.');
  return { destino, autor: lerAutor(autor) };
}

/**
 * Escolhe, do índice, o que vai ao destino. Todo item da lista de dentro
 * precisa estar no índice: um arquivo que falta faria o público nascer
 * incompleto sem ninguém notar.
 */
export function selecionarArquivos(entries) {
  const selecionados = [];
  const faltando = [];
  const itens = [...INCLUIR.map((item) => [item, null]), ...Object.entries(MAPEAMENTO)];
  for (const [item, renomeado] of itens) {
    const achados = entries.filter((e) => casa(item, e.path));
    if (achados.length === 0) faltando.push(item);
    for (const e of achados) selecionados.push({ ...e, destino: renomeado ?? e.path });
  }
  if (faltando.length > 0) throw new ErroDeUso(`arquivo da lista ausente no índice: ${faltando.join(', ')}`);

  const vistos = new Set();
  for (const s of selecionados) {
    if (s.mode === '160000' || s.mode === '120000') {
      throw new ErroDeUso(`submódulo ou atalho simbólico não é exportado: ${s.path}`);
    }
    if (EXCLUIR.some((item) => casa(item, s.path))) {
      throw new ErroDeUso(`a lista de dentro inclui um arquivo da lista de fora: ${s.path}`);
    }
    if (vistos.has(s.destino)) throw new ErroDeUso(`dois arquivos com o mesmo destino: ${s.destino}`);
    vistos.add(s.destino);
  }
  return selecionados;
}

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/**
 * Faz a exportação. Devolve `{ codigo, saida, erros }` em vez de sair do
 * processo, para o teste chamar direto. `antesDoCommit(destino)` existe só
 * para o teste criar um commit no destino antes do commit da exportação.
 */
export function exportarPublico(argv, { cwd = process.cwd(), env = process.env, antesDoCommit } = {}) {
  const saida = [];
  const erros = [];
  const fim = (codigo) => ({ codigo, saida, erros });

  let destino;
  let autor;
  let privateTerms;
  let selecionados;
  let origem;
  try {
    ({ destino, autor } = lerArgumentos(argv));
    destino = path.resolve(cwd, destino);
    if (existsSync(destino)) throw new ErroDeUso(`o destino já existe: ${destino}`);
    privateTerms = loadPrivateList(env);
    if (privateTerms === null) {
      throw new ErroDeUso(
        'lista privada ausente: a exportação exige privado.txt na pasta de dados (RADAR_DATA_DIR ou ~/.radar-de-vagas).',
      );
    }
    origem = git(cwd, ['rev-parse', '--show-toplevel'], env).trim();
    const relativo = path.relative(path.resolve(origem), destino);
    if (!relativo.startsWith('..') && !path.isAbsolute(relativo)) {
      throw new ErroDeUso('o destino não pode ficar dentro do repositório de origem.');
    }
    selecionados = selecionarArquivos(listIndexEntries(origem));
  } catch (err) {
    erros.push(`Exportação: ${err.message}`);
    if (!(err instanceof ErroDeUso)) return fim(1);
    erros.push('Uso: node scripts/exportar-publico.mjs <destino> --autor "Nome <id+conta@users.noreply.github.com>"');
    return fim(2);
  }

  // Conteúdo lido do índice, byte a byte: sem conversão de fim de linha, o
  // que está no índice (LF) é o que chega ao destino, qualquer que seja o
  // core.autocrlf da cópia de trabalho.
  const conteudos = readBlobs(
    origem,
    selecionados.map((s) => s.sha),
  );
  for (const s of selecionados) {
    const alvo = path.join(destino, ...s.destino.split('/'));
    mkdirSync(path.dirname(alvo), { recursive: true });
    writeFileSync(alvo, s.destino === ALLOWLIST ? soComentarios(conteudos.get(s.sha)) : conteudos.get(s.sha));
  }

  git(destino, ['init', '-q', '-b', 'main'], env);
  // Dentro do .git, fora da árvore: nunca vai ao commit e marca o destino para
  // o hook da casa negar o envio feito por agente.
  writeFileSync(path.join(destino, '.git', MARCADOR), 'repositório gerado por scripts/exportar-publico.mjs\n');

  if (antesDoCommit) antesDoCommit(destino);

  const envDoCommit = {
    ...env,
    GIT_AUTHOR_NAME: autor.nome,
    GIT_AUTHOR_EMAIL: autor.email,
    GIT_COMMITTER_NAME: autor.nome,
    GIT_COMMITTER_EMAIL: autor.email,
  };
  const semConversao = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
  git(destino, [...semConversao, 'add', '-A'], envDoCommit);
  const executaveis = selecionados.filter((s) => s.mode === '100755').map((s) => s.destino);
  if (executaveis.length > 0) git(destino, [...semConversao, 'add', '--chmod=+x', '--', ...executaveis], envDoCommit);
  git(
    destino,
    ['-c', `user.name=${autor.nome}`, '-c', `user.email=${autor.email}`, 'commit', '-q', '-m', MENSAGEM_DO_COMMIT],
    envDoCommit,
  );

  // Confere o que ficou gravado, não o que foi pedido: os quatro campos de todo
  // commit do destino têm de ser o --autor.
  const esperado = [autor.nome, autor.email, autor.nome, autor.email];
  const campos = git(destino, ['log', '--format=%an%x00%ae%x00%cn%x00%ce'], env).split('\n').filter(Boolean);
  for (const linha of campos) {
    const valores = linha.split('\0');
    if (valores.some((v, i) => v !== esperado[i])) {
      erros.push('Exportação: autor ou committer do destino difere do --autor. O destino foi mantido para conferência.');
      return fim(1);
    }
  }

  // Sem .privacy-allow no gate do destino: o que vai a público não tem
  // exceção para e-mail, telefone, caminho de usuário nem termo privado.
  const { findings, errors } = scanAll(destino, {
    privateTerms,
    history: true,
    authorName: autor.nome,
    useAllowList: false,
  });
  for (const err of errors) erros.push(`Guarda de privacidade: erro ao ler ${err.file} do git: ${err.message}`);
  if (findings.length > 0 || errors.length > 0) {
    erros.push('Guarda de privacidade encontrou possível dado pessoal no destino:');
    for (const f of findings) erros.push(formatFinding(f));
    erros.push(`Total: ${findings.length} achado(s). O destino foi mantido para conferência; nada foi publicado.`);
    return fim(1);
  }

  saida.push(`Exportação pronta em ${destino}: ${selecionados.length} arquivo(s), árvore e histórico limpos.`);
  saida.push('Nada foi publicado. Para publicar, rode você mesmo, no seu terminal e na conta do GitHub que escolher:');
  saida.push(`  gh repo create <nome> --public --source "${destino}" --push`);
  return fim(0);
}

function main() {
  const { codigo, saida, erros } = exportarPublico(process.argv.slice(2));
  for (const linha of erros) console.error(linha);
  for (const linha of saida) console.log(linha);
  process.exit(codigo);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
