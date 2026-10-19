// Testes da guarda de privacidade.
//
// Atenção: nenhuma amostra aqui pode conter, de forma contígua no código-fonte,
// um dado com cara de real (e-mail, telefone, CPF, CNPJ, caminho de usuário),
// senão a própria checagem de privacidade acusaria este arquivo ao rodar sobre
// o repositório. Por isso toda amostra "positiva" é montada por concatenação
// de pedaços, nunca escrita como um único literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanContent, readAllowList, readPrivateTerms, scanRepository } from '../scripts/check-privacy.mjs';

// Nada do git da máquina entra aqui: configuração global falsa, sem a do
// sistema, e e-mail inventado. A casa (HOME/USERPROFILE) também é falsa, para
// o script nunca ler o privado.txt real.
const AMBIENTE_FALSO = mkdtempSync(path.join(tmpdir(), 'radar-privacy-amb-'));
const CONFIG_GLOBAL_FALSA = path.join(AMBIENTE_FALSO, 'gitconfig');
const CASA_FALSA = path.join(AMBIENTE_FALSO, 'casa');
mkdirSync(CASA_FALSA);
writeFileSync(
  CONFIG_GLOBAL_FALSA,
  '[user]\n\tname = Pessoa Teste\n\temail = 1000+pessoa-teste@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n',
);
process.env.GIT_CONFIG_GLOBAL = CONFIG_GLOBAL_FALSA;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.on('exit', () => rmSync(AMBIENTE_FALSO, { recursive: true, force: true }));

const SCRIPT = fileURLToPath(new URL('../scripts/check-privacy.mjs', import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'radar-privacy-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Helpers de integração: criam um repositório git de verdade num diretório
// temporário para reproduzir cenários que só existem com índice do git
// (arquivo preparado para commit, nome de arquivo acentuado).
function runGit(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function initGitRepo(repoRoot) {
  runGit(repoRoot, ['init', '-q']);
}

test('acusa e-mail real e deixa passar domínio de exemplo e noreply', () => {
  const emailReal = ['fulano.exemplo', '@', 'gmail.com'].join('');
  const texto = [
    `contato: ${emailReal}`,
    'suporte: contato@example.com',
    'suporte: contato@exemplo.com',
    'robo: noreply@qualquercoisa.com',
  ].join('\n');

  const achados = scanContent(texto);
  const emails = achados.filter((a) => a.type === 'e-mail');

  assert.equal(emails.length, 1);
  assert.equal(emails[0].match, emailReal);
  assert.equal(emails[0].line, 1);
});

test('acusa telefone brasileiro formatado, com e sem +55', () => {
  const comParenteses = ['(11)', ' 9' + '1234', '-5678'].join('');
  const comMais55 = ['+55 11 9', '1234-5678'].join('');
  const texto = [`fone: ${comParenteses}`, `fone: ${comMais55}`, 'não é telefone: 42'].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'telefone');

  assert.equal(achados.length, 2);
});

test('acusa CPF formatado e numérico quando o dígito verificador é válido', () => {
  // Número de dígitos verificadores válidos, citado em documentação técnica
  // brasileira como exemplo didático de CPF; não pertence a ninguém.
  const cpfFormatado = ['111.444.777', '-35'].join('');
  const cpfPlano = ['111444777', '35'].join('');
  const cpfInvalido = ['123456789', '00'].join(''); // dígito verificador não bate

  const texto = [`cpf: ${cpfFormatado}`, `cpf: ${cpfPlano}`, `cpf: ${cpfInvalido}`].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'CPF');

  assert.equal(achados.length, 2);
  assert.ok(achados.some((a) => a.match === cpfFormatado));
  assert.ok(achados.some((a) => a.match === cpfPlano));
});

test('acusa CNPJ formatado e numérico quando o dígito verificador é válido', () => {
  // Número de dígitos verificadores válidos, usado como exemplo didático de
  // CNPJ; não pertence a nenhuma empresa real.
  const cnpjFormatado = ['11.222.333', '/0001-81'].join('');
  const cnpjPlano = ['11222333000', '181'].join('');
  const cnpjInvalido = ['1234567800', '0100'].join('');

  const texto = [`cnpj: ${cnpjFormatado}`, `cnpj: ${cnpjPlano}`, `cnpj: ${cnpjInvalido}`].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'CNPJ');

  assert.equal(achados.length, 2);
  assert.ok(achados.some((a) => a.match === cnpjFormatado));
  assert.ok(achados.some((a) => a.match === cnpjPlano));
});

