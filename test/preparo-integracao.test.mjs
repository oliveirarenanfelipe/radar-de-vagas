import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { main } from '../bin/radar.mjs';
import { documentoDoRetrato, formaAscii, hashDoLote, LOTE_MUDOU, NAO_E_LOTE, textoDoLote } from '../src/preparo/aprovacao.mjs';
import { carregarBasesAprovadas, carregarFrasesAprovadas, hashRetrato, jsonCanonico } from '../src/preparo/contrato.mjs';
import { pastaSegura, retratoDaBase, situacaoDaBase } from '../src/preparo/pacote.mjs';
import { recordRound } from '../src/rounds.mjs';
import { addJobs, loadState, setMark, setTriage } from '../src/state.mjs';

const sha256 = dados => createHash('sha256').update(dados).digest('hex');

// Ponte e gate falsos (pessoa e empresas inventadas): leem o cenario.json da própria pasta, sem rede.
const PONTE = `import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = dirname(fileURLToPath(import.meta.url));
const cenario = JSON.parse(readFileSync(join(aqui, 'cenario.json'), 'utf8'));
const [operacao, a, b] = process.argv.slice(2);
const saida = valor => process.stdout.write(typeof valor === 'string' ? valor : JSON.stringify(valor));
if (operacao === 'variantes') {
  // T23: com cenario.gravarAmbiente, grava as chaves do próprio ambiente (o que a ponte herdou do processo).
  if (cenario.gravarAmbiente) writeFileSync(cenario.gravarAmbiente, JSON.stringify(Object.keys(process.env)));
  saida(cenario.variantes);
}
else if (operacao === 'fatos') {
  const fatos = cenario.fatos[cenario.baseDe[a]];
  if (!fatos) { process.stderr.write('variante inexistente'); process.exit(1); }
  saida(fatos);
} else if (operacao === 'gerar') {
  const pdf = join(b, cenario.nomePdf.replace('{v}', a));
  writeFileSync(pdf, '%PDF ficticio ' + a);
  saida({ versao: 1, pdf, declarado: cenario.declarados[a] });
} else if (operacao === 'gate') {
  process.stdout.write(cenario.gate.saida);
  process.exit(cenario.gate.codigo);
}
`;

const experienciaA = { cargo: 'Analista de Planejamento', empresa: 'Alfa Fictícia Ltda.', periodo: 'Mar/2023 – Mar/2026', local: 'Cidade Imaginária' };
const linhaA = 'Alfa Fictícia Ltda. | Mar/2023 – Mar/2026 | Cidade Imaginária';
function fatosBase() {
  return {
    'base-a': { versao: 1, base: 'base-a', experiencias: [experienciaA],
      formacao: [{ titulo: 'Bacharel em Engenharia Inventada', instituicao: 'Universidade Fictícia', periodo: '2010 – 2014' }],
      cursos: ['Curso Inventado de Planejamento'], idiomas: [{ idioma: 'Inglês', nivel: 'Fluente' }],
      textoLivre: [{ secao: 'perfil', texto: 'Planejo cenários fictícios.' },
        { secao: 'experiencia', texto: `Analista de Planejamento\n${linhaA}\nReduzi perdas em 14% na manutenção.\n99.5% availability.` }] },
    'base-b': { versao: 1, base: 'base-b',
      experiencias: [{ cargo: 'Planning Analyst', empresa: 'Alfa Fictícia Ltda.', periodo: 'Mar/2023 – Mar/2026', local: 'Imaginary City' }],
      formacao: [], cursos: [], idiomas: [{ idioma: 'English', nivel: 'Fluent' }],
      textoLivre: [{ secao: 'perfil', texto: 'I plan fictitious scenarios.' },
        { secao: 'experience', texto: 'Planning Analyst\nAlfa Fictícia Ltda. | Mar/2023 – Mar/2026 | Imaginary City' }] },
  };
}
const variantesBase = () => [
  { id: 'analista-plan', titulo: 'Analista de Planejamento', perfil: 'Planejo cenários fictícios.', habilidades: ['Planejamento'] },
  { id: 'analista-dados', titulo: 'Analista de Dados', perfil: 'Atuo com dados.', habilidades: ['SQL avançado', 'Painéis de indicadores'] },
  { id: 'analyst-en', titulo: 'Planning Analyst', perfil: 'I plan fictitious scenarios.', habilidades: ['Planning'] },
];

// Declarado como a ponte devolveria: experiência intacta da base e a seção integral com tudo do DOCX gerado.
function declaradoDe(variante, fatos) {
  const { textoLivre, base, ...estruturado } = fatos;
  return { ...structuredClone(estruturado), experiencias: fatos.experiencias.map(({ aliases, ...exp }) => exp), textoLivre: [
    { secao: 'titulo', texto: variante.titulo }, { secao: 'perfil', texto: variante.perfil },
    ...variante.habilidades.map(texto => ({ secao: 'habilidades', texto })),
    { secao: 'integral', texto: [variante.titulo, variante.perfil, ...variante.habilidades, ...textoLivre.map(item => item.texto)].join('\n') },
  ] };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'radar-preparo-integ-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'dados');
  await mkdir(dataDir);
  const ponte = join(root, 'ponte.mjs');
  await writeFile(ponte, PONTE);
  const cmd = args => ({ comando: process.execPath, args: [ponte, ...args] });
  const preparo = { variantes: cmd(['variantes']), fatos: cmd(['fatos', '{variante}']), gerarCv: cmd(['gerar', '{variante}', '{pasta}']),
    gateCv: cmd(['gate', '{pdf}']), termosHierarquia: ['Gerente Fictício', 'Líder Técnico'] };
  const busca = { termos: ['analista de planejamento'], localidade: null, modelo: null, idadeMaximaDias: null,
    fontes: { gupy: false, linkedin: false }, empresas: { greenhouse: [], lever: [], ashby: [], inhire: [] }, preparo };
  const env = { root, dataDir, preparo, busca, fetchCalls: 0 };
  env.cenario = { variantes: { versao: 1, variantes: variantesBase() }, fatos: fatosBase(),
    baseDe: { 'analista-plan': 'base-a', 'analista-dados': 'base-a', 'analyst-en': 'base-b' },
    nomePdf: 'CV Ana Ficticia - {v}.pdf', gate: { codigo: 0, saida: 'gate fictício: aprovado\n' } };
  env.salvar = async () => {
    const declarados = {};
    for (const variante of env.cenario.variantes.variantes ?? []) {
      declarados[variante.id] = env.cenario.declarados?.[variante.id] ?? declaradoDe(variante, env.cenario.fatos[env.cenario.baseDe[variante.id]]);
    }
    await writeFile(join(root, 'cenario.json'), JSON.stringify({ ...env.cenario, declarados }));
    await writeFile(join(dataDir, 'busca.json'), JSON.stringify(env.busca));
  };
  env.put = (nome, valor) => writeFile(join(dataDir, nome), typeof valor === 'string' ? valor : JSON.stringify(valor));
  env.ler = async nome => JSON.parse(await readFile(join(dataDir, nome), 'utf8'));
  env.bytes = nome => readFile(join(dataDir, nome)).catch(() => null);
  // Aprova bases por código, como o aprovar-base gravaria (nunca por ferramenta de edição).
  env.aprovarBases = async (bases = ['base-a', 'base-b'], complementos = []) => {
    const proibidas = (await env.bytes('afirmacoes-proibidas.json')) ?? Buffer.alloc(0);
    const doc = { versao: 1, bases: {} };
    for (const base of bases) {
      const retrato = retratoDaBase(env.cenario.fatos[base], { complementos, preparo: env.busca.preparo, proibidasSha256: sha256(proibidas) });
      doc.bases[base] = { aprovadaEm: '2026-10-01', hash: hashRetrato(retrato), retrato };
    }
    await env.put('bases-aprovadas.json', doc);
  };
  env.run = async (args, extra = {}) => {
    const out = [], err = [];
    const code = await main(args, { dataDir, stdout: texto => out.push(texto), stderr: texto => err.push(texto),
      fetch: async () => { env.fetchCalls++; throw new Error('Rede proibida.'); }, ambienteTelegram: {}, ...extra });
    return { code, out: out.join('\n'), err: err.join('\n'), tudo: [...out, ...err].join('\n') };
  };
  await env.salvar();
  return env;
}

const vaga = (extra = {}) => ({ source: 'solides', sourceId: 'sd700', url: 'https://vagas.solides.com.br/vaga/sd700',
  title: 'Analista de Planejamento', company: 'Beta Inventada', description: 'Planejar cenários fictícios.', publishedAt: '2026-10-10', ...extra });
async function comVaga(env, extra = {}) {
  const job = vaga(extra);
  await addJobs([job], { dataDir: env.dataDir });
  const id = `${job.source}:${job.sourceId}`;
  await setTriage(id, { fit: 4, reason: 'Encaixe fictício.', alerts: ['Conferir local.'] }, { dataDir: env.dataDir });
  return { id, pasta: pastaSegura(env.dataDir, id) };
}
const existe = caminho => stat(caminho).then(() => true, () => false);

test('17.1, 17.5 e 17.8 caminho feliz: pacote com o PDF no nome original, hash, ficha completa e 0 requisições de rede', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  const before = (await loadState({ dataDir: env.dataDir })).jobs[id];
  const r = await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'Mesmo título da vaga.']);
  assert.equal(r.code, 0, r.tudo);
  assert.match(r.out, /Requisições de rede: 0/);
  assert.equal(env.fetchCalls, 0);
  const pacote = JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8'));
  assert.equal(pacote.pdf, join(pasta, 'CV Ana Ficticia - analista-plan.pdf'));
  assert.equal(basename(pacote.pdf), 'CV Ana Ficticia - analista-plan.pdf');
  assert.equal(pacote.pdfSha256, sha256(await readFile(pacote.pdf)));
  assert.equal(pacote.requisicoesDeRede, 0);
  for (const arquivo of ['cv-declarado.json', 'veracidade.json', 'ficha.md', 'gate.txt']) assert.ok(await existe(join(pasta, arquivo)), arquivo);
  const ficha = await readFile(join(pasta, 'ficha.md'), 'utf8');
  for (const trecho of ['# Analista de Planejamento', 'Empresa: Beta Inventada', 'Fonte: solides', 'https://vagas.solides.com.br/vaga/sd700',
    '★★★★☆ (4 de 5) · Encaixe fictício. · alertas: Conferir local.', 'Variante do CV: analista-plan', 'Mesmo título da vaga.',
    'Lacunas', 'Veracidade: aprovada, 0 falhas', 'Gate do CV: aprovado']) assert.ok(ficha.includes(trecho), trecho);
  assert.deepEqual((await loadState({ dataDir: env.dataDir })).jobs[id].mark, before.mark);
});

test('17.5 o contador de rede do preparar conta de verdade: uma chamada durante a execução aparece no pacote', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  const original = globalThis.fetch;
  const execucao = env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  // Espera o preparar envolver o fetch (sob carga, um prazo fixo chega cedo demais) e chama no meio dele:
  // o preparar ainda leva centenas de ms nas chamadas à ponte depois disso.
  for (let espera = 0; globalThis.fetch === original && espera < 10000; espera += 5) await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(globalThis.fetch, original, 'o preparar não envolveu o fetch');
  await globalThis.fetch('https://rede.example/nao-deveria').catch(() => {});
  const r = await execucao;
  assert.equal(r.code, 0, r.tudo);
  assert.equal(env.fetchCalls, 1);
  assert.equal(JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8')).requisicoesDeRede, 1);
  assert.match(r.out, /Requisições de rede: 1/);
  assert.equal(globalThis.fetch, original);
});

