// Testes da exportação para o repositório público (T30).
//
// Tudo acontece em pastas temporárias, com repositórios git criados aqui,
// configuração global do git falsa e e-mails inventados. O destino é sempre
// uma pasta temporária; nada é publicado. Amostras com cara de dado real são
// montadas por concatenação, para a guarda de privacidade não acusar este
// arquivo ao rodar sobre o repositório.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXCLUIR, INCLUIR, MAPEAMENTO, exportarPublico } from '../scripts/exportar-publico.mjs';

const AMBIENTE_FALSO = mkdtempSync(path.join(tmpdir(), 'radar-export-amb-'));
const CONFIG_GLOBAL_FALSA = path.join(AMBIENTE_FALSO, 'gitconfig');
const CASA_FALSA = path.join(AMBIENTE_FALSO, 'casa');
mkdirSync(CASA_FALSA);
writeFileSync(
  CONFIG_GLOBAL_FALSA,
  '[user]\n\tname = Pessoa Teste\n\temail = 1000+pessoa-teste@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n',
);
process.env.GIT_CONFIG_GLOBAL = CONFIG_GLOBAL_FALSA;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = CASA_FALSA;
process.env.USERPROFILE = CASA_FALSA;
delete process.env.RADAR_DATA_DIR;
process.on('exit', () => rmSync(AMBIENTE_FALSO, { recursive: true, force: true }));

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(RAIZ, 'scripts', 'exportar-publico.mjs');

const AUTOR_NOME = 'Fulana Inventada Publicadora';
const AUTOR_EMAIL = '4321+fulana-inventada@users.noreply.github.com';
const AUTOR = `${AUTOR_NOME} <${AUTOR_EMAIL}>`;
const TERMO = 'Empresa Secreta Inventada Ltda';
const CONTEUDO_CLAUDE_PUBLICO = '# Instruções para o agente\n\nparte pública\n';

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-export-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, args, env = process.env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function gravar(repo, relPath, conteudo) {
  const abs = path.join(repo, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, conteudo, 'utf8');
}

/** Caminho de exemplo para cada item da lista de dentro (pasta ganha um arquivo). */
function arquivoDoItem(item) {
  return item.endsWith('/') ? `${item}exemplo.txt` : item;
}

/**
 * Repo de origem com todos os arquivos da lista de dentro, o CLAUDE.md
 * público, os arquivos da casa que ficam de fora e um arquivo solto fora das
 * duas listas. `sem` tira itens do índice; `extra` acrescenta arquivos.
 */
function criarOrigem(dir, { sem = [], extra = {} } = {}) {
  const repo = path.join(dir, 'origem');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  const arquivos = {};
  for (const item of INCLUIR) arquivos[arquivoDoItem(item)] = `conteúdo de ${item}\nsegunda linha\n`;
  arquivos['publico/CLAUDE.md'] = CONTEUDO_CLAUDE_PUBLICO;
  arquivos['CLAUDE.md'] = '# CLAUDE.md da casa\n## Stack\n';
  arquivos['DECISIONS.md'] = '# decisões da casa\n';
  arquivos['docs/spec.md'] = '# spec da casa\n';
  arquivos['docs/stories/1.story.md'] = '# story\n';
  arquivos['notas-soltas.md'] = 'fora das duas listas\n';
  Object.assign(arquivos, extra);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    if (!sem.includes(rel)) gravar(repo, rel, conteudo);
  }
  git(repo, ['add', '-A']);
  return repo;
}

function dadosCom(dir, termos) {
  const dataDir = path.join(dir, 'dados');
  mkdirSync(dataDir, { recursive: true });
  if (termos) writeFileSync(path.join(dataDir, 'privado.txt'), `${termos.join('\n')}\n`, 'utf8');
  return dataDir;
}

function ambiente(dataDir, extra = {}) {
  return { ...process.env, RADAR_DATA_DIR: dataDir, ...extra };
}