test('acusa caminho de usuário real e deixa passar o placeholder com reticências', () => {
  const nomeFake = ['fula', 'no'].join('');
  const caminhoUnix = ['/Users/', nomeFake, '/projetos'].join('');
  const caminhoHome = ['/home/', nomeFake, '/projetos'].join('');
  const caminhoWindows = ['C:\\Users\\', nomeFake, '\\projetos'].join('');
  const texto = [
    caminhoUnix,
    caminhoHome,
    caminhoWindows,
    'exemplo genérico: /Users/.../projeto',
    'exemplo genérico: C:\\Users\\...\\projeto',
  ].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'caminho de usuário');

  assert.equal(achados.length, 3);
});

test('.privacy-allow suprime uma linha específica, mas não as outras', () => {
  const emailReal = ['pessoa.permitida', '@', 'gmail.com'].join('');
  const outroEmailReal = ['pessoa.nao.permitida', '@', 'gmail.com'].join('');
  const linhaPermitida = `copyright: ${emailReal}`;
  const texto = [linhaPermitida, `contato: ${outroEmailReal}`].join('\n');

  const achados = scanContent(texto, { allowList: [linhaPermitida] });

  assert.equal(achados.length, 1);
  assert.equal(achados[0].match, outroEmailReal);
});

test('readAllowList lê .privacy-allow do índice do git, ignorando comentário e linha em branco', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    const conteudo = ['# comentário', '', 'linha exata permitida', ''].join('\n');
    writeFileSync(path.join(dir, '.privacy-allow'), conteudo, 'utf8');
    runGit(dir, ['add', '.privacy-allow']);

    const lista = readAllowList(dir);

    assert.deepEqual(lista, ['linha exata permitida']);
  });
});

test('readAllowList retorna lista vazia quando .privacy-allow não está no índice', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    assert.deepEqual(readAllowList(dir), []);
  });
});

test('readAllowList ignora .privacy-allow que existe só em disco, fora do índice', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    // escreve no disco mas nunca dá `git add`: não deve contar como exceção.
    writeFileSync(path.join(dir, '.privacy-allow'), 'linha qualquer\n', 'utf8');

    assert.deepEqual(readAllowList(dir), []);
  });
});

test('readPrivateTerms lê termo de diretório temporário (nunca do home real)', () => {
  withTempDir((dir) => {
    const fakeHome = path.join(dir, 'home-fake');
    const privadoDir = path.join(fakeHome, '.radar-de-vagas');
    const nomeFake = ['Fulano', ' de Tal'].join('');
    mkdirSync(privadoDir, { recursive: true });
    writeFileSync(path.join(privadoDir, 'privado.txt'), `${nomeFake}\n`, 'utf8');

    const termos = readPrivateTerms(fakeHome);

    assert.deepEqual(termos, [nomeFake]);
  });
});

test('readPrivateTerms retorna lista vazia quando o arquivo não existe', () => {
  withTempDir((dir) => {
    assert.deepEqual(readPrivateTerms(path.join(dir, 'sem-nada')), []);
  });
});