test('17.5 checagem estática: nenhum arquivo de src/preparo importa network.mjs nem chama fetch', async () => {
  const pasta = new URL('../src/preparo/', import.meta.url);
  for (const nome of await readdir(pasta)) {
    const codigo = await readFile(new URL(nome, pasta), 'utf8');
    assert.doesNotMatch(codigo, /network\.mjs/, nome);
    assert.doesNotMatch(codigo, /\bfetch\s*\(/, nome);
  }
});

test('17.1 complemento juntado aos fatos: com ele o pacote sai; sem ele, reprova cursos', async t => {
  const env = await setup(t);
  env.cenario.variantes.variantes.push({ id: 'analista-cert', titulo: 'Analista de Planejamento', perfil: 'Tenho a certificação PMP.', habilidades: [] });
  env.cenario.baseDe['analista-cert'] = 'base-a';
  await env.salvar();
  const complemento = { tipo: 'curso', texto: 'Certificação PMP', fonte: { tipo: 'comprovante', referencia: 'Certificado fictício número 77', data: '2024-05-10' } };
  await env.put('fatos-complementares.json', [complemento]);
  await env.put('frases-aprovadas.json', { versao: 1, frases: [{ texto: 'Tenho a certificação PMP.', aprovadaEm: '2026-10-01', origem: 'variante analista-cert, perfil' }] });
  await env.aprovarBases(['base-a', 'base-b'], [complemento]);
  const { id, pasta } = await comVaga(env);
  const com = await env.run(['preparar', id, '--variante', 'analista-cert', '--porque', 'Certificação pedida.']);
  assert.equal(com.code, 0, com.tudo);
  assert.ok(await existe(join(pasta, 'pacote.json')));
  await env.put('fatos-complementares.json', []);
  await env.aprovarBases(['base-a', 'base-b'], []);
  const sem = await env.run(['preparar', id, '--variante', 'analista-cert', '--porque', 'Certificação pedida.']);
  assert.notEqual(sem.code, 0);
  assert.match(sem.tudo, /cursos/);
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
});

test('17.2 cargo promovido: código ≠ 0 com o trecho, veracidade.json com a falha e sem pacote (o antigo sai antes)', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  await mkdir(pasta, { recursive: true });
  await writeFile(join(pasta, 'pacote.json'), '{"antigo":true}');
  const declarado = declaradoDe(variantesBase()[0], fatosBase()['base-a']);
  declarado.experiencias[0].cargo = 'Gerente de Planejamento';
  env.cenario.declarados = { 'analista-plan': declarado };
  await env.salvar();
  const r = await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  assert.notEqual(r.code, 0);
  assert.match(r.tudo, /cargo \(experiencias\): "Gerente de Planejamento \| Alfa Fictícia Ltda\. \| Mar\/2023 – Mar\/2026/);
  const veracidade = JSON.parse(await readFile(join(pasta, 'veracidade.json'), 'utf8'));
  assert.equal(veracidade.aprovado, false);
  assert.ok(veracidade.falhas.some(falha => falha.checagem === 'cargo'));
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
});

test('17.3 gate que sai 1: sem pacote, saída do gate em gate.txt', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  env.cenario.gate = { codigo: 1, saida: 'gate fictício: credencial ausente no CV\n' };
  await env.salvar();
  const { id, pasta } = await comVaga(env);
  const r = await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  assert.notEqual(r.code, 0);
  assert.match(r.tudo, /gate reprovou/);
  assert.match(await readFile(join(pasta, 'gate.txt'), 'utf8'), /credencial ausente no CV/);
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
});

test('17.4 vaga da Gupy: texto ausente, acima do teto, válido na ficha, e frase nova no texto vira pendente', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env, { source: 'gupy', sourceId: 'gp-700', url: 'https://alfa.gupy.io/jobs/700' });
  const preparar = () => env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  const ausente = await preparar();
  assert.notEqual(ausente.code, 0);
  assert.match(ausente.tudo, /texto da Gupy ausente/);
  await writeFile(join(pasta, 'texto-gupy.txt'), 'a'.repeat(1501));
  const longo = await preparar();
  assert.notEqual(longo.code, 0);
  assert.match(longo.tudo, /1501 caracteres \(teto 1500\)/);
  await writeFile(join(pasta, 'texto-gupy.txt'), 'Tenho interesse na vaga fictícia.');
  const valido = await preparar();
  assert.equal(valido.code, 0, valido.tudo);
  assert.match(await readFile(join(pasta, 'ficha.md'), 'utf8'), /Texto da Gupy: 33 caracteres \(teto 1500\)/);
  const declarado = JSON.parse(await readFile(join(pasta, 'cv-declarado.json'), 'utf8'));
  assert.ok(declarado.textoLivre.some(item => item.secao === 'gupy'));
  await writeFile(join(pasta, 'texto-gupy.txt'), 'Liderei 12 projetos fictícios.');
  const nova = await preparar();
  assert.notEqual(nova.code, 0);
  assert.match(nova.tudo, /frase-nova \(gupy\): "Liderei 12 projetos fictícios\."/);
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
  const pendentes = JSON.parse(await readFile(join(env.dataDir, 'candidaturas', 'frases-pendentes.json'), 'utf8'));
  assert.deepEqual(pendentes.frases.map(item => [item.frase, item.secao, item.origem]), [['Liderei 12 projetos fictícios.', 'gupy', `vaga ${id}, gupy`]]);
});

test('17.6 pasta segura: id com "/", ":" e ".." fica dentro de candidaturas, só com [a-z0-9-] e sufixo de hash', () => {
  const raiz = join(tmpdir(), 'radar-pasta-segura');
  for (const id of ['gupy:../../fora', 'inhire:empresa/vaga:1', 'LinkedIn:ABC']) {
    const pasta = pastaSegura(raiz, id);
    assert.equal(dirname(pasta), join(raiz, 'candidaturas'), id);
    assert.match(basename(pasta), /^[a-z0-9-]+-[0-9a-f]{8}$/, id);
  }
  assert.notEqual(pastaSegura(raiz, 'a:b'), pastaSegura(raiz, 'a/b'));
});

test('17.7 busca sem preparo: código 2 e a mensagem manda usar a skill curriculo-por-vaga', async t => {
  const env = await setup(t);
  const { preparo, ...semPreparo } = env.busca;
  env.busca = semPreparo;
  await env.salvar();
  const { id } = await comVaga(env);
  for (const args of [['preparar', id], ['verificar-variantes']]) {
    const r = await env.run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.tudo, /curriculo-por-vaga/);
  }
});

test('17.9 contar-gupy imprime a contagem e reprova acima de 1.500', async t => {
  const env = await setup(t);
  await writeFile(join(env.root, 'ok.txt'), 'a'.repeat(1500));
  await writeFile(join(env.root, 'longo.txt'), 'a'.repeat(1501));
  const ok = await env.run(['contar-gupy', join(env.root, 'ok.txt')]);
  assert.deepEqual([ok.code, ok.out], [0, '1500 caracteres (teto 1500)']);
  const longo = await env.run(['contar-gupy', join(env.root, 'longo.txt')]);
  assert.deepEqual([longo.code, longo.out], [1, '1501 caracteres (teto 1500): REPROVADO']);
});

test('17.10 selecionar: 5 em JSON; restrição impossível sai 1; --rodadas 2 amplia a janela', async t => {
  const env = await setup(t);
  const dataDir = env.dataDir;
  const job = (fonte, n) => vaga({ source: fonte, sourceId: `${fonte}-${n}`, url: `https://alfa.example/${fonte}/${n}`, title: `Vaga fictícia ${n}`, publishedAt: `2026-10-0${n}` });
  const rodada = async jobs => {
    const inicio = new Date().toISOString();
    await addJobs(jobs, { dataDir });
    for (const item of jobs) await setTriage(`${item.source}:${item.sourceId}`, { fit: 3, reason: 'Fictício.', alerts: [] }, { dataDir });
    await recordRound({ inicio, fim: new Date().toISOString(), interrompida: false, porFonte: {}, totalNovas: jobs.length }, { dataDir });
  };
  await rodada([job('gupy', 1)]);
  await rodada([1, 2, 3, 4, 5].map(n => job('solides', n)));
  const dia = await env.run(['selecionar']);
  assert.equal(dia.code, 1);
  assert.match(dia.err, /gupy/);
  const duas = await env.run(['selecionar', '--rodadas', '2']);
  assert.equal(duas.code, 0, duas.tudo);
  const resultado = JSON.parse(duas.out);
  assert.equal(resultado.selecionadas.length, 5);
  assert.ok(resultado.selecionadas.some(item => item.fonte === 'gupy'));
  assert.deepEqual(Object.keys(resultado.selecionadas[0]), ['id', 'titulo', 'empresa', 'fonte', 'estrelas', 'link']);
  await setMark('gupy:gupy-1', { status: 'applied', cutReason: null }, { dataDir });
  assert.equal((await env.run(['selecionar', '--rodadas', '2'])).code, 1);
});

test('17.11 verificar-variantes: seção certa, arquivos de bloqueio e pendência, frase só vale na base da variante', async t => {
  const env = await setup(t);
  env.cenario.variantes.variantes[1].habilidades = ['SQL avançado', 'Liderei 4 squads'];
  env.cenario.variantes.variantes.push({ id: 'analyst-sla', titulo: 'Planning Analyst', perfil: '99.5% availability.', habilidades: [] },
    { id: 'analista-sla', titulo: 'Analista de Planejamento', perfil: '99.5% availability.', habilidades: [] });
  Object.assign(env.cenario.baseDe, { 'analyst-sla': 'base-b', 'analista-sla': 'base-a' });
  await env.salvar();
  await env.aprovarBases();
  await env.put('frases-aprovadas.json', { versao: 1, frases: [] });
  const antes = [await env.bytes('frases-aprovadas.json'), await env.bytes('bases-aprovadas.json')];
  const r = await env.run(['verificar-variantes']);
  assert.equal(r.code, 1, r.tudo);
  const bloqueadas = await env.ler('candidaturas/variantes-bloqueadas.json');
  assert.equal(bloqueadas.versao, 1);
  assert.match(bloqueadas.hashFatos, /^[0-9a-f]{64}$/);
  assert.deepEqual(bloqueadas.bloqueadas.map(item => item.variante).sort(), ['analista-dados', 'analyst-sla']);
  const dados = bloqueadas.bloqueadas.find(item => item.variante === 'analista-dados');
  assert.deepEqual(dados.falhas.map(falha => [falha.checagem, falha.secao, falha.trecho]), [['frase-nova', 'habilidades', 'Liderei 4 squads']]);
  const pendentes = await env.ler('candidaturas/frases-pendentes.json');
  assert.ok(pendentes.frases.some(item => item.frase === 'Liderei 4 squads' && item.secao === 'habilidades' && item.origem === 'variante analista-dados, habilidades'));
  assert.deepEqual([await env.bytes('frases-aprovadas.json'), await env.bytes('bases-aprovadas.json')], antes);
  const { id } = await comVaga(env, { title: 'Analista de Dados' });
  const pedida = await env.run(['preparar', id, '--variante', 'analista-dados', '--porque', 'x']);
  assert.notEqual(pedida.code, 0);
  assert.match(pedida.tudo, /variante bloqueada na veracidade: frase-nova/);
  // Sem --variante, a escolha automática pula a bloqueada (a de "Analista de Dados" seria a primeira).
  const auto = await env.run(['preparar', id]);
  assert.equal(auto.code, 0, auto.tudo);
  assert.notEqual((await env.ler(`candidaturas/${basename(pastaSegura(env.dataDir, id))}/pacote.json`)).variante, 'analista-dados');
  // Sem o arquivo de bloqueadas, o preparar verifica a variante escolhida antes de gerar.
  await rm(join(env.dataDir, 'candidaturas', 'variantes-bloqueadas.json'));
  const semArquivo = await env.run(['preparar', id, '--variante', 'analista-dados', '--porque', 'x']);
  assert.match(semArquivo.tudo, /variante bloqueada na veracidade: frase-nova/);
});

test('17.12 integral com frase plantada, declarado sem texto, divergente da variante, e variante sem texto', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  const preparar = () => env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  const base = () => declaradoDe(variantesBase()[0], fatosBase()['base-a']);
  const plantado = base();
  plantado.textoLivre.find(item => item.secao === 'integral').texto += '\n+73% de produtividade';
  env.cenario.declarados = { 'analista-plan': plantado };
  await env.salvar();
  const r1 = await preparar();
  assert.notEqual(r1.code, 0);
  assert.match(r1.tudo, /frase-nova \(integral\): "\+73% de produtividade"/);
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
  for (const textoLivre of [[], base().textoLivre.filter(item => item.secao !== 'perfil')]) {
    env.cenario.declarados = { 'analista-plan': { ...base(), textoLivre } };
    await env.salvar();
    const r = await preparar();
    assert.notEqual(r.code, 0);
    assert.match(r.tudo, /declarado sem título\/perfil/);
  }
  for (const [secao, mudar] of [['titulo', d => { d.textoLivre[0].texto = 'Outro Título'; }], ['perfil', d => { d.textoLivre[1].texto = 'Outro perfil.'; }],
    ['habilidades', d => { d.textoLivre[2].texto = 'Outra habilidade'; }]]) {
    const declarado = base();
    mudar(declarado);
    env.cenario.declarados = { 'analista-plan': declarado };
    await env.salvar();
    const r = await preparar();
    assert.notEqual(r.code, 0);
    assert.match(r.tudo, new RegExp(`declarado diverge da variante na seção ${secao}`));
  }
  env.cenario.declarados = undefined;
  env.cenario.variantes.variantes[0].titulo = '';
  await env.salvar();
  for (const args of [['preparar', id, '--variante', 'analista-plan', '--porque', 'x'], ['verificar-variantes']]) {
    const r = await env.run(args);
    assert.notEqual(r.code, 0);
    assert.match(r.tudo, /variante sem texto/);
  }
});