function exportar(origem, destino, { dataDir, autor = AUTOR, env, antesDoCommit } = {}) {
  const argv = autor === null ? [destino] : [destino, '--autor', autor];
  return exportarPublico(argv, { cwd: origem, env: env ?? ambiente(dataDir), antesDoCommit });
}

function texto(r) {
  return [...r.saida, ...r.erros].join('\n');
}

function arquivosDoDestino(destino) {
  return git(destino, ['ls-files']).split('\n').filter(Boolean).sort();
}

test('30.1: só a lista de dentro chega ao destino; o CLAUDE.md é o público', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = spawnSync(process.execPath, [SCRIPT, destino, '--autor', AUTOR], {
      cwd: origem,
      env: ambiente(dataDir),
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const esperado = [...INCLUIR.map(arquivoDoItem), ...Object.values(MAPEAMENTO)].sort();
    assert.deepEqual(arquivosDoDestino(destino), esperado);
    for (const fora of ['DECISIONS.md', 'docs/spec.md', 'docs/stories/1.story.md', 'notas-soltas.md', 'publico']) {
      assert.ok(!existsSync(path.join(destino, fora)), fora);
    }
    assert.equal(readFileSync(path.join(destino, 'CLAUDE.md'), 'utf8'), CONTEUDO_CLAUDE_PUBLICO);
    assert.equal(git(destino, ['rev-list', '--count', 'HEAD']).trim(), '1');
  });
});

test('30.1: a lista de dentro não pode conter item da lista de fora', () => {
  for (const item of INCLUIR) {
    assert.ok(!EXCLUIR.some((fora) => (fora.endsWith('/') ? item.startsWith(fora) : item === fora)), item);
  }
  assert.ok(EXCLUIR.includes('CLAUDE.md'));
  assert.ok(EXCLUIR.includes('DECISIONS.md'));
});

test('30.2: autor e committer saem do --autor, nunca do user.email da configuração global', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);
    const emailPessoal = ['pessoa.inventada.pessoal', '@', 'gmail.com'].join('');
    const configPessoal = path.join(dir, 'gitconfig-pessoal');
    writeFileSync(configPessoal, `[user]\n\tname = Nome Pessoal Inventado\n\temail = ${emailPessoal}\n`);

    const r = exportar(origem, destino, { env: ambiente(dataDir, { GIT_CONFIG_GLOBAL: configPessoal }) });

    assert.equal(r.codigo, 0, texto(r));
    const campos = git(destino, ['log', '--format=%an%x00%ae%x00%cn%x00%ce']).trim().split('\0');
    assert.deepEqual(campos, [AUTOR_NOME, AUTOR_EMAIL, AUTOR_NOME, AUTOR_EMAIL]);
    const commitCru = git(destino, ['cat-file', '-p', 'HEAD']);
    assert.ok(!commitCru.includes(emailPessoal), commitCru);
    assert.ok(!commitCru.includes('Nome Pessoal Inventado'), commitCru);
  });
});

test('30.2: sem --autor sai 2 e não grava nada', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = spawnSync(process.execPath, [SCRIPT, destino], { cwd: origem, env: ambiente(dataDir), encoding: 'utf8' });

    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /falta --autor/);
    assert.ok(!existsSync(destino));
  });
});

test('30.2: e-mail fora do noreply do GitHub sai 2, sem opção de aceitar', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);
    const emailPessoal = ['fulana', '@', 'gmail.com'].join('');

    for (const email of ['fulana@example.com', emailPessoal, 'fulana@users.noreply.github.com']) {
      const r = exportar(origem, destino, { dataDir, autor: `${AUTOR_NOME} <${email}>` });
      assert.equal(r.codigo, 2, `${email}: ${texto(r)}`);
      assert.ok(texto(r).includes('use o e-mail noreply do GitHub: o e-mail do commit fica público'), texto(r));
      assert.ok(!existsSync(destino));
    }
  });
});

test('30.3: destino existente sai 2 e não grava nada', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    mkdirSync(destino);
    writeFileSync(path.join(destino, 'ja-estava.txt'), 'x\n');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 2, texto(r));
    assert.match(texto(r), /o destino já existe/);
    assert.deepEqual(readdirSync(destino), ['ja-estava.txt']);
  });
});