test('termo da lista privada é encontrado pelo scanContent sem diferenciar maiúsculas', () => {
  const nomeFake = ['Fulano', ' de Tal'].join('');
  const texto = [`entrevista com ${nomeFake.toUpperCase()}`, 'linha neutra'].join('\n');

  const achados = scanContent(texto, { privateTerms: [nomeFake] });

  assert.equal(achados.length, 1);
  assert.equal(achados[0].type, 'termo privado');
  assert.equal(achados[0].line, 1);
});

test('acusa celular de 11 dígitos corridos com DDD válido, mas não 10 dígitos nem id com prefixo', () => {
  const celular = ['119', '87654321'].join(''); // DDD 11 + nono dígito 9 + 8 dígitos = 11 no total
  const dezDigitos = '4471436917'; // 10 dígitos: cara de id de vaga, não de telefone
  const idDeVaga = ['li-', dezDigitos].join('');
  const texto = [`fone: ${celular}`, `id: ${dezDigitos}`, `vaga: ${idDeVaga}`].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'telefone');

  assert.equal(achados.length, 1);
  assert.equal(achados[0].match, celular);
});

test('não acusa 11 dígitos corridos quando o DDD não existe ou o nono dígito não é 9', () => {
  const dddInexistente = ['209', '87654321'].join(''); // "20" não é DDD da Anatel
  const semNono = ['118', '87654321'].join(''); // terceiro dígito não é 9
  const texto = [`fone: ${dddInexistente}`, `fone: ${semNono}`].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'telefone');

  assert.equal(achados.length, 0);
});

test('acusa caminho do Windows com barra dupla (como em string JSON) e com barra normal', () => {
  const nomeFake = ['fula', 'no'].join('');
  const barraDupla = ['C:\\\\Users\\\\', nomeFake, '\\\\projeto'].join('');
  const barraNormal = ['C:/Users/', nomeFake, '/projeto'].join('');
  const texto = [barraDupla, barraNormal].join('\n');

  const achados = scanContent(texto).filter((a) => a.type === 'caminho de usuário');

  assert.equal(achados.length, 2);
});

test('índice do git é a fonte de verdade: arquivo sujo no índice mas limpo em disco ainda acusa', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    const relPath = 'arquivo.md';
    const absPath = path.join(dir, relPath);
    const emailSujo = ['sujo.no.indice', '@', 'gmail.com'].join('');

    writeFileSync(absPath, `contato: ${emailSujo}\n`, 'utf8');
    runGit(dir, ['add', relPath]);
    // sobrescreve o arquivo no disco sem dar `git add` de novo: o índice
    // continua com o conteúdo sujo, que é o que de fato iria pro commit.
    writeFileSync(absPath, 'conteudo limpo, sem dado pessoal\n', 'utf8');

    const { findings, errors } = scanRepository(dir);

    assert.deepEqual(errors, []);
    assert.ok(findings.some((f) => f.file === relPath && f.match === emailSujo));
  });
});

test('arquivo com nome acentuado e espaço no índice é escaneado, não ignorado em silêncio', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    const relPath = 'relatório da vaga.md';
    const emailReal = ['nome.acentuado', '@', 'gmail.com'].join('');

    writeFileSync(path.join(dir, relPath), `contato: ${emailReal}\n`, 'utf8');
    runGit(dir, ['add', relPath]);

    const { findings, errors } = scanRepository(dir);

    assert.deepEqual(errors, []);
    assert.ok(findings.some((f) => f.file === relPath && f.match === emailReal));
  });
});

test('scanRepository sai limpo (sem achados nem erros) quando o índice não tem dado pessoal', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    writeFileSync(path.join(dir, 'leia-me.md'), 'nada de pessoal aqui\n', 'utf8');
    runGit(dir, ['add', 'leia-me.md']);

    const { findings, errors } = scanRepository(dir);

    assert.deepEqual(findings, []);
    assert.deepEqual(errors, []);
  });
});