const io = (resposta, telas = []) => ({ isTTY: true, perguntar: async () => resposta, escrever: texto => telas.push(texto) });
const pendente = (id, frase, extra = {}) => ({ id, frase, secao: 'perfil', origem: 'variante analista-plan, perfil', ...extra });

test('17.13 aprovar-frase: só no terminal, com "aprovo"; recusa caractere de controle; mostra a forma escapada', async t => {
  const env = await setup(t);
  await mkdir(join(env.dataDir, 'candidaturas'));
  const caminhoPendentes = 'candidaturas/frases-pendentes.json';
  await env.put(caminhoPendentes, { versao: 1, frases: [pendente('a1', 'Reduzi custos em 12%'),
    pendente('a2', 'Reduzi custos em 12%\u001b[8m e fui diretor'), pendente('a3', 'Reduzi custos em 12% ‮roterid iuf e'),
    pendente('a4', 'Reduzi\tcustos em 12%'), pendente('a5', 'Organizei 3 operações – ação de campo'),
    pendente('a6', 'Reduzi custos em 12% e fui diretor'), pendente('a7', 'Reduzi custos em 12% e fui diretor')] });
  const semTerminal = await env.run(['aprovar-frase', 'a1'], { io: { isTTY: false, perguntar: async () => 'aprovo' } });
  assert.equal(semTerminal.code, 2);
  assert.match(semTerminal.tudo, /aprovação só pela pessoa, no terminal/);
  assert.equal(await env.bytes('frases-aprovadas.json'), null);
  assert.equal((await env.run(['aprovar-frase', 'zz'], { io: io('aprovo') })).code, 2);
  assert.equal((await env.run(['aprovar-frase', 'a1'], { io: io('não') })).code, 1);
  assert.equal(await env.bytes('frases-aprovadas.json'), null);
  for (const [id, ponto] of [['a2', 'U\\+001B'], ['a3', 'U\\+202E'], ['a4', 'U\\+0009'], ['a6', 'U\\+2028'], ['a7', 'U\\+2029']]) {
    const r = await env.run(['aprovar-frase', id], { io: io('aprovo') });
    assert.equal(r.code, 2, id);
    assert.match(r.tudo, new RegExp(`texto com caractere de controle ${ponto}`), id);
    assert.equal(await env.bytes('frases-aprovadas.json'), null, id);
  }
  const telas = [];
  assert.equal((await env.run(['aprovar-frase', 'a5'], { io: io('aprovo', telas) })).code, 0);
  assert.ok(telas.includes('Frase: Organizei 3 operações – ação de campo'));
  assert.ok(telas.includes('Forma escapada: "Organizei 3 operações – ação de campo"'));
  const aprovadas = await env.ler('frases-aprovadas.json');
  assert.deepEqual(aprovadas.frases.map(item => [item.texto, item.origem]), [['Organizei 3 operações – ação de campo', 'variante analista-plan, perfil']]);
  assert.match(aprovadas.frases[0].aprovadaEm, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!(await env.ler(caminhoPendentes)).frases.some(item => item.id === 'a5'));
  // A forma escapada mostra U+202E, que JSON.stringify sozinho deixaria invisível.
  const { formaEscapada } = await import('../src/preparo/aprovacao.mjs');
  assert.equal(formaEscapada('a‮b c'), '"a\\u202Eb c"');
});

test('17.13 checagem estática: só aprovacao.mjs grava os arquivos de aprovação', async () => {
  const raiz = new URL('../src/', import.meta.url);
  const arquivos = async pasta => (await readdir(pasta, { withFileTypes: true })).flatMap(item =>
    item.isDirectory() ? [] : [new URL(item.name, pasta)]);
  const todos = [...await arquivos(raiz), ...await arquivos(new URL('preparo/', raiz)), ...await arquivos(new URL('page/', raiz)), ...await arquivos(new URL('sources/', raiz))];
  const grava = /(gravarJson|gravarArquivo|writeFile|rename)\([^\n]*(frases|bases)-aprovadas\.json/;
  const gravam = [];
  for (const arquivo of todos) if (grava.test(await readFile(arquivo, 'utf8'))) gravam.push(basename(arquivo.pathname));
  assert.deepEqual(gravam, ['aprovacao.mjs']);
});

test('17.14 base: primeira vez, frase alterada, cargo, alias, complemento, preparo, proibidas e controle', async t => {
  const env = await setup(t);
  const verificar = () => env.run(['verificar-variantes']);
  const pendentesBases = async () => (await env.ler('candidaturas/bases-pendentes.json')).bases;
  const bloqueio = async variante => (await env.ler('candidaturas/variantes-bloqueadas.json')).bloqueadas.find(item => item.variante === variante)?.falhas[0];
  const { id } = await comVaga(env);
  const preparar = () => env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);

  // Primeira vez: retrato inteiro para leitura e toda variante da base bloqueada.
  const primeira = await verificar();
  assert.equal(primeira.code, 1);
  assert.equal((await pendentesBases())['base-a'].primeiraVez, true);
  assert.ok((await pendentesBases())['base-a'].acrescentados.includes('frase: reduzi perdas em 14% na manutencao'));
  assert.match((await bloqueio('analista-plan')).esperado, /base sem aprovação/);
  assert.match((await preparar()).tudo, /base sem aprovação/);

  // Aprovada pelo comando, no terminal: nada pendente.
  for (const base of ['base-a', 'base-b']) assert.equal((await env.run(['aprovar-base', base], { io: io('aprovo') })).code, 0);
  assert.equal((await env.run(['aprovar-base', 'base-a'], { io: { isTTY: false, perguntar: async () => 'aprovo' } })).code, 2);
  assert.equal((await verificar()).code, 0);
  assert.deepEqual(await pendentesBases(), {});

  const mudar = async (fn, esperado) => {
    const original = structuredClone(env.cenario.fatos);
    fn(env.cenario.fatos['base-a']);
    await env.salvar();
    assert.equal((await verificar()).code, 1);
    const pend = (await pendentesBases())['base-a'];
    for (const [lado, item] of esperado) assert.ok(pend[lado].includes(item), `${lado}: ${item} em ${JSON.stringify(pend)}`);
    assert.match((await bloqueio('analista-plan')).esperado, /base alterada sem aprovação/);
    const r = await preparar();
    assert.notEqual(r.code, 0);
    assert.match(r.tudo, /base alterada sem aprovação/);
    env.cenario.fatos = original;
    await env.salvar();
  };
  await mudar(base => { base.textoLivre[1].texto = base.textoLivre[1].texto.replace('14%', '41%'); },
    [['removidos', 'frase: reduzi perdas em 14% na manutencao'], ['acrescentados', 'frase: reduzi perdas em 41% na manutencao']]);
  await mudar(base => { base.experiencias[0].cargo = 'Analista Sênior de Planejamento'; },
    [['acrescentados', 'experiência: analista senior de planejamento | alfa ficticia | 2023-03 – 2026-03 | cidade imaginaria']]);
  await mudar(base => { base.experiencias[0].aliases = ['Alfa']; }, [['acrescentados', 'alias: alfa (de alfa ficticia)']]);
  assert.equal((await verificar()).code, 0);

  // Complemento novo: as duas bases pedem nova aprovação; depois de aprovar as duas, nada pendente.
  const complemento = { tipo: 'curso', texto: 'Certificação Inventada Y', fonte: { tipo: 'comprovante', referencia: 'Certificado fictício Y', data: '2024-01-02' } };
  await env.put('fatos-complementares.json', [complemento]);
  assert.equal((await verificar()).code, 1);
  assert.deepEqual(Object.keys(await pendentesBases()).sort(), ['base-a', 'base-b']);
  assert.ok((await pendentesBases())['base-b'].acrescentados.some(item => item.startsWith('complemento: ') && item.includes('Certificação Inventada Y')));
  assert.notEqual((await preparar()).code, 0);
  for (const base of ['base-a', 'base-b']) assert.equal((await env.run(['aprovar-base', base], { io: io('aprovo') })).code, 0);
  assert.equal((await verificar()).code, 0);

  // preparo: um termo a menos pede aprovação; as mesmas chaves noutra ordem, não.
  const preparoAprovado = structuredClone(env.busca.preparo);
  env.busca.preparo = { ...preparoAprovado, termosHierarquia: ['Gerente Fictício'] };
  await env.salvar();
  assert.equal((await verificar()).code, 1);
  assert.match((await bloqueio('analyst-en')).esperado, /configuração do preparo mudou/);
  assert.notEqual((await preparar()).code, 0);
  env.busca.preparo = Object.fromEntries(Object.entries(preparoAprovado).reverse());
  await env.salvar();
  assert.equal((await verificar()).code, 0);

  // Lista de proibidas com um padrão a menos.
  await env.put('afirmacoes-proibidas.json', [{ id: 'p1', padrao: 'frase vetada inventada', descricao: '' }, { id: 'p2', padrao: 'outra vetada', descricao: '' }]);
  for (const base of ['base-a', 'base-b']) await env.run(['aprovar-base', base], { io: io('aprovo') });
  await env.put('afirmacoes-proibidas.json', [{ id: 'p1', padrao: 'frase vetada inventada', descricao: '' }]);
  assert.equal((await verificar()).code, 1);
  assert.match((await bloqueio('analista-plan')).esperado, /lista de afirmações proibidas mudou/);
  assert.notEqual((await preparar()).code, 0);

  // Retrato com U+202E: aprovar-base sai 2, com o ponto de código e o texto escapado; nada gravado.
  env.cenario.fatos['base-a'].textoLivre.push({ secao: 'extra', texto: 'Texto ‮oculto em 12 obras.' });
  await env.salvar();
  const antes = await env.bytes('bases-aprovadas.json');
  const r = await env.run(['aprovar-base', 'base-a'], { io: io('aprovo') });
  assert.equal(r.code, 2);
  assert.match(r.tudo, /base "base-a": texto com caractere de controle U\+202E: .*\\u202E/);
  assert.deepEqual(await env.bytes('bases-aprovadas.json'), antes);
});

test('17.14 base sem aprovação: o texto da variante é conferido na mesma passada e a frase nova já fica pendente', async t => {
  const env = await setup(t);
  env.cenario.variantes.variantes[1].habilidades = ['SQL avançado', 'Liderei 4 squads'];
  await env.salvar();
  const r = await env.run(['verificar-variantes']);
  assert.equal(r.code, 1);
  const bloqueada = (await env.ler('candidaturas/variantes-bloqueadas.json')).bloqueadas.find(item => item.variante === 'analista-dados');
  assert.deepEqual(bloqueada.falhas.map(falha => falha.checagem), ['base', 'frase-nova']);
  assert.match(bloqueada.falhas[0].esperado, /base sem aprovação/);
  const pendentes = await env.ler('candidaturas/frases-pendentes.json');
  assert.ok(pendentes.frases.some(item => item.frase === 'Liderei 4 squads' && item.origem === 'variante analista-dados, habilidades'));
  // Variante sem frase nova continua bloqueada só pela base.
  const plan = (await env.ler('candidaturas/variantes-bloqueadas.json')).bloqueadas.find(item => item.variante === 'analista-plan');
  assert.deepEqual(plan.falhas.map(falha => falha.checagem), ['base']);
});

test('17.15 declarado sem integral e integral com frase da experiência alterada', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  const preparar = () => env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x']);
  const semIntegral = declaradoDe(variantesBase()[0], fatosBase()['base-a']);
  semIntegral.textoLivre = semIntegral.textoLivre.filter(item => item.secao !== 'integral');
  env.cenario.declarados = { 'analista-plan': semIntegral };
  await env.salvar();
  const r1 = await preparar();
  assert.notEqual(r1.code, 0);
  assert.match(r1.tudo, /declarado sem texto integral/);
  const alterado = declaradoDe(variantesBase()[0], fatosBase()['base-a']);
  const integral = alterado.textoLivre.find(item => item.secao === 'integral');
  integral.texto = integral.texto.replace('Reduzi perdas em 14%', 'Reduzi perdas em 40%');
  env.cenario.declarados = { 'analista-plan': alterado };
  await env.salvar();
  const r2 = await preparar();
  assert.notEqual(r2.code, 0);
  assert.match(r2.tudo, /frase-nova \(integral\): "Reduzi perdas em 40% na manutenção\."/);
  assert.equal(await existe(join(pasta, 'pacote.json')), false);
});