test('30.3: arquivo da lista ausente no índice sai 2 e não grava nada', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir, { sem: ['.gitattributes'] });
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 2, texto(r));
    assert.ok(texto(r).includes('arquivo da lista ausente no índice: .gitattributes'), texto(r));
    assert.ok(!existsSync(destino));
  });
});

test('30.3: sem a lista privada, sai 2 e não grava nada', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, null);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 2, texto(r));
    assert.match(texto(r), /lista privada ausente/);
    assert.ok(!existsSync(destino));
  });
});

test('30.4: termo da lista num arquivo exportado: sai 1 com o achado e não apaga o destino', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir, { extra: { 'src/cliente.mjs': `// atende ${TERMO}\n` } });
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 1, texto(r));
    assert.ok(texto(r).includes(`src/cliente.mjs:1 - termo privado: "${TERMO}"`), texto(r));
    assert.ok(existsSync(path.join(destino, 'src', 'cliente.mjs')));
    assert.ok(!r.saida.some((l) => l.includes('gh repo create')), texto(r));
  });
});

test('30.4: com 0 achados, imprime o comando de publicação e não o executa', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 0, texto(r));
    assert.ok(r.saida.includes(`  gh repo create <nome> --public --source "${destino}" --push`), texto(r));
    assert.equal(git(destino, ['remote']).trim(), '');
  });
});

test('30.4: termo plantado só no histórico do destino é pego pelo gate do histórico', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);
    let plantado;
    // Um commit antes do da exportação, com o mesmo autor (para a conferência
    // do autor não reprovar antes do gate), e o arquivo apagado em seguida.
    const plantar = (dest) => {
      const envAutor = {
        ...process.env,
        GIT_AUTHOR_NAME: AUTOR_NOME,
        GIT_AUTHOR_EMAIL: AUTOR_EMAIL,
        GIT_COMMITTER_NAME: AUTOR_NOME,
        GIT_COMMITTER_EMAIL: AUTOR_EMAIL,
      };
      writeFileSync(path.join(dest, 'plantado.md'), `cliente: ${TERMO}\n`);
      git(dest, ['add', 'plantado.md'], envAutor);
      git(dest, ['commit', '-q', '-m', 'anterior'], envAutor);
      plantado = git(dest, ['rev-parse', 'HEAD']).trim();
      git(dest, ['rm', '-q', 'plantado.md'], envAutor);
    };

    const r = exportar(origem, destino, { dataDir, antesDoCommit: plantar });

    assert.equal(r.codigo, 1, texto(r));
    assert.ok(texto(r).includes(`histórico ${plantado} plantado.md:1 - termo privado: "${TERMO}"`), texto(r));
  });
});

test('30.4: o nome do --autor na lista só é exceção no campo nome do commit', () => {
  withTempDir((dir) => {
    const dataDir = dadosCom(dir, [TERMO, AUTOR_NOME]);

    const origemLimpa = criarOrigem(path.join(dir, 'a'));
    const soNoNome = exportar(origemLimpa, path.join(dir, 'destino-a'), { dataDir });
    assert.equal(soNoNome.codigo, 0, texto(soNoNome));

    const origemComNome = criarOrigem(path.join(dir, 'b'), { extra: { 'README.md': `feito por ${AUTOR_NOME}\n` } });
    const noArquivo = exportar(origemComNome, path.join(dir, 'destino-b'), { dataDir });
    assert.equal(noArquivo.codigo, 1, texto(noArquivo));
    assert.ok(texto(noArquivo).includes(`README.md:1 - termo privado: "${AUTOR_NOME}"`), texto(noArquivo));
  });
});