test('.privacy-allow só vale como está no índice: linha acrescentada só em disco não libera nada', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    const relPath = 'arquivo.md';
    const emailReal = ['bypass.so.no.disco', '@', 'gmail.com'].join('');
    const linha = `contato: ${emailReal}`;

    writeFileSync(path.join(dir, relPath), `${linha}\n`, 'utf8');
    runGit(dir, ['add', relPath]);

    // acrescenta a mesma linha ao .privacy-allow só no disco, sem `git add`
    // nele: não pode virar exceção, senão o commit levaria o e-mail sem
    // deixar rastro da exceção usada.
    writeFileSync(path.join(dir, '.privacy-allow'), `${linha}\n`, 'utf8');

    const { findings, errors } = scanRepository(dir);

    assert.deepEqual(errors, []);
    assert.ok(findings.some((f) => f.file === relPath && f.match === emailReal));
  });
});

test('.privacy-allow adicionado ao índice libera a linha exata', () => {
  withTempDir((dir) => {
    initGitRepo(dir);
    const relPath = 'arquivo.md';
    const emailReal = ['liberado.no.indice', '@', 'gmail.com'].join('');
    const linha = `contato: ${emailReal}`;

    writeFileSync(path.join(dir, relPath), `${linha}\n`, 'utf8');
    runGit(dir, ['add', relPath]);
    writeFileSync(path.join(dir, '.privacy-allow'), `${linha}\n`, 'utf8');
    runGit(dir, ['add', '.privacy-allow']);

    const { findings, errors } = scanRepository(dir);

    assert.deepEqual(errors, []);
    assert.ok(!findings.some((f) => f.file === relPath));
  });
});

// ---------- T29: lista privada da pasta de dados e varredura do histórico ----------

const NOREPLY_A = '1234+fulano@users.noreply.github.com';
const NOREPLY_B = '5678+beltrana@users.noreply.github.com';
// Termos da lista privada: nomes inventados, sem cara de dado real para a
// checagem genérica (por isso podem ser literais).
const TERMO_A = 'Fulano Inventado da Silva';
const TERMO_B = 'Empresa Ficticia Beta Ltda';

/** Pasta de dados com `privado.txt`; devolve o caminho. `termos` null = sem arquivo. */
function pastaDeDados(base, nome, termos) {
  const dir = path.join(base, nome);
  mkdirSync(dir, { recursive: true });
  if (termos !== null) writeFileSync(path.join(dir, 'privado.txt'), `${termos.join('\n')}\n`, 'utf8');
  return dir;
}

function ambienteDoGate({ dataDir, casa = CASA_FALSA } = {}) {
  const env = { ...process.env, HOME: casa, USERPROFILE: casa };
  delete env.RADAR_DATA_DIR;
  if (dataDir) env.RADAR_DATA_DIR = dataDir;
  return env;
}

function rodarGate(repo, args, opcoes) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    env: ambienteDoGate(opcoes),
    encoding: 'utf8',
  });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

function commitar(repo, mensagem, { autor = NOREPLY_A, committer = NOREPLY_A } = {}) {
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', mensagem], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pessoa Autora',
      GIT_AUTHOR_EMAIL: autor,
      GIT_COMMITTER_NAME: 'Pessoa Committer',
      GIT_COMMITTER_EMAIL: committer,
    },
  });
  return runGit(repo, ['rev-parse', 'HEAD']).trim();
}

function gravarEAdicionar(repo, relPath, conteudo) {
  const abs = path.join(repo, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, conteudo, 'utf8');
  runGit(repo, ['add', '--', relPath]);
}

/** Repo com o termo só num commit antigo: o HEAD não tem mais o termo. */
function repoComTermoSoNoHistorico(dir, relPath, termo) {
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  initGitRepo(repo);
  gravarEAdicionar(repo, relPath, `linha neutra\nresponsável: ${termo}\n`);
  const antigo = commitar(repo, 'primeiro');
  gravarEAdicionar(repo, relPath, 'linha neutra\n');
  commitar(repo, 'segundo');
  return { repo, antigo };
}