test('17.16 conferir-pacote: confere o hash; PDF trocado, pacote antigo, fora da pasta ou ausente nunca é "conferido"', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  assert.equal((await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x'])).code, 0);
  const pacote = JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8'));
  const ok = await env.run(['conferir-pacote', id]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, new RegExp(`PDF conferido: ${pacote.pdf.replace(/[\\.()]/g, '\\$&')}`));
  const conferir = () => env.run(['conferir-pacote', id]);
  await writeFile(pacote.pdf, `${await readFile(pacote.pdf, 'utf8')} `);
  const trocado = await conferir();
  assert.equal(trocado.code, 1);
  assert.match(trocado.tudo, /PDF mudou depois do preparo: refaça o `?preparar/);
  for (const mudado of [{ ...pacote, pdfSha256: undefined }, { ...pacote, pdf: undefined },
    { ...pacote, pdf: join(env.root, 'fora.pdf') }, { ...pacote, pdf: join(pasta, 'sumiu.pdf') }]) {
    await writeFile(join(pasta, 'pacote.json'), JSON.stringify(mudado));
    const r = await conferir();
    assert.equal(r.code, 1, JSON.stringify(mudado));
    assert.doesNotMatch(r.tudo, /PDF conferido/);
  }
});

// T22 pela linha de comando: painel-entrada, painel-gravar e o painel no conferir-pacote (22.1, 22.6, 22.7, 22.8).
const CREDITO_PAINEL = 'Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media';
function painelDoTeste({ id, pdfSha256, entrada }) {
  const leitor = (veredito, trecho) => `Veredito: ${veredito}\n- Trecho: "${trecho}" · Motivo: Motivo fictício.`;
  return ['# Painel de revisão', `vaga: ${id}`, `pdfSha256: ${pdfSha256}`, `entradaSha256: ${sha256(Buffer.from(entrada, 'utf8'))}`, '',
    '## Triagem automática', 'Veredito: PASSA', '- Trecho: "Reduzi perdas em 14% na manutenção." · Motivo: Sem o valor em reais.',
    'Termos da vaga ausentes: nenhum', '',
    '## Gestor', 'Veredito: ENTREVISTA', 'Decidiu nos primeiros dez segundos: O título igual ao da vaga.',
    'Perguntaria na entrevista: Como mediu as perdas?', '',
    '## Leitores isolados', '### Gestor', leitor('CONTRATA', 'Analista de Planejamento'),
    '### Concorrente', leitor('TALVEZ', 'Planejo cenários fictícios.'), '### CEO', leitor('DESCARTA', 'Reduzi perdas em 14% na manutenção.'),
    '### Recrutadora (30 s)', leitor('TALVEZ', 'Analista de Planejamento'), '### Colega', leitor('CONTRATA', 'Planejo cenários fictícios.'), '',
    '## Erros, do pior para o melhor', '1. Trecho: "Planejo cenários fictícios." · Por que reprova: Genérico. · Quem apontou: concorrente, colega', '',
    '## Fatos que faltam', '- Quanto valiam as perdas por ano?', '', CREDITO_PAINEL, ''].join('\n');
}

async function comPacote(t) {
  const env = await setup(t);
  await env.aprovarBases();
  const { id, pasta } = await comVaga(env);
  assert.equal((await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x'])).code, 0);
  return { env, id, pasta };
}

test('T22 integração: painel-entrada grava a entrada do pacote conferido e imprime caminho e sha256', async t => {
  const { env, id, pasta } = await comPacote(t);
  const r = await env.run(['painel-entrada', id]);
  assert.equal(r.code, 0, r.tudo);
  const caminho = join(pasta, 'painel-entrada.md');
  const bytes = await readFile(caminho);
  assert.ok(r.out.includes(`Entrada do painel: ${caminho}`), r.out);
  assert.ok(r.out.includes(`sha256: ${sha256(bytes)}`), r.out);
  const texto = bytes.toString('utf8');
  assert.ok(texto.includes(`vaga: ${id}`) && texto.includes('Reduzi perdas em 14% na manutenção.'), texto);
  assert.equal((await env.run(['painel-entrada', id, 'sobra'])).code, 2);
  // Vaga sem pacote: código 1 e nada gravado.
  const outra = await comVaga(env, { sourceId: 'sd701', url: 'https://vagas.solides.com.br/vaga/sd701' });
  const semPacote = await env.run(['painel-entrada', outra.id]);
  assert.equal(semPacote.code, 1, semPacote.tudo);
  assert.equal(await existe(join(outra.pasta, 'painel-entrada.md')), false);
});

test('T22 integração: painel-gravar grava, conferir-pacote confere o painel e recusa o painel alterado', async t => {
  const { env, id, pasta } = await comPacote(t);
  const semPainel = await env.run(['conferir-pacote', id]);
  assert.equal(semPainel.code, 0, semPainel.tudo);
  assert.match(semPainel.out, /Painel: não rodado/);
  assert.equal((await env.run(['painel-entrada', id])).code, 0);
  const pacoteAntes = JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8'));
  const entrada = await readFile(join(pasta, 'painel-entrada.md'), 'utf8');
  const texto = painelDoTeste({ id, pdfSha256: pacoteAntes.pdfSha256, entrada });
  const arquivo = join(env.root, 'painel-do-agente.md');
  // Recusado (crédito alterado): código 1 e pacote com os mesmos bytes.
  await writeFile(arquivo, texto.replace('@nocodealex', '@outro'));
  const bytesPacote = await readFile(join(pasta, 'pacote.json'));
  const recusado = await env.run(['painel-gravar', id, arquivo]);
  assert.equal(recusado.code, 1, recusado.tudo);
  assert.match(recusado.tudo, /linha de crédito do autor ausente ou alterada/);
  assert.deepEqual(await readFile(join(pasta, 'pacote.json')), bytesPacote);
  assert.equal(await existe(join(pasta, 'painel.md')), false);
  assert.equal((await env.run(['painel-gravar', id, join(env.root, 'nao-existe.md')])).code, 2);
  assert.equal((await env.run(['painel-gravar', id])).code, 2);
  // Válido: grava, mantém as outras chaves do pacote e o conferir-pacote passa a conferir o painel.
  await writeFile(arquivo, texto);
  const gravado = await env.run(['painel-gravar', id, arquivo]);
  assert.equal(gravado.code, 0, gravado.tudo);
  assert.ok(gravado.out.includes(`Painel gravado: ${join(pasta, 'painel.md')}`), gravado.out);
  assert.deepEqual(await readFile(join(pasta, 'painel.md')), Buffer.from(texto, 'utf8'));
  const { painel, ...resto } = JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8'));
  assert.deepEqual(resto, pacoteAntes);
  assert.equal(painel.sha256, sha256(Buffer.from(texto, 'utf8')));
  const conferido = await env.run(['conferir-pacote', id]);
  assert.equal(conferido.code, 0, conferido.tudo);
  assert.match(conferido.out, /PDF conferido/);
  assert.match(conferido.out, /Painel conferido/);
  await writeFile(join(pasta, 'painel.md'), texto.replace('Genérico.', 'Genérico demais.'));
  const alterado = await env.run(['conferir-pacote', id]);
  assert.equal(alterado.code, 1, alterado.tudo);
  assert.match(alterado.tudo, /painel mudou depois de gravado: rode o painel de novo/);
  // O preparar refaz o pacote sem `painel`: o painel.md que ficou na pasta é de um pacote anterior.
  assert.equal((await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x'])).code, 0);
  const refeito = await env.run(['conferir-pacote', id]);
  assert.equal(refeito.code, 0, refeito.tudo);
  assert.match(refeito.out, /o painel\.md da pasta é de um pacote anterior; rode painel-entrada de novo/);
});

test('T22 integração: crédito do painel dentro do CV reprova conferir-pacote e painel-entrada', async t => {
  const { env, id, pasta } = await comPacote(t);
  const caminho = join(pasta, 'cv-declarado.json');
  const declarado = JSON.parse(await readFile(caminho, 'utf8'));
  const integral = declarado.textoLivre.find(item => item.secao === 'integral');
  integral.texto += `\n${CREDITO_PAINEL}`;
  await writeFile(caminho, JSON.stringify(declarado));
  for (const comando of ['conferir-pacote', 'painel-entrada']) {
    const r = await env.run([comando, id]);
    assert.equal(r.code, 1, `${comando}: ${r.tudo}`);
    assert.match(r.tudo, /crédito do painel dentro do CV: o CV não pode levar a linha do autor/);
  }
  assert.equal(await existe(join(pasta, 'painel-entrada.md')), false);
});

// ---------------------------------------------------------------------------------------------------------------
// T23 · aprovação pelo Telegram, pela linha de comando (23.1 a 23.7, 23.9, 23.11). Servidor HTTP falso em
// 127.0.0.1 porta 0, criado aqui (node:http); nenhuma rede real. Token falso gerado em tempo de execução.

const CHAT = 8123456;
const BOT_ID = 6000001;
const tokenFalso = () => `${randomInt(100000, 999999)}:${randomBytes(30).toString('base64url')}`;

async function servidorFalso(responder) {
  const pedidos = [];
  const server = http.createServer(async (req, res) => {
    const partes = [];
    for await (const parte of req) partes.push(parte);
    const pedido = { verbo: req.method, caminho: req.url, metodo: req.url.split('/').pop(), headers: req.headers, corpo: Buffer.concat(partes) };
    pedidos.push(pedido);
    const resposta = await responder(pedido);
    if (resposta === 'pendurar') return;
    res.writeHead(resposta.status ?? 200, { 'content-type': 'application/json' });
    res.end(resposta.bruto ?? JSON.stringify(resposta.json));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`, pedidos,
    fechar() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

// multipart/form-data do sendDocument: { nome: { bytes, arquivo? } }.
function lerMultipart(pedido) {
  const fronteira = Buffer.from(`--${/boundary=(.+)$/.exec(pedido.headers['content-type'])[1]}`);
  const corpo = pedido.corpo;
  const partes = {};
  let i = corpo.indexOf(fronteira);
  while (i >= 0) {
    const inicio = i + fronteira.length;
    if (corpo.subarray(inicio, inicio + 2).toString() === '--') break;
    const proxima = corpo.indexOf(fronteira, inicio);
    const parte = corpo.subarray(inicio + 2, proxima - 2);
    const fimCabecalho = parte.indexOf('\r\n\r\n');
    const cabecalho = parte.subarray(0, fimCabecalho).toString();
    partes[/name="([^"]+)"/.exec(cabecalho)[1]] = { bytes: Buffer.from(parte.subarray(fimCabecalho + 4)), arquivo: /filename="([^"]+)"/.exec(cabecalho)?.[1] };
    i = proxima;
  }
  return partes;
}

// Bot falso: guarda o que recebeu e responde como a Bot API. `modo` força erro em toda requisição (23.1).
async function botFalso(t) {
  const bot = { token: tokenFalso(), enviados: [], documentos: [], atualizacoes: [], leituras: [], arquivos: new Map(), proximo: 500,
    modo: null, alterarTexto: false, alterarCaption: false, bytesDoArquivo: null, falharDownload: false, aoLer: null,
    webhook: { url: '', pending_update_count: 0 } };
  const ok = result => ({ status: 200, json: { ok: true, result } });
  const remetente = { id: BOT_ID, is_bot: true, first_name: 'Radar Teste', username: 'radar_teste_bot' };
  const servidor = await servidorFalso(async pedido => {
    if (bot.modo === 'pendurar') return 'pendurar';
    if (bot.modo === '401') return { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } };
    if (bot.modo === '429') return { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 1 } } };
    if (bot.modo === '500') return { status: 500, json: { ok: false, error_code: 500 } };
    if (bot.modo === 'json') return { status: 200, bruto: 'isto nao e json' };
    if (pedido.caminho.startsWith('/file/')) {
      if (bot.falharDownload) return { status: 404, json: { ok: false } };
      return { status: 200, bruto: bot.bytesDoArquivo ?? bot.arquivos.get(pedido.metodo.replace(/\.txt$/, '')) ?? '' };
    }
    const agora = Math.floor(Date.now() / 1000);
    const json = () => JSON.parse(pedido.corpo.toString('utf8') || '{}');
    if (pedido.metodo === 'getMe') return ok(remetente);
    if (pedido.metodo === 'getWebhookInfo') return ok(bot.webhook);
    if (pedido.metodo === 'sendMessage') {
      const corpo = json();
      const resultado = { message_id: ++bot.proximo, date: agora, chat: { id: corpo.chat_id, type: 'private' }, from: remetente,
        text: bot.alterarTexto ? `${corpo.text} ` : corpo.text };
      bot.enviados.push({ corpo, resultado });
      return ok(resultado);
    }
    if (pedido.metodo === 'sendDocument') {
      const partes = lerMultipart(pedido);
      const fileId = `f${bot.proximo + 1}`;
      const caption = partes.caption?.bytes.toString('utf8');
      const resultado = { message_id: ++bot.proximo, date: agora, chat: { id: Number(partes.chat_id.bytes.toString()), type: 'private' }, from: remetente,
        ...(caption === undefined ? {} : { caption: bot.alterarCaption ? `${caption} ` : caption }),
        document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: partes.document.arquivo } };
      bot.arquivos.set(fileId, partes.document.bytes);
      bot.documentos.push({ nome: partes.document.arquivo, caption, bytes: partes.document.bytes, chatId: resultado.chat.id, resultado });
      return ok(resultado);
    }
    if (pedido.metodo === 'getUpdates') {
      const corpo = json();
      bot.leituras.push(corpo);
      if (bot.aoLer) await bot.aoLer(corpo);
      return ok(bot.atualizacoes.filter(update => corpo.offset === undefined || update.update_id >= corpo.offset));
    }
    if (pedido.metodo === 'getFile') {
      const { file_id: fileId } = json();
      return ok({ file_id: fileId, file_unique_id: `u${fileId}`, file_path: `documents/${fileId}.txt` });
    }
    return { status: 404, json: { ok: false, description: 'método desconhecido' } };
  });
  t.after(() => servidor.fechar());
  return Object.assign(bot, { apiBase: servidor.apiBase, pedidos: servidor.pedidos });
}