test('30.5: com core.autocrlf=true na origem, nenhum arquivo do destino tem \\r', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    git(origem, ['config', 'core.autocrlf', 'true']);
    // a cópia de trabalho em CRLF, como o checkout no Windows deixa; o índice continua LF
    for (const rel of git(origem, ['ls-files']).split('\n').filter(Boolean)) {
      const abs = path.join(origem, ...rel.split('/'));
      writeFileSync(abs, readFileSync(abs, 'utf8').replace(/\n/g, '\r\n'));
    }
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 0, texto(r));
    for (const rel of arquivosDoDestino(destino)) {
      const noDisco = readFileSync(path.join(destino, ...rel.split('/')));
      assert.ok(!noDisco.includes(0x0d), `${rel} no disco`);
      const noCommit = execFileSync('git', ['cat-file', 'blob', `HEAD:${rel}`], { cwd: destino });
      assert.ok(!noCommit.includes(0x0d), `${rel} no commit`);
    }
  });
});

test('o marcador .git/radar-publico existe no destino e não está no commit', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 0, texto(r));
    assert.ok(existsSync(path.join(destino, '.git', 'radar-publico')));
    assert.ok(!arquivosDoDestino(destino).some((f) => f.includes('radar-publico')));
  });
});

test('o destino não pode ficar dentro do repositório de origem', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, path.join(origem, 'saida'), { dataDir });

    assert.equal(r.codigo, 2, texto(r));
    assert.ok(!existsSync(path.join(origem, 'saida')));
  });
});

// ---------- o .privacy-allow da origem não libera nada no destino ----------

test('linha liberada no .privacy-allow da origem não libera e-mail nem caminho de usuário no destino', () => {
  const emailPessoal = ['joana.inventada', '@', 'gmail.com'].join('');
  const caminho = ['C:\\', 'Users\\', 'alguem\\projeto'].join('');
  for (const linha of [`contato: ${emailPessoal}`, `pasta: ${caminho}`, `responsável: ${TERMO}`]) {
    withTempDir((dir) => {
      const origem = criarOrigem(dir, {
        extra: { 'src/dado.mjs': `// ${linha}\n`, '.privacy-allow': `# exceções\n// ${linha}\n` },
      });
      const destino = path.join(dir, 'destino');
      const dataDir = dadosCom(dir, [TERMO]);

      const r = exportar(origem, destino, { dataDir });

      assert.equal(r.codigo, 1, `${linha}: ${texto(r)}`);
      assert.ok(texto(r).includes('src/dado.mjs:1 - '), texto(r));
      assert.equal(readFileSync(path.join(destino, '.privacy-allow'), 'utf8'), '# exceções\n');
    });
  }
});

test('o gate do destino ignora o .privacy-allow mesmo se uma exceção chegar lá', () => {
  withTempDir((dir) => {
    const emailPessoal = ['joana.inventada', '@', 'gmail.com'].join('');
    const linha = `// contato: ${emailPessoal}`;
    const origem = criarOrigem(dir, { extra: { 'src/dado.mjs': `${linha}\n` } });
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);
    // a outra camada (o .privacy-allow exportado vazio) falhando: a exceção chega ao destino
    const plantarExcecao = (dest) => writeFileSync(path.join(dest, '.privacy-allow'), `${linha}\n`);

    const r = exportar(origem, destino, { dataDir, antesDoCommit: plantarExcecao });

    assert.equal(r.codigo, 1, texto(r));
    assert.ok(texto(r).includes(`src/dado.mjs:1 - e-mail: "${emailPessoal}"`), texto(r));
  });
});

test('o .privacy-allow chega ao destino só com os comentários', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir, {
      extra: { '.privacy-allow': '# cabeçalho\n# segunda\n\nlinha liberada na origem\n' },
    });
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 0, texto(r));
    assert.equal(readFileSync(path.join(destino, '.privacy-allow'), 'utf8'), '# cabeçalho\n# segunda\n');
  });
});

// ---------- o nome do arquivo também é conferido ----------