function linhasDeAchado(saida) {
  return saida.split('\n').filter((l) => / - [^:]+: "/.test(l));
}

test('29.1: termo só num commit antigo: a árvore dá 0 e o histórico dá 1, com o sha do commit e o caminho', () => {
  withTempDir((dir) => {
    const { repo, antigo } = repoComTermoSoNoHistorico(dir, 'docs/notas.md', TERMO_A);
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A]);

    const arvore = rodarGate(repo, [], { dataDir });
    assert.equal(arvore.codigo, 0, arvore.saida);
    assert.equal(linhasDeAchado(arvore.saida).length, 0);

    const historico = rodarGate(repo, ['--historico'], { dataDir });
    assert.equal(historico.codigo, 1, historico.saida);
    const achados = linhasDeAchado(historico.saida);
    assert.equal(achados.length, 1, historico.saida);
    assert.match(achados[0], new RegExp(`^histórico ${antigo} docs/notas\\.md:2 - termo privado: `));
  });
});

test('29.2: e-mail de autor ou de committer fora do noreply do GitHub vira achado, com o sha', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    const emailPessoal = ['fulano.pessoal', '@', 'gmail.com'].join('');
    const soAutor = commitar(repo, 'autor pessoal', { autor: emailPessoal, committer: NOREPLY_A });
    // o caso do `git commit --author` sozinho: autor neutro, committer pessoal
    const soCommitter = commitar(repo, 'committer pessoal', { autor: NOREPLY_A, committer: emailPessoal });
    commitar(repo, 'os dois neutros', { autor: NOREPLY_A, committer: NOREPLY_B });
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_B]);

    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 1, r.saida);
    const achados = linhasDeAchado(r.saida);
    assert.equal(achados.length, 2, r.saida);
    assert.ok(achados.includes(`commit ${soAutor} (autor) - e-mail de autor: "${emailPessoal}"`), r.saida);
    assert.ok(achados.includes(`commit ${soCommitter} (committer) - e-mail de committer: "${emailPessoal}"`), r.saida);
  });
});

test('29.2: autor e committer com o noreply do GitHub não dão achado', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    gravarEAdicionar(repo, 'leia-me.md', 'nada de pessoal\n');
    commitar(repo, 'limpo', { autor: NOREPLY_A, committer: NOREPLY_A });
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_B]);

    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 0, r.saida);
  });
});

test('29.3: a lista vem de RADAR_DATA_DIR, não da casa', () => {
  withTempDir((dir) => {
    const { repo } = repoComTermoSoNoHistorico(dir, 'notas.md', TERMO_A);
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A]);
    const casa = path.join(dir, 'casa');
    pastaDeDados(casa, '.radar-de-vagas', [TERMO_B]);

    const r = rodarGate(repo, ['--historico'], { dataDir, casa });

    assert.equal(r.codigo, 1, r.saida);
    assert.ok(r.saida.includes(`termo privado: "${TERMO_A}"`), r.saida);
  });
});

test('29.3: sem RADAR_DATA_DIR, a lista vem de ~/.radar-de-vagas', () => {
  withTempDir((dir) => {
    const { repo } = repoComTermoSoNoHistorico(dir, 'notas.md', TERMO_B);
    const casa = path.join(dir, 'casa');
    pastaDeDados(casa, '.radar-de-vagas', [TERMO_B]);

    const r = rodarGate(repo, ['--historico'], { casa });

    assert.equal(r.codigo, 1, r.saida);
    assert.ok(r.saida.includes(`termo privado: "${TERMO_B}"`), r.saida);
  });
});

test('29.4: --historico sem privado.txt sai 2, "lista privada ausente"', () => {
  withTempDir((dir) => {
    const { repo } = repoComTermoSoNoHistorico(dir, 'notas.md', TERMO_A);
    const dataDir = pastaDeDados(dir, 'dados', null);

    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 2, r.saida);
    assert.match(r.saida, /lista privada ausente/);
  });
});