// Bot falso ligado ao ambiente do teste; com `gravar`, telegram.json na pasta de dados (gravado por código).
async function comTelegram(t, env, { gravar = true } = {}) {
  const bot = await botFalso(t);
  if (gravar) await env.put('telegram.json', { token: bot.token, chatId: CHAT });
  env.tg = (args, extra = {}) => env.run(args, { telegramApi: { apiBase: bot.apiBase, sleep: async () => {} }, ...extra });
  return bot;
}

async function comPendentes(env, frases) {
  await mkdir(join(env.dataDir, 'candidaturas'), { recursive: true });
  await env.put('candidaturas/frases-pendentes.json', { versao: 1, frases });
}
async function comBasePendente(env, bases = ['base-a']) {
  await mkdir(join(env.dataDir, 'candidaturas'), { recursive: true });
  await env.put('candidaturas/bases-pendentes.json', { versao: 1,
    bases: Object.fromEntries(bases.map(base => [base, { primeiraVez: true, acrescentados: [], removidos: [], motivos: ['base sem aprovação'] }])) });
}
async function lotesGravados(env) {
  const pasta = join(env.dataDir, 'candidaturas', 'lotes-aprovacao');
  const nomes = await readdir(pasta).catch(() => []);
  return Promise.all(nomes.map(async nome => ({ ...JSON.parse(await readFile(join(pasta, nome), 'utf8')), caminho: join(pasta, nome) })));
}

let ultimaAtualizacao = 70000;
const atualizacao = (conteudo, tipo = 'message') => ({ update_id: ++ultimaAtualizacao, [tipo]: conteudo });
// Resposta da pessoa (from.id = chat.id = CHAT, conversa privada) a uma mensagem que o bot devolveu.
function respostaA(bot, alvo, texto = 'aprovo', extra = {}) {
  return { message_id: ++bot.proximo, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' },
    from: { id: CHAT, is_bot: false, first_name: 'Ana' }, ...(texto === undefined ? {} : { text: texto }),
    reply_to_message: structuredClone(alvo), ...extra };
}

async function arquivosDaPasta(pasta) {
  const saida = [];
  for (const entrada of await readdir(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, entrada.name);
    if (entrada.isDirectory()) saida.push(...await arquivosDaPasta(caminho));
    else saida.push(caminho);
  }
  return saida;
}

test('23.1 sem configuração, só uma variável, token fora do formato, chave desconhecida e JSON inválido: código 2 e 0 requisições', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env, { gravar: false });
  await comPendentes(env, [pendente('f1', 'Coordenei 3 squads')]);
  for (const comando of [['pedir-aprovacao'], ['receber-aprovacao'], ['avisar-vaga', 'solides:sd700']]) {
    const r = await env.tg(comando);
    assert.equal(r.code, 2, `${comando[0]}: ${r.tudo}`);
    assert.match(r.tudo, /configure o Telegram/);
  }
  const soToken = await env.tg(['pedir-aprovacao'], { ambienteTelegram: { RADAR_TELEGRAM_TOKEN: bot.token } });
  assert.equal(soToken.code, 2);
  assert.match(soToken.tudo, /configure o Telegram: falta RADAR_TELEGRAM_CHAT_ID/);
  const soChat = await env.tg(['pedir-aprovacao'], { ambienteTelegram: { RADAR_TELEGRAM_CHAT_ID: String(CHAT) } });
  assert.match(soChat.tudo, /configure o Telegram: falta RADAR_TELEGRAM_TOKEN/);
  for (const [doc, campo] of [[{ token: '123:curto', chatId: CHAT }, /campo token/], [{ token: bot.token, chatId: CHAT, extra: 1 }, /chave desconhecida em telegram\.json \(extra\)/],
    [{ token: bot.token, chatId: 'abc' }, /campo chatId/]]) {
    await env.put('telegram.json', doc);
    const r = await env.tg(['pedir-aprovacao']);
    assert.equal(r.code, 2, r.tudo);
    assert.match(r.tudo, /configure o Telegram/);
    assert.match(r.tudo, campo);
    assert.ok(!r.tudo.includes(bot.token));
  }
  await env.put('telegram.json', `{"token":"${bot.token}",`);
  const quebrado = await env.tg(['pedir-aprovacao']);
  assert.equal(quebrado.code, 2);
  assert.match(quebrado.tudo, /telegram\.json não é JSON válido/);
  assert.ok(!quebrado.tudo.includes(bot.token));
  // Só a nossa frase: nada do error.message do JSON.parse (que pode ecoar parte do arquivo).
  assert.equal(quebrado.err, 'telegram.json não é JSON válido; nada foi enviado.');
  assert.equal(bot.pedidos.length, 0);
});

test('23.1 com telegram.json, as variáveis são ignoradas: token e chat_id do arquivo, e o lote grava o chatId do arquivo', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('f1', 'Coordenei 3 squads')]);
  const r = await env.tg(['pedir-aprovacao'], { ambienteTelegram: { RADAR_TELEGRAM_TOKEN: tokenFalso(), RADAR_TELEGRAM_CHAT_ID: '7777777' } });
  assert.equal(r.code, 0, r.tudo);
  assert.ok(bot.pedidos.length > 0);
  assert.ok(bot.pedidos.every(pedido => pedido.caminho.includes(`/bot${bot.token}/`)));
  assert.equal(bot.enviados[0].corpo.chat_id, CHAT);
  assert.equal((await lotesGravados(env))[0].chatId, CHAT);
});

test('23.1 o par RADAR_TELEGRAM_* sai de process.env antes do comando: a ponte não o herda e o pedir-aprovacao seguinte ainda o acha', async t => {
  const env = await setup(t);
  await env.aprovarBases();
  const { id } = await comVaga(env);
  const arquivo = join(env.root, 'ambiente-da-ponte.json');
  env.cenario.gravarAmbiente = arquivo;
  await env.salvar();
  const bot = await comTelegram(t, env, { gravar: false });
  t.after(() => { delete process.env.RADAR_TELEGRAM_TOKEN; delete process.env.RADAR_TELEGRAM_CHAT_ID; });
  process.env.RADAR_TELEGRAM_TOKEN = bot.token;
  process.env.RADAR_TELEGRAM_CHAT_ID = String(CHAT);
  const preparado = await env.run(['preparar', id, '--variante', 'analista-plan', '--porque', 'x'], { ambienteTelegram: undefined });
  assert.equal(preparado.code, 0, preparado.tudo);
  const chaves = JSON.parse(await readFile(arquivo, 'utf8'));
  assert.ok(chaves.length > 0);
  assert.deepEqual(chaves.filter(chave => chave.toUpperCase().startsWith('RADAR_TELEGRAM_')), []);
  assert.equal(process.env.RADAR_TELEGRAM_TOKEN, undefined);
  await comPendentes(env, [pendente('f1', 'Coordenei 3 squads')]);
  const pedido = await env.tg(['pedir-aprovacao'], { ambienteTelegram: undefined });
  assert.equal(pedido.code, 0, pedido.tudo);
  assert.equal(bot.enviados.length, 1);
  assert.equal(bot.enviados[0].corpo.chat_id, CHAT);
});

test('23.1 o token não aparece em saída nem em arquivo gravado: sucesso, 401, 429, 500, JSON inválido, prazo e conexão recusada', async t => {
  const { env, id } = await comPacote(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('f1', 'Coordenei 3 squads')]);
  const saidas = [];
  const rodar = async (args, extra) => { const r = await env.tg(args, extra); saidas.push(r.tudo); return r; };
  // Sucesso nos três comandos, com resposta aplicada (grava lote, aprovação, offset e avisos).
  assert.equal((await rodar(['pedir-aprovacao'])).code, 0);
  bot.atualizacoes.push(atualizacao(respostaA(bot, bot.enviados[0].resultado)));
  assert.equal((await rodar(['receber-aprovacao'])).code, 0);
  assert.equal((await rodar(['avisar-vaga', id])).code, 0);
  await comPendentes(env, [pendente('f2', 'Planejei 4 rotas fictícias')]);
  const fechado = await servidorFalso(async () => ({ status: 200, json: {} }));
  const enderecoFechado = fechado.apiBase;
  await fechado.fechar();
  for (const [modo, extra] of [['401'], ['429'], ['500'], ['json'], ['pendurar', { telegramApi: { apiBase: bot.apiBase, sleep: async () => {}, prazoMs: 50 } }],
    ['conexao', { telegramApi: { apiBase: enderecoFechado, sleep: async () => {} } }]]) {
    bot.modo = modo === 'conexao' ? null : modo;
    for (const args of [['pedir-aprovacao'], ['receber-aprovacao'], ['avisar-vaga', id]]) {
      const r = await rodar(args, extra);
      assert.equal(r.code, 1, `${modo} ${args[0]}: ${r.tudo}`);
      assert.ok(r.err.includes('bot***'), `${modo} ${args[0]}: ${r.err}`);
    }
  }
  bot.modo = null;
  for (const saida of saidas) assert.ok(!saida.includes(bot.token), saida);
  // Todo arquivo da pasta de dados, menos o telegram.json (que guarda o token por definição).
  for (const arquivo of await arquivosDaPasta(env.dataDir)) {
    if (basename(arquivo) === 'telegram.json') continue;
    assert.ok(!(await readFile(arquivo)).includes(Buffer.from(bot.token)), arquivo);
  }
});