test('termo da lista no nome de um arquivo exportado: sai 1 com o achado no caminho', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir, { extra: { [`src/${TERMO}.mjs`]: 'export const x = 1;\n' } });
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);

    const r = exportar(origem, destino, { dataDir });

    assert.equal(r.codigo, 1, texto(r));
    assert.ok(texto(r).includes(`src/${TERMO}.mjs (nome do arquivo) - termo privado: "${TERMO}"`), texto(r));
  });
});

test('termo da lista no nome de um arquivo que só existe no histórico do destino: sai 1', () => {
  withTempDir((dir) => {
    const origem = criarOrigem(dir);
    const destino = path.join(dir, 'destino');
    const dataDir = dadosCom(dir, [TERMO]);
    let plantado;
    const plantar = (dest) => {
      const envAutor = {
        ...process.env,
        GIT_AUTHOR_NAME: AUTOR_NOME,
        GIT_AUTHOR_EMAIL: AUTOR_EMAIL,
        GIT_COMMITTER_NAME: AUTOR_NOME,
        GIT_COMMITTER_EMAIL: AUTOR_EMAIL,
      };
      writeFileSync(path.join(dest, `${TERMO}.md`), 'conteúdo neutro\n');
      git(dest, ['add', '-A'], envAutor);
      git(dest, ['commit', '-q', '-m', 'anterior'], envAutor);
      plantado = git(dest, ['rev-parse', 'HEAD']).trim();
      git(dest, ['rm', '-q', `${TERMO}.md`], envAutor);
    };

    const r = exportar(origem, destino, { dataDir, antesDoCommit: plantar });

    assert.equal(r.codigo, 1, texto(r));
    assert.ok(
      texto(r).includes(`histórico ${plantado} ${TERMO}.md (nome do arquivo) - termo privado: "${TERMO}"`),
      texto(r),
    );
  });
});

// ---------- 30.6: checagem estática ----------

const CHAMA_GH = [
  /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*(['"`])gh(?:\.exe)?\1/,
  /\b(?:exec|execSync)\s*\(\s*(['"`])gh\s/,
];
const CHAMA_PUSH = [/(['"`])push\1/, /(['"`])git\s+(?:-C\s+\S+\s+)?push\b/];

/** Devolve as violações: arquivo que executa `gh` ou `git push`. */
function violacoes(arquivos) {
  const achadas = [];
  for (const [rel, conteudo] of arquivos) {
    if ([...CHAMA_GH, ...CHAMA_PUSH].some((re) => re.test(conteudo))) achadas.push(rel);
  }
  return achadas;
}

function arquivosDeCodigo(pasta) {
  const lista = [];
  const visitar = (abs, rel) => {
    for (const entrada of readdirSync(abs, { withFileTypes: true })) {
      const filhoAbs = path.join(abs, entrada.name);
      const filhoRel = `${rel}/${entrada.name}`;
      if (entrada.isDirectory()) visitar(filhoAbs, filhoRel);
      else if (/\.(?:m?js|cjs)$/.test(entrada.name)) lista.push([filhoRel, readFileSync(filhoAbs, 'utf8')]);
    }
  };
  visitar(path.join(RAIZ, pasta), pasta);
  return lista;
}

test('30.6: nenhum arquivo de src/, bin/ ou scripts/ executa gh nem git push', () => {
  const arquivos = ['src', 'bin', 'scripts'].flatMap(arquivosDeCodigo);
  assert.ok(arquivos.some(([rel]) => rel === 'scripts/exportar-publico.mjs'));
  assert.deepEqual(violacoes(arquivos), []);
});

test('30.6: a checagem estática reprova quem chama gh ou git push', () => {
  const casos = [
    "execFileSync('gh', ['repo', 'create'])",
    'spawn("gh", args)',
    "execSync('gh repo create x --public')",
    "execFileSync('git', ['push', 'origin', 'main'])",
    "execSync('git -C destino push')",
  ];
  for (const codigo of casos) assert.deepEqual(violacoes([['x.mjs', codigo]]), ['x.mjs'], codigo);
  assert.deepEqual(violacoes([['x.mjs', "console.log('gh repo create <nome> --push')"]]), []);
});