test('29.4: --historico com privado.txt vazio também sai 2', () => {
  withTempDir((dir) => {
    const { repo } = repoComTermoSoNoHistorico(dir, 'notas.md', TERMO_A);
    const dataDir = pastaDeDados(dir, 'dados', ['', '   ']);

    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 2, r.saida);
    assert.match(r.saida, /lista privada ausente/);
  });
});

test('29.4: sem --historico e sem privado.txt, o comportamento de hoje (a CI pública)', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    gravarEAdicionar(repo, 'leia-me.md', 'nada de pessoal\n');
    const dataDir = pastaDeDados(dir, 'dados', null);

    const limpo = rodarGate(repo, [], { dataDir });
    assert.equal(limpo.codigo, 0, limpo.saida);

    const emailReal = ['sem.lista', '@', 'gmail.com'].join('');
    gravarEAdicionar(repo, 'contato.md', `contato: ${emailReal}\n`);
    const sujo = rodarGate(repo, [], { dataDir });
    assert.equal(sujo.codigo, 1, sujo.saida);
    assert.ok(sujo.saida.includes(`contato.md:1 - e-mail: "${emailReal}"`), sujo.saida);
  });
});

test('29.5: duas varreduras dão a mesma saída, e o achado mostra o termo escapado, nunca a linha', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    const vizinho = 'texto-vizinho-que-nao-pode-sair';
    gravarEAdicionar(repo, 'a.md', `${vizinho} ${TERMO_A} ${vizinho}\n`);
    gravarEAdicionar(repo, 'b.md', `${TERMO_B}\n`);
    commitar(repo, 'um');
    gravarEAdicionar(repo, 'a.md', 'limpo\n');
    gravarEAdicionar(repo, 'b.md', 'limpo\n');
    commitar(repo, `dois ${vizinho} ${TERMO_B}`);
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A, TERMO_B]);

    const primeira = rodarGate(repo, ['--historico'], { dataDir });
    const segunda = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(primeira.codigo, 1, primeira.saida);
    assert.equal(primeira.saida, segunda.saida);
    assert.equal(linhasDeAchado(primeira.saida).length, 3, primeira.saida);
    assert.ok(primeira.saida.includes(`termo privado: ${JSON.stringify(TERMO_A)}`), primeira.saida);
    assert.ok(!primeira.saida.includes(vizinho), primeira.saida);
  });
});

test('29.6: termo plantado num arquivo de teste num commit antigo reprova o histórico', () => {
  withTempDir((dir) => {
    const { repo, antigo } = repoComTermoSoNoHistorico(dir, 'test/amostra.test.mjs', TERMO_B);
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_B]);

    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 1, r.saida);
    assert.ok(r.saida.includes(`histórico ${antigo} test/amostra.test.mjs:2 - termo privado:`), r.saida);
  });
});

test('29.7: a lista privada não aceita exceção do .privacy-allow', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    const linha = `responsável: ${TERMO_A}`;
    gravarEAdicionar(repo, 'notas.md', `${linha}\n`);
    gravarEAdicionar(repo, '.privacy-allow', `${linha}\n`);
    commitar(repo, 'com exceção');
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A]);

    for (const args of [[], ['--historico']]) {
      const r = rodarGate(repo, args, { dataDir });
      assert.equal(r.codigo, 1, r.saida);
      assert.ok(r.saida.includes(`notas.md:1 - termo privado: "${TERMO_A}"`), r.saida);
    }
  });
});

test('29.7: o .privacy-allow continua valendo para a checagem genérica', () => {
  const emailReal = ['pessoa.permitida', '@', 'gmail.com'].join('');
  const linha = `copyright: ${emailReal}`;
  const achados = scanContent(linha, { allowList: [linha], privateTerms: [TERMO_A] });
  assert.deepEqual(achados, []);
});