test('23.2 o lote é o que será gravado: frases em texto puro com ascii só abaixo da frase acentuada; base num documento só com caption', async t => {
  const env = await setup(t);
  const retratoA = () => retratoDaBase(env.cenario.fatos['base-a'], { complementos: [], preparo: env.busca.preparo, proibidasSha256: sha256(Buffer.alloc(0)) });
  const contar = () => situacaoDaBase('base-a', retratoA(), {}).pendente.acrescentados.length;
  for (let n = 1; contar() < 41; n++) env.cenario.fatos['base-a'].cursos.push(`Curso Inventado Extra ${n}`);
  assert.equal(contar(), 41);
  await env.salvar();
  await comPendentes(env, [pendente('f1', 'Reduzi custos em 12% na Alfa Fictícia'), pendente('f2', 'Coordenei 3 squads')]);
  await comBasePendente(env);
  const bot = await comTelegram(t, env);
  const r = await env.tg(['pedir-aprovacao']);
  assert.equal(r.code, 0, r.tudo);
  // Lote de frases: uma mensagem, sem parse_mode, igual byte a byte ao textoDoLote do lote gravado.
  assert.equal(bot.enviados.length, 1);
  const [mensagem] = bot.enviados;
  assert.deepEqual(Object.keys(mensagem.corpo).sort(), ['chat_id', 'text']);
  const lotes = await lotesGravados(env);
  const loteF = lotes.find(lote => lote.tipo === 'frases'), loteB = lotes.find(lote => lote.tipo === 'base');
  assert.equal(mensagem.corpo.text, textoDoLote(loteF));
  assert.deepEqual(loteF.itens.map(item => [item.n, item.id, item.texto]), [[1, 'f1', 'Reduzi custos em 12% na Alfa Fictícia'], [2, 'f2', 'Coordenei 3 squads']]);
  const linhas = mensagem.corpo.text.split('\n');
  assert.ok(linhas.includes(`Radar de vagas: lote ${loteF.loteId}, 2 frases para aprovar`));
  assert.ok(linhas.some(linha => linha.startsWith('1. [perfil] ')) && linhas.some(linha => linha.startsWith('2. [perfil] ')));
  const i1 = linhas.indexOf('"Reduzi custos em 12% na Alfa Fictícia"'), i2 = linhas.indexOf('"Coordenei 3 squads"');
  assert.ok(i1 > 0 && i2 > i1);
  assert.equal(linhas[i1 + 1], 'ascii: "Reduzi custos em 12% na Alfa Fict\\u00edcia"');
  assert.ok(!linhas[i2 + 1].startsWith('ascii:'));
  assert.equal(linhas.filter(linha => linha.startsWith('ascii:')).length, 1);
  assert.equal(loteF.chatId, CHAT);
  assert.deepEqual(loteF.mensagens, [mensagem.resultado.message_id]);
  assert.equal(loteF.loteId, sha256(jsonCanonico(loteF.itens)).slice(0, 12));
  assert.equal(loteF.sha256, sha256(jsonCanonico({ versao: 1, tipo: 'frases', loteId: loteF.loteId, chatId: CHAT, itens: loteF.itens })));
  assert.equal(loteB.sha256, hashDoLote(loteB));
  // Lote de base: um sendDocument só, retrato-base-a.txt, hash na 1ª linha e 41 itens entre aspas; caption = textoDoLote.
  assert.equal(bot.documentos.length, 1);
  assert.equal(bot.pedidos.filter(pedido => pedido.metodo === 'sendMessage').length, 1);
  const [documento] = bot.documentos;
  assert.equal(documento.nome, 'retrato-base-a.txt');
  const texto = documento.bytes.toString('utf8');
  assert.equal(texto, documentoDoRetrato(retratoA()));
  const linhasDoc = texto.split('\n').filter(Boolean);
  assert.equal(linhasDoc[0], hashRetrato(retratoA()));
  assert.equal(linhasDoc.length, 42);
  assert.ok(linhasDoc.slice(1).every(linha => linha.startsWith('"')));
  assert.ok(!linhasDoc.some(linha => linha.startsWith('{')));
  assert.throws(() => JSON.parse(texto));
  assert.equal(documento.caption, textoDoLote(loteB));
  assert.ok(documento.caption.includes(hashRetrato(retratoA())));
  assert.match(documento.caption, /itens no retrato: 41; acrescentados: 41; removidos: 0/);
  assert.ok(!documento.caption.includes('curso:'));
  assert.equal(documento.chatId, CHAT);
  assert.deepEqual(loteB.mensagens, [documento.resultado.message_id]);
  assert.equal(loteB.fileUniqueId, documento.resultado.document.file_unique_id);
  assert.equal(loteB.documentoSha256, sha256(documento.bytes));
  assert.equal(loteB.chatId, CHAT);
});

test('23.2 o Telegram devolvendo outro text ou outro caption: código 1 e o lote não é gravado', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('f1', 'Coordenei 3 squads')]);
  bot.alterarTexto = true;
  const texto = await env.tg(['pedir-aprovacao']);
  assert.equal(texto.code, 1, texto.tudo);
  assert.match(texto.tudo, /o Telegram alterou o texto do lote/);
  assert.deepEqual(await lotesGravados(env), []);
  bot.alterarTexto = false;
  bot.alterarCaption = true;
  await comPendentes(env, []);
  await comBasePendente(env);
  const caption = await env.tg(['pedir-aprovacao']);
  assert.equal(caption.code, 1, caption.tudo);
  assert.match(caption.tudo, /o Telegram alterou o texto do lote/);
  assert.equal(bot.documentos.length, 1);
  assert.deepEqual(await lotesGravados(env), []);
});

test('23.2 base cujo caption passaria de 1.024 caracteres: código 2 e nada enviado', async t => {
  const env = await setup(t);
  const longa = `base-${'x'.repeat(1100)}`;
  env.cenario.variantes.variantes.push({ id: 'analista-longa', titulo: 'Analista de Planejamento', perfil: 'Planejo cenários fictícios.', habilidades: [] });
  env.cenario.baseDe['analista-longa'] = longa;
  env.cenario.fatos[longa] = { ...fatosBase()['base-a'], base: longa };
  await env.salvar();
  await comBasePendente(env, [longa]);
  const bot = await comTelegram(t, env);
  const r = await env.tg(['pedir-aprovacao']);
  assert.equal(r.code, 2, r.tudo);
  assert.match(r.tudo, /passa de 1024 caracteres/);
  assert.equal(bot.pedidos.length, 0);
});

test('23.2 lotes de no máximo 10 frases e 4.096 caracteres, sem cortar texto; frase que não cabe sozinha sai 2', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  const frases = n => Array.from({ length: n }, (_, i) => pendente(`g${n}-${i + 1}`, `Coordenei ${i + 1} squads fictícios`));
  await comPendentes(env, frases(11));
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  assert.deepEqual((await lotesGravados(env)).map(lote => lote.itens.length).sort((a, b) => a - b), [1, 10]);
  assert.equal(bot.enviados.length, 2);
  await rm(join(env.dataDir, 'candidaturas', 'lotes-aprovacao'), { recursive: true });
  await comPendentes(env, frases(10));
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  assert.deepEqual((await lotesGravados(env)).map(lote => lote.itens.length), [10]);
  await rm(join(env.dataDir, 'candidaturas', 'lotes-aprovacao'), { recursive: true });
  const longas = Array.from({ length: 5 }, (_, i) => pendente(`l${i + 1}`, `Texto inventado ${i + 1} ${'x'.repeat(990)}`));
  await comPendentes(env, longas);
  const antes = bot.enviados.length;
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const enviados = bot.enviados.slice(antes);
  assert.ok(enviados.length >= 2, `${enviados.length} lotes`);
  assert.ok(enviados.every(({ corpo }) => corpo.text.length <= 4096));
  for (const item of longas) assert.equal(enviados.filter(({ corpo }) => corpo.text.includes(`"${item.frase}"`)).length, 1, item.id);
  assert.equal((await lotesGravados(env)).reduce((soma, lote) => soma + lote.itens.length, 0), 5);
  await comPendentes(env, [pendente('enorme', `Texto inventado ${'y'.repeat(4100)}`)]);
  const pedidos = bot.pedidos.length;
  const r = await env.tg(['pedir-aprovacao']);
  assert.equal(r.code, 2, r.tudo);
  assert.match(r.tudo, /frase longa demais para uma mensagem: enorme/);
  assert.equal(bot.pedidos.length, pedidos);
});

test('23.2 caractere de controle na frase, na origem ou na seção, espaço duplo, nome de base inválido e retrato com U+202E: código 2, 0 requisições', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  const casos = [
    [pendente('c1', 'Reduzi custos \u202E em 12%'), /caractere de controle U\+202E no campo frase da frase c1/],
    [pendente('c2', 'Coordenei 3 squads', { origem: 'variante analista-plan,\nperfil' }), /caractere de controle U\+000A no campo origem/],
    [pendente('c3', 'Coordenei 3 squads', { origem: 'variante analista-plan,\u2028perfil' }), /caractere de controle U\+2028 no campo origem/],
    [pendente('c4', 'Coordenei 3 squads', { secao: 'perfil\u202E' }), /caractere de controle U\+202E no campo secao/],
    [pendente('e1', 'Coordenei  3 squads'), /texto com espaço duplo ou nas pontas: corrija a variante/],
    [pendente('e2', ' Coordenei 3 squads'), /texto com espaço duplo ou nas pontas: corrija a variante/],
    [pendente('e3', 'Coordenei 3 squads '), /texto com espaço duplo ou nas pontas: corrija a variante/],
  ];
  for (const [item, esperado] of casos) {
    await comPendentes(env, [item]);
    const r = await env.tg(['pedir-aprovacao']);
    assert.equal(r.code, 2, `${item.id}: ${r.tudo}`);
    assert.match(r.tudo, esperado, item.id);
  }
  await comPendentes(env, []);
  await comBasePendente(env, ['Base X\nfalsa']);
  const nome = await env.tg(['pedir-aprovacao']);
  assert.equal(nome.code, 2, nome.tudo);
  assert.match(nome.tudo, /nome de base inválido/);
  // Objeto novo: experienciaA \u00E9 compartilhado entre os testes e n\u00E3o pode ser mexido.
  env.cenario.fatos['base-a'].experiencias = [{ ...experienciaA, cargo: 'Analista \u202Ede Planejamento' }];
  await env.salvar();
  await comBasePendente(env);
  const retrato = await env.tg(['pedir-aprovacao']);
  assert.equal(retrato.code, 2, retrato.tudo);
  assert.match(retrato.tudo, /base "base-a": item do retrato com caractere de controle U\+202E: .*\\u202E/);
  assert.equal(bot.pedidos.length, 0);
  assert.deepEqual(await lotesGravados(env), []);
});

test('23.3 só a pessoa, em conversa privada, respondendo ao lote do bot: (b) a (m) não gravam e vão para telegram-ignorados.json sem texto', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('a1', 'Coordenei 3 squads')]);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const alvo = bot.enviados[0].resultado;
  const resp = extra => respostaA(bot, alvo, 'aprovo', extra);
  const casos = {
    b: atualizacao(resp({ from: { id: 5550001, is_bot: false, first_name: 'Outra' } })),
    c: atualizacao(resp({ chat: { id: -100123, type: 'group', title: 'Grupo Fictício' } })),
    d: atualizacao(resp({ reply_to_message: undefined })),
    e: atualizacao(resp({ reply_to_message: { ...structuredClone(alvo), message_id: 7 } })),
    f: atualizacao(resp(), 'edited_message'),
    g: atualizacao(resp({ forward_origin: { type: 'user', date: 1, sender_user: { id: CHAT, is_bot: false, first_name: 'Ana' } } })),
    h: atualizacao(resp({ from: { id: CHAT, is_bot: true, first_name: 'Ana' } })),
    i: atualizacao(resp({ quote: { text: 'Coordenei', position: 0 } })),
    j1: atualizacao(resp({ via_bot: { id: 42, is_bot: true, first_name: 'Outro bot' } })),
    j2: atualizacao(resp({ sender_chat: { id: -100999, type: 'channel', title: 'Canal Fictício' } })),
    j3: atualizacao(resp({ sender_business_bot: { id: 43, is_bot: true, first_name: 'Bot comercial' } })),
    j4: atualizacao(resp({ is_automatic_forward: true })),
    k: atualizacao(resp(), 'business_message'),
    l: atualizacao(resp({ reply_to_message: { ...structuredClone(alvo), edit_date: alvo.date + 5 } })),
    m: atualizacao(resp({ reply_to_message: { ...structuredClone(alvo), from: { id: 999, is_bot: true, first_name: 'Outro bot' } } })),
    a: atualizacao(resp()),
  };
  bot.atualizacoes.push(...Object.values(casos));
  const r = await env.tg(['receber-aprovacao']);
  assert.equal(r.code, 0, r.tudo);
  const aprovadas = await env.ler('frases-aprovadas.json');
  assert.deepEqual(aprovadas.frases.map(item => [item.texto, item.origem]),
    [['Coordenei 3 squads', `variante analista-plan, perfil · telegram:${casos.a.message.message_id}`]]);
  const ignorados = (await env.ler('candidaturas/telegram-ignorados.json')).ignorados;
  const esperados = Object.entries(casos).filter(([chave]) => chave !== 'a').map(([, update]) => update.update_id);
  assert.deepEqual(ignorados.map(item => item.update_id), esperados);
  assert.ok(ignorados.every(item => typeof item.motivo === 'string' && item.motivo));
  assert.equal(ignorados.find(item => item.update_id === casos.d.update_id).motivo, 'sem resposta ao lote');
  assert.equal(ignorados.find(item => item.update_id === casos.e.update_id).motivo, NAO_E_LOTE);
  assert.equal(ignorados.find(item => item.update_id === casos.l.update_id).motivo, LOTE_MUDOU);
  const bruto = await readFile(join(env.dataDir, 'candidaturas', 'telegram-ignorados.json'), 'utf8');
  for (const proibido of ['aprovo', 'Ana', 'Outra', 'Grupo Fictício', 'Canal Fictício']) assert.ok(!bruto.includes(proibido), proibido);
  assert.match(r.out, /ignorada: sem resposta ao lote/);
});

test('23.4 gramática fechada: a resposta vale inteira ou não vale; "não 2 motivo" recusa sem tirar das pendentes', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('g1', 'Coordenei 3 squads'), pendente('g2', 'Planejei 4 rotas fictícias'), pendente('g3', 'Reduzi perdas em 9%')]);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const alvo = bot.enviados[0].resultado;
  const [{ caminho }] = await lotesGravados(env);
  const responder = async (texto, extra) => {
    bot.atualizacoes.push(atualizacao(respostaA(bot, alvo, texto, extra)));
    const r = await env.tg(['receber-aprovacao']);
    assert.equal(r.code, 0, r.tudo);
    return r;
  };
  const ultimoMotivo = async () => (await env.ler('candidaturas/telegram-ignorados.json')).ignorados.at(-1).motivo;
  const pendentesAgora = async () => (await env.ler('candidaturas/frases-pendentes.json')).frases.map(item => item.id);
  await responder('aprovo');
  assert.match(await ultimoMotivo(), /com mais de um item, diga os números/);
  for (const texto of ['aprovo tudo', 'aprovo 0', 'aprovo 4', 'aprovo 1 1', 'aprovo 1 nao 2', 'nao 2 3', 'aprovo\u200B 1', undefined]) {
    const r = await responder(texto, texto === undefined ? { photo: [{ file_id: 'p1', file_unique_id: 'up1', width: 1, height: 1 }] } : {});
    assert.match(await ultimoMotivo(), /resposta inválida, nada aplicado/, String(texto));
    assert.match(r.out, /ignorada: resposta inválida/, String(texto));
  }
  assert.equal(await env.bytes('frases-aprovadas.json'), null);
  assert.deepEqual(JSON.parse(await readFile(caminho, 'utf8')).decisoes, {});
  await responder('Aprovo  1   3');
  assert.deepEqual((await env.ler('frases-aprovadas.json')).frases.map(item => item.texto), ['Coordenei 3 squads', 'Reduzi perdas em 9%']);
  assert.deepEqual(await pendentesAgora(), ['g2']);
  await responder('aprovo 2 3');
  assert.match(await ultimoMotivo(), /item 3 já decidido/);
  assert.deepEqual(await pendentesAgora(), ['g2']);
  assert.equal((await env.ler('frases-aprovadas.json')).frases.length, 2);
  const antes = await env.bytes('frases-aprovadas.json');
  await responder('não 2 essa frase não é minha');
  const lote = JSON.parse(await readFile(caminho, 'utf8'));
  assert.equal(lote.decisoes['2'].decisao, 'recusada');
  assert.equal(lote.decisoes['2'].motivo, 'essa frase nao e minha');
  assert.deepEqual([lote.decisoes['1'].decisao, lote.decisoes['3'].decisao], ['aprovada', 'aprovada']);
  assert.deepEqual(await pendentesAgora(), ['g2']);
  assert.deepEqual(await env.bytes('frases-aprovadas.json'), antes);
});

// Lote de 3 frases enviado; devolve o que o teste precisa para mexer antes da resposta.
async function loteDeTres(t) {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('h1', 'Coordenei 3 squads'), pendente('h2', 'Planejei 4 rotas fictícias'), pendente('h3', 'Reduzi perdas em 9%')]);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const [lote] = await lotesGravados(env);
  return { env, bot, alvo: bot.enviados[0].resultado, lote };
}
const gravarLoteDoTeste = ({ caminho, ...lote }) => writeFile(caminho, JSON.stringify(lote));

test('23.5 lote de frases mudado não vale: pendente alterada, lote editado com e sem sha256, mensagem que não é lote e chatId trocado', async t => {
  const cenarios = {
    a: async ({ env }) => {
      const doc = await env.ler('candidaturas/frases-pendentes.json');
      doc.frases[0].frase = 'Coordenei 30 squads';
      await env.put('candidaturas/frases-pendentes.json', doc);
    },
    c: async ({ lote }) => { lote.itens[0].texto = 'Coordenei 30 squads'; await gravarLoteDoTeste(lote); },
    d: async ({ env, lote }) => {
      lote.itens[0].texto = 'Fui diretor da Alfa Fictícia';
      lote.loteId = sha256(jsonCanonico(lote.itens)).slice(0, 12);
      lote.sha256 = hashDoLote(lote);
      await gravarLoteDoTeste(lote);
      const doc = await env.ler('candidaturas/frases-pendentes.json');
      doc.frases[0].frase = 'Fui diretor da Alfa Fictícia';
      await env.put('candidaturas/frases-pendentes.json', doc);
    },
    e: async contexto => { contexto.alvo = { ...contexto.alvo, message_id: 99999 }; },
    h: async ({ lote }) => { lote.chatId = 7777777; lote.sha256 = hashDoLote(lote); await gravarLoteDoTeste(lote); },
  };
  for (const [nome, mexer] of Object.entries(cenarios)) {
    const contexto = await loteDeTres(t);
    await mexer(contexto);
    const { env, bot, alvo } = contexto;
    const update = atualizacao(respostaA(bot, alvo, 'aprovo 1 2 3'));
    bot.atualizacoes.push(update);
    const r = await env.tg(['receber-aprovacao']);
    assert.equal(r.code, 0, `${nome}: ${r.tudo}`);
    assert.equal(await env.bytes('frases-aprovadas.json'), null, nome);
    const ignorado = (await env.ler('candidaturas/telegram-ignorados.json')).ignorados.at(-1);
    assert.equal(ignorado.motivo, nome === 'e' ? NAO_E_LOTE : LOTE_MUDOU, nome);
    assert.equal((await env.ler('candidaturas/telegram-offset.json')).offset, update.update_id + 1, nome);
  }
});

test('23.5 chatId: configuração trocada com o lote.chatId editado, ou resposta lida noutra conversa, não grava; o certo grava', async t => {
  const NOVO = 5550009;
  const daOutraConversa = alvo => ({ ...structuredClone(alvo), chat: { id: NOVO, type: 'private' } });
  const doNovoChat = { chat: { id: NOVO, type: 'private' }, from: { id: NOVO, is_bot: false, first_name: 'Outra' } };
  const trocarConfiguracao = async ({ env, bot }) => env.put('telegram.json', { token: bot.token, chatId: NOVO });
  const cenarios = {
    // O caso do verificador: chatId trocado na configuração e no lote (hash não recalculado), resposta do novo chat.
    verificador: {
      mexer: async contexto => { await trocarConfiguracao(contexto); contexto.lote.chatId = NOVO; await gravarLoteDoTeste(contexto.lote); },
      resposta: ({ bot, alvo }) => respostaA(bot, alvo, 'aprovo 1 2 3', doNovoChat),
      motivo: LOTE_MUDOU,
    },
    // Só o hash pega: o bot mandou cópia do lote ao novo chat com o mesmo message_id (o id é por conversa).
    soHash: {
      mexer: async contexto => { await trocarConfiguracao(contexto); contexto.lote.chatId = NOVO; await gravarLoteDoTeste(contexto.lote); },
      resposta: ({ bot, alvo }) => respostaA(bot, daOutraConversa(alvo), 'aprovo 1 2 3', doNovoChat),
      motivo: LOTE_MUDOU,
    },
    // Só a conversa da mensagem lida pega: configuração e lote trocados com o hash recalculado.
    hashRecalculado: {
      mexer: async contexto => {
        await trocarConfiguracao(contexto);
        contexto.lote.chatId = NOVO;
        contexto.lote.sha256 = hashDoLote(contexto.lote);
        await gravarLoteDoTeste(contexto.lote);
      },
      resposta: ({ bot, alvo }) => respostaA(bot, alvo, 'aprovo 1 2 3', doNovoChat),
      motivo: 'resposta a mensagem de outra conversa',
    },
    // Nada trocado, mas reply_to_message.chat.id de outra conversa.
    outraConversa: {
      mexer: async () => {},
      resposta: ({ bot, alvo }) => respostaA(bot, daOutraConversa(alvo), 'aprovo 1 2 3'),
      motivo: 'resposta a mensagem de outra conversa',
    },
  };
  for (const [nome, { mexer, resposta, motivo }] of Object.entries(cenarios)) {
    const contexto = await loteDeTres(t);
    await mexer(contexto);
    const { env, bot } = contexto;
    const update = atualizacao(resposta(contexto));
    bot.atualizacoes.push(update);
    const r = await env.tg(['receber-aprovacao']);
    assert.equal(r.code, 0, `${nome}: ${r.tudo}`);
    assert.equal(await env.bytes('frases-aprovadas.json'), null, nome);
    assert.equal((await env.ler('candidaturas/telegram-ignorados.json')).ignorados.at(-1).motivo, motivo, nome);
    assert.equal((await env.ler('candidaturas/telegram-offset.json')).offset, update.update_id + 1, nome);
  }
  // Controle positivo: a mesma resposta, sem mexer em nada, grava os três.
  const { env, bot, alvo } = await loteDeTres(t);
  bot.atualizacoes.push(atualizacao(respostaA(bot, alvo, 'aprovo 1 2 3')));
  assert.equal((await env.tg(['receber-aprovacao'])).code, 0);
  assert.equal((await env.ler('frases-aprovadas.json')).frases.length, 3);
});

test('23.5 itens já decididos não são conferidos de novo: "aprovo 2" depois de "aprovo 1 3" grava o 2', async t => {
  const { env, bot, alvo } = await loteDeTres(t);
  bot.atualizacoes.push(atualizacao(respostaA(bot, alvo, 'aprovo 1 3')));
  assert.equal((await env.tg(['receber-aprovacao'])).code, 0);
  bot.atualizacoes.push(atualizacao(respostaA(bot, alvo, 'aprovo 2')));
  const r = await env.tg(['receber-aprovacao']);
  assert.equal(r.code, 0, r.tudo);
  assert.deepEqual((await env.ler('frases-aprovadas.json')).frases.map(item => item.texto).sort(),
    ['Coordenei 3 squads', 'Planejei 4 rotas fictícias', 'Reduzi perdas em 9%']);
  assert.deepEqual((await env.ler('candidaturas/frases-pendentes.json')).frases, []);
});

test('23.5 lote de base: retrato mudado, documento trocado, bytes diferentes e edit_date recusam; download com erro sai redigido; o certo grava', async t => {
  const env = await setup(t);
  await comBasePendente(env);
  const bot = await comTelegram(t, env);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const alvo = bot.documentos[0].resultado;
  const [lote] = await lotesGravados(env);
  const responder = async (reply = alvo) => {
    const update = atualizacao(respostaA(bot, reply, 'aprovo'));
    bot.atualizacoes.push(update);
    const r = await env.tg(['receber-aprovacao']);
    return { r, update };
  };
  const recusado = async (nome, reply) => {
    const { r, update } = await responder(reply);
    assert.equal(r.code, 0, `${nome}: ${r.tudo}`);
    assert.equal(await env.bytes('bases-aprovadas.json'), null, nome);
    assert.equal((await env.ler('candidaturas/telegram-ignorados.json')).ignorados.at(-1).motivo, LOTE_MUDOU, nome);
    assert.equal((await env.ler('candidaturas/telegram-offset.json')).offset, update.update_id + 1, nome);
  };
  const original = structuredClone(env.cenario.fatos);
  env.cenario.fatos['base-a'].textoLivre[1].texto = env.cenario.fatos['base-a'].textoLivre[1].texto.replace('14%', '41%');
  await env.salvar();
  await recusado('b');
  env.cenario.fatos = original;
  await env.salvar();
  await recusado('f', { ...alvo, document: { ...alvo.document, file_unique_id: 'outro-documento' }, edit_date: alvo.date + 9 });
  await recusado('f2', { ...alvo, document: { ...alvo.document, file_unique_id: 'outro-documento' } });
  bot.bytesDoArquivo = Buffer.from('documento trocado\n');
  await recusado('g');
  bot.bytesDoArquivo = null;
  await recusado('i', { ...alvo, edit_date: alvo.date + 9 });
  // Download com erro: código 1, URL redigida, offset parado (a atualização volta na próxima leitura).
  bot.falharDownload = true;
  const { r: falhou, update } = await responder();
  assert.equal(falhou.code, 1, falhou.tudo);
  assert.ok(falhou.err.includes('bot***'), falhou.err);
  assert.ok(!falhou.tudo.includes(bot.token));
  assert.equal((await env.ler('candidaturas/telegram-offset.json')).offset, update.update_id);
  bot.falharDownload = false;
  const certo = await env.tg(['receber-aprovacao']);
  assert.equal(certo.code, 0, certo.tudo);
  const bases = await env.ler('bases-aprovadas.json');
  assert.equal(bases.bases['base-a'].hash, lote.itens[0].hash);
  assert.equal(hashRetrato(bases.bases['base-a'].retrato), lote.itens[0].hash);
  assert.deepEqual(Object.keys(bases.bases['base-a']).sort(), ['aprovadaEm', 'hash', 'retrato']);
  assert.ok((await carregarBasesAprovadas({ dataDir: env.dataDir }))['base-a']);
  assert.deepEqual((await env.ler('candidaturas/bases-pendentes.json')).bases, {});
  assert.equal(JSON.parse(await readFile(lote.caminho, 'utf8')).decisoes['1'].decisao, 'aprovada');
});