test('caminho de usuário do Windows sem as barras (comidas por um escape) é acusado', () => {
  const comido = ['C:', 'Users', 'alguem'].join('');
  const achados = scanContent(`pasta: ${comido}\\projeto`).filter((a) => a.type === 'caminho de usuário');
  assert.equal(achados.length, 1);
  assert.deepEqual(scanContent('pasta: C:Users...').filter((a) => a.type === 'caminho de usuário'), []);
});

test('o nome do arquivo no índice é conferido contra a lista privada e os padrões', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    const emailNoNome = ['fulano.no.nome', '@', 'gmail.com'].join('');
    gravarEAdicionar(repo, `notas/${TERMO_A}.md`, 'neutro\n');
    gravarEAdicionar(repo, `${emailNoNome}.txt`, 'neutro\n');
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A]);

    const r = rodarGate(repo, [], { dataDir });

    assert.equal(r.codigo, 1, r.saida);
    assert.ok(r.saida.includes(`notas/${TERMO_A}.md (nome do arquivo) - termo privado: "${TERMO_A}"`), r.saida);
    assert.ok(r.saida.includes(`${emailNoNome}.txt (nome do arquivo) - e-mail: "${emailNoNome}`), r.saida);
  });
});

test('o nome de um arquivo apagado ou renomeado é conferido no histórico', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    gravarEAdicionar(repo, `${TERMO_B}.md`, 'neutro\n');
    const antigo = commitar(repo, 'um');
    runGit(repo, ['mv', `${TERMO_B}.md`, 'neutro.md']);
    commitar(repo, 'dois');
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_B]);

    assert.equal(rodarGate(repo, [], { dataDir }).codigo, 0);
    const r = rodarGate(repo, ['--historico'], { dataDir });

    assert.equal(r.codigo, 1, r.saida);
    assert.ok(r.saida.includes(`histórico ${antigo} ${TERMO_B}.md (nome do arquivo) - termo privado:`), r.saida);
  });
});

test('o noreply do GitHub não é acusado como e-mail pessoal na árvore', () => {
  const achados = scanContent(`autor: ${NOREPLY_A}`).filter((a) => a.type === 'e-mail');
  assert.deepEqual(achados, []);
});

test('--nome-autor só livra o nome do commit, nunca a mensagem', () => {
  withTempDir((dir) => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    initGitRepo(repo);
    gravarEAdicionar(repo, 'leia-me.md', 'nada de pessoal\n');
    execFileSync('git', ['commit', '-q', '-m', 'publicação'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: TERMO_A,
        GIT_AUTHOR_EMAIL: NOREPLY_A,
        GIT_COMMITTER_NAME: TERMO_A,
        GIT_COMMITTER_EMAIL: NOREPLY_A,
      },
    });
    const dataDir = pastaDeDados(dir, 'dados', [TERMO_A]);

    const semExcecao = rodarGate(repo, ['--historico'], { dataDir });
    assert.equal(semExcecao.codigo, 1, semExcecao.saida);
    assert.equal(linhasDeAchado(semExcecao.saida).length, 2, semExcecao.saida);

    const comExcecao = rodarGate(repo, ['--historico', '--nome-autor', TERMO_A], { dataDir });
    assert.equal(comExcecao.codigo, 0, comExcecao.saida);

    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', `obrigado, ${TERMO_A}`], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: TERMO_A,
        GIT_AUTHOR_EMAIL: NOREPLY_A,
        GIT_COMMITTER_NAME: TERMO_A,
        GIT_COMMITTER_EMAIL: NOREPLY_A,
      },
    });
    const naMensagem = rodarGate(repo, ['--historico', '--nome-autor', TERMO_A], { dataDir });
    assert.equal(naMensagem.codigo, 1, naMensagem.saida);
    assert.match(naMensagem.saida, /\(mensagem:1\) - termo privado:/);
  });
});