test('23.6 a gravação é a do terminal: { texto, aprovadaEm, origem } com a data local da mensagem; frase já aprovada não duplica', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await env.put('frases-aprovadas.json', { versao: 1, frases: [{ texto: 'Coordenei 3 squads.', aprovadaEm: '2026-10-01', origem: 'variante analista-plan, perfil' }] });
  await comPendentes(env, [pendente('d1', 'Coordenei 3 squads'), pendente('d2', 'Planejei 4 rotas fictícias', { origem: 'vaga solides:sd700, gupy', secao: 'gupy' })]);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const data = Math.floor(Date.now() / 1000) - 2 * 86400;
  const local = new Date(data * 1000);
  const dia = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const update = atualizacao(respostaA(bot, bot.enviados[0].resultado, 'aprovo 1 2', { date: data }));
  bot.atualizacoes.push(update);
  assert.equal((await env.tg(['receber-aprovacao'])).code, 0);
  const aprovadas = await env.ler('frases-aprovadas.json');
  assert.equal(aprovadas.frases.length, 2);
  assert.deepEqual(aprovadas.frases[1], { texto: 'Planejei 4 rotas fictícias', aprovadaEm: dia, origem: `vaga solides:sd700, gupy · telegram:${update.message.message_id}` });
  assert.equal((await carregarFrasesAprovadas({ dataDir: env.dataDir })).length, 2);
  assert.deepEqual((await env.ler('candidaturas/frases-pendentes.json')).frases, []);
});

test('23.7 offset: gravado depois das aprovações; a 2ª leitura manda o offset e nada é reprocessado; falha antes do offset não duplica', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env);
  await comPendentes(env, [pendente('o1', 'Coordenei 3 squads')]);
  assert.equal((await env.tg(['pedir-aprovacao'])).code, 0);
  const update = atualizacao(respostaA(bot, bot.enviados[0].resultado));
  bot.atualizacoes.push(update);
  const falha = await env.tg(['receber-aprovacao'], { gravarOffset: async () => { throw new Error('falha simulada na gravação do offset'); } });
  assert.equal(falha.code, 1, falha.tudo);
  assert.equal((await env.ler('frases-aprovadas.json')).frases.length, 1);
  assert.equal(await existe(join(env.dataDir, 'candidaturas', 'telegram-offset.json')), false);
  assert.deepEqual(bot.leituras[0], { limit: 100, timeout: 0 });
  const segunda = await env.tg(['receber-aprovacao']);
  assert.equal(segunda.code, 0, segunda.tudo);
  assert.match(segunda.out, /resposta já aplicada antes; nada duplicado/);
  assert.equal((await env.ler('frases-aprovadas.json')).frases.length, 1);
  assert.deepEqual(await env.ler('candidaturas/telegram-offset.json'), { versao: 1, offset: update.update_id + 1 });
  const terceira = await env.tg(['receber-aprovacao']);
  assert.equal(terceira.code, 0, terceira.tudo);
  assert.deepEqual(bot.leituras.at(-1), { limit: 100, timeout: 0, offset: update.update_id + 1 });
  assert.match(terceira.out, /0 atualizações novas/);
  assert.equal((await env.ler('frases-aprovadas.json')).frases.length, 1);
});

test('23.9 avisar-vaga: confere pacote e painel, manda resumo e PDF intacto e grava avisos-telegram.json sem mudar a marcação', async t => {
  const { env, id, pasta } = await comPacote(t);
  assert.equal((await env.run(['painel-entrada', id])).code, 0);
  const pacote = JSON.parse(await readFile(join(pasta, 'pacote.json'), 'utf8'));
  const entrada = await readFile(join(pasta, 'painel-entrada.md'), 'utf8');
  const arquivo = join(env.root, 'painel-do-agente.md');
  await writeFile(arquivo, painelDoTeste({ id, pdfSha256: pacote.pdfSha256, entrada }));
  assert.equal((await env.run(['painel-gravar', id, arquivo])).code, 0);
  const bot = await comTelegram(t, env);
  const marcaAntes = (await loadState({ dataDir: env.dataDir })).jobs[id].mark;
  const r = await env.tg(['avisar-vaga', id]);
  assert.equal(r.code, 0, r.tudo);
  assert.equal(bot.enviados.length, 1);
  const texto = bot.enviados[0].corpo.text;
  for (const trecho of ['Analista de Planejamento', 'Empresa: Beta Inventada', 'Fonte: solides', 'https://vagas.solides.com.br/vaga/sd700',
    'Variante do CV: analista-plan', 'Por que esta variante: x', 'Veracidade: aprovada', 'Gate do CV: aprovado',
    '- Triagem automática: PASSA', '- Gestor: ENTREVISTA', '- Leitor: CEO: DESCARTA', '1. "Planejo cenários fictícios.": Genérico.']) assert.ok(texto.includes(trecho), trecho);
  assert.ok(!('parse_mode' in bot.enviados[0].corpo));
  assert.equal(bot.documentos.length, 1);
  assert.equal(bot.documentos[0].nome, basename(pacote.pdf));
  assert.equal(sha256(bot.documentos[0].bytes), pacote.pdfSha256);
  const avisos = JSON.parse(await readFile(join(pasta, 'avisos-telegram.json'), 'utf8'));
  assert.deepEqual(avisos.mensagens, { resumo: bot.enviados[0].resultado.message_id, pdf: bot.documentos[0].resultado.message_id });
  assert.deepEqual((await loadState({ dataDir: env.dataDir })).jobs[id].mark, marcaAntes);
  // PDF trocado depois do preparar: código 1 e 0 requisições.
  const pedidos = bot.pedidos.length;
  await writeFile(pacote.pdf, `${await readFile(pacote.pdf, 'utf8')} `);
  const trocado = await env.tg(['avisar-vaga', id]);
  assert.equal(trocado.code, 1, trocado.tudo);
  assert.match(trocado.tudo, /PDF mudou depois do preparo/);
  assert.equal(bot.pedidos.length, pedidos);
});

test('23.9 avisar-vaga: crédito do painel no CV não envia nada; vaga da Gupy manda o texto numa mensagem própria e "Painel: não rodado"', async t => {
  const { env, id, pasta } = await comPacote(t);
  const bot = await comTelegram(t, env);
  const caminho = join(pasta, 'cv-declarado.json');
  const original = await readFile(caminho, 'utf8');
  const declarado = JSON.parse(original);
  declarado.textoLivre.find(item => item.secao === 'integral').texto += `\n${CREDITO_PAINEL}`;
  await writeFile(caminho, JSON.stringify(declarado));
  const credito = await env.tg(['avisar-vaga', id]);
  assert.equal(credito.code, 1, credito.tudo);
  assert.match(credito.tudo, /crédito do painel dentro do CV/);
  assert.equal(bot.pedidos.length, 0);
  const gupy = await comVaga(env, { source: 'gupy', sourceId: 'gp-900', url: 'https://alfa.gupy.io/jobs/900' });
  await mkdir(gupy.pasta, { recursive: true });
  await writeFile(join(gupy.pasta, 'texto-gupy.txt'), 'Tenho interesse na vaga fictícia.');
  assert.equal((await env.run(['preparar', gupy.id, '--variante', 'analista-plan', '--porque', 'x'])).code, 0);
  const r = await env.tg(['avisar-vaga', gupy.id]);
  assert.equal(r.code, 0, r.tudo);
  assert.equal(bot.enviados.length, 2);
  assert.match(bot.enviados[0].corpo.text, /Painel: não rodado/);
  assert.equal(bot.enviados[1].corpo.text, 'Tenho interesse na vaga fictícia.');
  assert.equal(bot.documentos.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(gupy.pasta, 'avisos-telegram.json'), 'utf8')).mensagens), ['resumo', 'textoGupy', 'pdf']);
});

test('pedir-aprovacao --previa: mostra os lotes e quantos itens, sem configuração, sem rede e sem gravar lote', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env, { gravar: false });
  await comPendentes(env, [pendente('p1', 'Coordenei 3 squads'), pendente('p2', 'Reduzi custos em 12% na Alfa Fictícia')]);
  await comBasePendente(env);
  const r = await env.tg(['pedir-aprovacao', '--previa']);
  assert.equal(r.code, 0, r.tudo);
  assert.match(r.out, /\(frases\): 2 itens/);
  assert.match(r.out, /\(base\): 1 item/);
  assert.ok(r.out.includes('"Coordenei 3 squads"'));
  assert.ok(r.out.includes(`ascii: "${formaAscii('Reduzi custos em 12% na Alfa Fictícia')}"`));
  assert.match(r.out, /Prévia: 2 lotes; nada foi enviado nem gravado/);
  assert.equal(bot.pedidos.length, 0);
  assert.deepEqual(await lotesGravados(env), []);
  assert.equal(await existe(join(env.dataDir, 'candidaturas', 'lotes-aprovacao')), false);
});

test('23.11 configurar-telegram: só no terminal; recusa webhook e pendências; ignora o código de grupo e o 1º remetente; grava o chatId certo', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env, { gravar: false });
  const telas = [];
  const io = extra => ({ isTTY: true, perguntarSegredo: async () => bot.token, escrever: texto => telas.push(texto), ...extra });
  const semTerminal = await env.tg(['configurar-telegram'], { io: io({ isTTY: false }) });
  assert.equal(semTerminal.code, 2);
  assert.equal(bot.pedidos.length, 0);
  bot.webhook = { url: 'https://outro.example/gancho', pending_update_count: 0 };
  const webhook = await env.tg(['configurar-telegram'], { io: io() });
  assert.equal(webhook.code, 2, webhook.tudo);
  assert.match(webhook.tudo, /este bot já é usado por outro serviço/);
  bot.webhook = { url: '', pending_update_count: 3 };
  const pendencias = await env.tg(['configurar-telegram'], { io: io() });
  assert.equal(pendencias.code, 2, pendencias.tudo);
  assert.match(pendencias.tudo, /3 atualizações pendentes de outro uso/);
  assert.equal(await env.bytes('telegram.json'), null);
  bot.webhook = { url: '', pending_update_count: 0 };
  bot.aoLer = () => {
    if (bot.atualizacoes.length) return;
    const codigo = /código: (\d{6})/.exec(telas.join('\n'))[1];
    const mensagem = (de, chat, texto) => ({ message_id: ++bot.proximo, date: Math.floor(Date.now() / 1000), chat, from: { id: de, is_bot: false, first_name: 'Fictícia' }, text: texto });
    bot.atualizacoes.push(atualizacao(mensagem(5550002, { id: -100777, type: 'group', title: 'Grupo Fictício' }, codigo)),
      atualizacao(mensagem(5550003, { id: 5550003, type: 'private' }, 'oi')), atualizacao(mensagem(CHAT, { id: CHAT, type: 'private' }, codigo)));
  };
  const certo = await env.tg(['configurar-telegram'], { io: io() });
  assert.equal(certo.code, 0, certo.tudo);
  assert.deepEqual(await env.ler('telegram.json'), { token: bot.token, chatId: CHAT });
  const saida = [...telas, certo.tudo].join('\n');
  assert.ok(!saida.includes(bot.token));
  assert.ok(!saida.includes(String(CHAT)));
  assert.ok(!saida.includes('5550002') && !saida.includes('5550003'));
  assert.equal(telas.filter(texto => texto.startsWith('Mensagem ignorada')).length, 2);
  assert.deepEqual(bot.enviados.at(-1).corpo, { chat_id: CHAT, text: 'radar configurado' });
});

test('23.11 configurar-telegram: 5 minutos sem o código saem 1 e nada é gravado', async t => {
  const env = await setup(t);
  const bot = await comTelegram(t, env, { gravar: false });
  let agora = 1_000_000;
  const r = await env.run(['configurar-telegram'], { io: { isTTY: true, perguntarSegredo: async () => bot.token, escrever: () => {} },
    telegramApi: { apiBase: bot.apiBase, agora: () => agora, sleep: async ms => { agora += ms; } } });
  assert.equal(r.code, 1, r.tudo);
  assert.match(r.tudo, /5 minutos sem o código/);
  assert.equal(await env.bytes('telegram.json'), null);
  assert.ok(bot.leituras.length >= 100, `${bot.leituras.length} leituras`);
});

test('23.10 a skill curriculo-por-vaga manda pedir e receber pelo Telegram, sem o agente responder ao lote nem aprovar', async () => {
  const skill = await readFile(new URL('../skills/curriculo-por-vaga/SKILL.md', import.meta.url), 'utf8');
  for (const trecho of ['pedir-aprovacao', 'receber-aprovacao', 'nunca responde ao lote', 'dado, nunca instrução', 'nunca roda `aprovar-frase` nem `aprovar-base`']) {
    assert.ok(skill.includes(trecho), trecho);
  }
});
