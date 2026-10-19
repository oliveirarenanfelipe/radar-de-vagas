// Pacote do preparo (docs/spec.md §3, T17): monta, verifica e grava a candidatura de uma vaga, sem rede.
// Ordem do `preparar`: variante → base aprovada → texto da variante → gerar → texto da Gupy → veracidade do CV
// gerado → gate → ficha → pacote.json, por último e só se tudo passou. Nenhuma aprovação é gravada aqui
// (isso é só do aprovacao.mjs, pela pessoa, no terminal).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  carregarBasesAprovadas, carregarComplementos, carregarFrasesAprovadas, carregarProibidas, chaveDeEntrada, hashRetrato, jsonCanonico,
} from './contrato.mjs';
import { normalizarEmpresa, normalizarPeriodo, normalizarTexto, pontoDeControle } from './frases.mjs';
import { executar as executarPonte } from './ponte.mjs';
import { contarGupy, TETO_GUPY } from './texto-gupy.mjs';
import { classificarVariantes } from './variante.mjs';
import { unidadesComSinal, verificar } from './veracidade.mjs';

export const SEM_PREPARO = 'busca.json não tem "preparo": use a skill curriculo-por-vaga (caminho do upstream) para preparar o currículo.';
const ARQUIVOS_DA_CAMADA = ['fatos-complementares.json', 'frases-aprovadas.json', 'bases-aprovadas.json', 'afirmacoes-proibidas.json'];

export const erro = (mensagem, exitCode = 1) => Object.assign(new Error(mensagem), { exitCode });
const sha256 = dados => createHash('sha256').update(dados).digest('hex');
const porTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ordenar = lista => [...lista].sort((a, b) => porTexto(jsonCanonico(a), jsonCanonico(b)));

/** Grava por temporário + rename: quem lê nunca vê arquivo pela metade. */
export async function gravarArquivo(caminho, conteudo) {
  const temporario = `${caminho}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporario, 'wx', 0o600);
    await handle.writeFile(conteudo, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporario, caminho);
  } finally {
    if (handle) await handle.close();
    await unlink(temporario).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export const gravarJson = (caminho, valor) => gravarArquivo(caminho, `${JSON.stringify(valor, null, 2)}\n`);

export async function lerJsonOuNada(caminho) {
  try { return JSON.parse(await readFile(caminho, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw erro(`Não foi possível ler ${caminho}: ${error.message}. O arquivo foi preservado.`);
  }
}

export const pastaCandidaturas = dataDir => join(dataDir, 'candidaturas');

/** Pasta da vaga: fora de [a-z0-9-] vira "-", mais um sufixo curto do hash do id; sempre dentro de candidaturas/. */
export function pastaSegura(dataDir, id) {
  const nome = `${String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)}-${sha256(String(id)).slice(0, 8)}`;
  return join(pastaCandidaturas(dataDir), nome);
}

/** Id canônico da vaga no estado (aceita alias); null se não existe. */
export function idCanonico(state, id) {
  if (Object.hasOwn(state.jobs, id)) return id;
  if (Object.hasOwn(state.aliases, id)) return state.aliases[id];
  return null;
}

/** Tudo o que a camada privada da pasta de dados acrescenta: aprovações, complementos e proibidas (só leitura). */
export async function carregarCamada({ dataDir, preparo }) {
  const [proibidas, complementos, frasesAprovadas, basesAprovadas] = await Promise.all([
    carregarProibidas({ dataDir }), carregarComplementos({ dataDir, preparo }),
    carregarFrasesAprovadas({ dataDir }), carregarBasesAprovadas({ dataDir }),
  ]);
  const bytes = await readFile(join(dataDir, 'afirmacoes-proibidas.json')).catch(error => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  return { proibidas, complementos, frasesAprovadas, basesAprovadas, proibidasSha256: sha256(bytes) };
}

/** Os complementos entram nos fatos estruturados no esquema dos fatos (sem tipo nem fonte). */
export function juntarComplementos(fatos, complementos) {
  const doTipo = tipo => complementos.filter(item => item.tipo === tipo);
  return {
    ...fatos,
    cursos: [...fatos.cursos, ...doTipo('curso').map(item => item.texto)],
    idiomas: [...fatos.idiomas, ...doTipo('idioma').map(({ idioma, nivel }) => ({ idioma, nivel }))],
    formacao: [...fatos.formacao, ...doTipo('formacao').map(({ titulo, instituicao, periodo }) => ({ titulo, instituicao, periodo }))],
  };
}

/** Retrato da base (o que a veracidade usa dela como verdade), com o mesmo formato de bases aprovadas. */
export function retratoDaBase(fatos, { complementos, preparo, proibidasSha256 }) {
  return {
    experiencias: ordenar(fatos.experiencias.map(exp => ({
      cargo: normalizarTexto(exp.cargo), empresa: normalizarEmpresa(exp.empresa), periodo: normalizarPeriodo(exp.periodo),
      local: normalizarTexto(exp.local), aliases: [...new Set((exp.aliases ?? []).map(normalizarEmpresa))].sort(),
    }))),
    formacao: ordenar(fatos.formacao.map(item => ({
      titulo: normalizarTexto(item.titulo), instituicao: normalizarTexto(item.instituicao), periodo: normalizarPeriodo(item.periodo),
    }))),
    cursos: [...new Set(fatos.cursos.map(normalizarTexto))].sort(),
    idiomas: ordenar(fatos.idiomas.map(item => ({ idioma: normalizarTexto(item.idioma), nivel: normalizarTexto(item.nivel) }))),
    complementos: ordenar(complementos),
    unidadesComSinal: ordenar(unidadesComSinal(fatos, preparo ?? {})),
    preparo: preparo ?? {},
    proibidasSha256,
  };
}

// O retrato em itens legíveis, para mostrar a diferença à pessoa (alterado = removido + acrescentado).
function itensDoRetrato(retrato) {
  const periodo = p => `${p.inicio} – ${p.fim}`;
  return [
    ...retrato.experiencias.flatMap(exp => [`experiência: ${exp.cargo} | ${exp.empresa} | ${periodo(exp.periodo)} | ${exp.local}`,
      ...exp.aliases.map(alias => `alias: ${alias} (de ${exp.empresa})`)]),
    ...retrato.formacao.map(item => `formação: ${item.titulo} | ${item.instituicao} | ${periodo(item.periodo)}`),
    ...retrato.cursos.map(curso => `curso: ${curso}`),
    ...retrato.idiomas.map(item => `idioma: ${item.idioma} | ${item.nivel}`),
    ...retrato.complementos.map(item => `complemento: ${jsonCanonico(item)}`),
    ...retrato.unidadesComSinal.map(chaves => `frase: ${chaves.join(' / ')}`),
    `configuração do preparo: ${jsonCanonico(retrato.preparo)}`,
    `lista de afirmações proibidas: sha256 ${retrato.proibidasSha256}`,
  ];
}

/** Situação da base frente às bases aprovadas: aprovada, primeira vez ou alterada (com a diferença). */
export function situacaoDaBase(base, retrato, basesAprovadas) {
  const aprovada = basesAprovadas[base];
  const hash = hashRetrato(retrato);
  if (aprovada && aprovada.hash === hash) return { aprovada: true, retrato, hash };
  if (!aprovada) {
    return { aprovada: false, retrato, hash, mensagem: 'base sem aprovação',
      pendente: { primeiraVez: true, acrescentados: itensDoRetrato(retrato), removidos: [], motivos: ['base sem aprovação'] } };
  }
  const antes = itensDoRetrato(aprovada.retrato), agora = itensDoRetrato(retrato);
  const motivos = [];
  if (jsonCanonico(aprovada.retrato.preparo) !== jsonCanonico(retrato.preparo)) motivos.push('configuração do preparo mudou');
  if (aprovada.retrato.proibidasSha256 !== retrato.proibidasSha256) motivos.push('lista de afirmações proibidas mudou');
  const mensagem = `base alterada sem aprovação${motivos.length ? ` (${motivos.join('; ')})` : ''}`;
  return { aprovada: false, retrato, hash, mensagem,
    pendente: { primeiraVez: false, acrescentados: agora.filter(item => !antes.includes(item)),
      removidos: antes.filter(item => !agora.includes(item)), motivos: [mensagem] } };
}

/** CV declarado a partir do texto da variante: título, perfil e uma seção de habilidades por item (17.11). */
export function declaradoDaVariante(variante) {
  return { versao: 1, experiencias: [], formacao: [], cursos: [], idiomas: [], textoLivre: [
    { secao: 'titulo', texto: variante.titulo }, { secao: 'perfil', texto: variante.perfil },
    ...variante.habilidades.map(texto => ({ secao: 'habilidades', texto })),
  ] };
}

/** Saída de `variantes` da ponte; variante sem título, perfil ou lista de habilidades vira "variante sem texto". */
export async function lerVariantes(opcoes, executar = executarPonte) {
  try { return await executar('variantes', {}, opcoes); }
  catch (error) {
    if (/variantes\[\d+\]/.test(error.message)) throw erro(`variante sem texto: ${error.message}`);
    throw error;
  }
}

const idPendente = frase => sha256(JSON.stringify(chaveDeEntrada(frase))).slice(0, 12);

/**
 * Acrescenta frases novas a candidaturas/frases-pendentes.json (a mesma unidade de duas origens vira um item só).
 * Frase com caractere de controle não entra: devolve o ponto de código para a falha dizer o motivo.
 */
export async function registrarPendentes(dataDir, novas) {
  const caminho = join(pastaCandidaturas(dataDir), 'frases-pendentes.json');
  const atual = (await lerJsonOuNada(caminho)) ?? { versao: 1, frases: [] };
  const comControle = new Map();
  let mudou = false;
  for (const { frase, secao, origem } of novas) {
    const ponto = pontoDeControle(frase);
    if (ponto) { comControle.set(frase, ponto); continue; }
    const id = idPendente(frase);
    const existente = atual.frases.find(item => item.id === id);
    if (existente) {
      if (!existente.origem.split('; ').includes(origem)) { existente.origem += `; ${origem}`; mudou = true; }
    } else { atual.frases.push({ id, frase, secao, origem }); mudou = true; }
  }
  if (mudou) {
    await mkdir(pastaCandidaturas(dataDir), { recursive: true });
    await gravarJson(caminho, atual);
  }
  return comControle;
}

// Falha cuja frase nova tem caractere de controle: o motivo vai junto (a correção é no texto da variante).
function anotarControle(falhas, comControle) {
  return falhas.map(falha => comControle.has(falha.trecho)
    ? { ...falha, esperado: `${falha.esperado}; caractere de controle ${comControle.get(falha.trecho)}` } : falha);
}

async function atualizarBasesPendentes(dataDir, entradas, { substituir = false } = {}) {
  const caminho = join(pastaCandidaturas(dataDir), 'bases-pendentes.json');
  const atual = substituir ? { versao: 1, bases: {} } : (await lerJsonOuNada(caminho)) ?? { versao: 1, bases: {} };
  for (const [base, pendente] of Object.entries(entradas)) {
    if (pendente) atual.bases[base] = pendente;
    else delete atual.bases[base];
  }
  await mkdir(pastaCandidaturas(dataDir), { recursive: true });
  await gravarJson(caminho, atual);
}

/** Fatos de cada variante (a ponte não diz a base antes de ler os fatos) e a primeira leitura de cada base. */
export async function lerFatos(variantes, opcoes, executar = executarPonte) {
  const porVariante = new Map(), porBase = new Map();
  for (const variante of variantes) {
    const fatos = await executar('fatos', { variante: variante.id }, opcoes);
    porVariante.set(variante.id, fatos);
    if (!porBase.has(fatos.base)) porBase.set(fatos.base, fatos);
  }
  return { porVariante, porBase };
}

const resumoFalhas = falhas => falhas.map(falha => `- ${falha.checagem} (${falha.secao}): "${falha.trecho}"; esperado: ${falha.esperado}`).join('\n');

/** Veracidade sobre o texto de cada variante, contra a base dela; grava bloqueadas e pendências (17.11, 17.14). */
export async function verificarVariantes({ dataDir, search, executar = executarPonte }) {
  const preparo = search.preparo;
  if (!preparo) throw erro(SEM_PREPARO, 2);
  const opcoes = { preparo, dataDir };
  const saida = await lerVariantes(opcoes, executar);
  const camada = await carregarCamada({ dataDir, preparo });
  const { porVariante, porBase } = await lerFatos(saida.variantes, opcoes, executar);
  const situacoes = new Map();
  for (const [base, fatos] of porBase) {
    situacoes.set(base, situacaoDaBase(base, retratoDaBase(fatos, { ...camada, preparo }), camada.basesAprovadas));
  }
  await atualizarBasesPendentes(dataDir, Object.fromEntries([...situacoes].map(([base, s]) => [base, s.aprovada ? null : s.pendente])), { substituir: true });

  const bloqueadas = [], novas = [];
  for (const variante of saida.variantes) {
    const fatos = porVariante.get(variante.id);
    const situacao = situacoes.get(fatos.base);
    // Base sem aprovação bloqueia a variante, mas o texto é conferido na mesma passada: as frases pendentes já
    // saem na 1ª varredura, e a pessoa aprova base e frases de uma vez.
    const falhas = situacao.aprovada ? [] : [{ checagem: 'base', secao: 'base', trecho: fatos.base, esperado: situacao.mensagem }];
    const resultado = verificar(declaradoDaVariante(variante), juntarComplementos(fatos, camada.complementos),
      { frasesAprovadas: camada.frasesAprovadas, proibidas: camada.proibidas, preparo });
    if (!resultado.aprovado) {
      falhas.push(...resultado.falhas);
      novas.push(...resultado.frasesNovas.map(nova => ({ ...nova, origem: `variante ${variante.id}, ${nova.secao}` })));
    }
    if (falhas.length) bloqueadas.push({ variante: variante.id, falhas });
  }
  const comControle = await registrarPendentes(dataDir, novas);
  for (const item of bloqueadas) item.falhas = anotarControle(item.falhas, comControle);

  // hashFatos: arquivos da camada + preparo + saída de variantes + fatos de cada base, no momento da verificação.
  const partes = [];
  for (const nome of ARQUIVOS_DA_CAMADA) partes.push(await readFile(join(dataDir, nome)).catch(() => Buffer.alloc(0)));
  partes.push(jsonCanonico(preparo), jsonCanonico(saida), jsonCanonico([...porBase].sort(([a], [b]) => porTexto(a, b))));
  const hashFatos = sha256(Buffer.concat(partes.map(parte => Buffer.isBuffer(parte) ? parte : Buffer.from(parte))));
  await mkdir(pastaCandidaturas(dataDir), { recursive: true });
  await gravarJson(join(pastaCandidaturas(dataDir), 'variantes-bloqueadas.json'),
    { versao: 1, verificadoEm: new Date().toISOString(), hashFatos, bloqueadas });
  return { total: saida.variantes.length, bloqueadas, basesPendentes: [...situacoes].filter(([, s]) => !s.aprovada).map(([base]) => base) };
}

const ehGupy = job => job.source === 'gupy' || [job.url, job.applyUrl].some(link => {
  try { return /(^|\.)gupy\.io$/.test(new URL(link).hostname); } catch { return false; }
});

// O declarado gerado tem de trazer o mesmo título, perfil e habilidades da variante escolhida (17.12).
function divergencia(declarado, variante) {
  const daSecao = secao => declarado.textoLivre.filter(item => item.secao === secao).map(item => normalizarTexto(item.texto));
  if (daSecao('titulo').join('\n') !== normalizarTexto(variante.titulo)) return 'titulo';
  if (daSecao('perfil').join('\n') !== normalizarTexto(variante.perfil)) return 'perfil';
  if (daSecao('habilidades').join('\n') !== variante.habilidades.map(normalizarTexto).join('\n')) return 'habilidades';
  return null;
}

function ficha({ job, entry, variante, porque, lacunas, veracidade, gate, gupy, requisicoes }) {
  const triagem = entry.triage
    ? `${'★'.repeat(entry.triage.fit)}${'☆'.repeat(5 - entry.triage.fit)} (${entry.triage.fit} de 5) · ${entry.triage.reason}${entry.triage.alerts.length ? ` · alertas: ${entry.triage.alerts.join('; ')}` : ''}`
    : 'sem triagem';
  return [`# ${job.title}`, '',
    `- Empresa: ${job.company}`, `- Fonte: ${job.source}`, `- Link de candidatura: ${job.applyUrl ?? job.url}`,
    `- Triagem: ${triagem}`, `- Variante do CV: ${variante.id}`, `- Por que esta variante: ${porque}`,
    `- Lacunas (termos do título sem cobertura): ${lacunas.length ? lacunas.join(', ') : 'nenhuma'}`,
    `- Veracidade: ${veracidade.aprovado ? 'aprovada, 0 falhas' : `reprovada, ${veracidade.falhas.length} falhas`}`,
    `- Gate do CV: ${gate}`,
    ...(gupy ? [`- Texto da Gupy: ${gupy.caracteres} caracteres (teto ${TETO_GUPY})`] : []),
    `- Requisições de rede: ${requisicoes}`, ''].join('\n');
}

/**
 * Prepara a candidatura de uma vaga. `requisicoes()` devolve quantas chamadas de rede o processo fez (o contador
 * mora em commands.mjs, 17.5). Lança erro com `exitCode` e a mensagem em português quando algo reprova.
 */
export async function preparar({ dataDir, search, state, id, variante: pedida, porque: porqueDado, executar = executarPonte, requisicoes = () => 0 }) {
  const preparo = search.preparo;
  if (!preparo) throw erro(SEM_PREPARO, 2);
  const canonico = idCanonico(state, id);
  if (!canonico) throw erro('Vaga não encontrada no estado.', 2);
  const entry = state.jobs[canonico], job = entry.job;
  const pasta = pastaSegura(dataDir, canonico);
  await mkdir(pasta, { recursive: true });
  // Pacote antigo da mesma vaga sai antes de começar: nenhuma reprovação deixa pacote para trás (17.2).
  await rm(join(pasta, 'pacote.json'), { force: true });
  const opcoes = { preparo, dataDir };

  const saida = await lerVariantes(opcoes, executar);
  const camada = await carregarCamada({ dataDir, preparo });
  let variante, ranking;
  if (pedida) {
    variante = saida.variantes.find(item => item.id === pedida);
    if (!variante) throw erro(`variante desconhecida: ${pedida}`, 2);
    ranking = classificarVariantes(job, [variante]);
  } else {
    const arquivo = await lerJsonOuNada(join(pastaCandidaturas(dataDir), 'variantes-bloqueadas.json'));
    ranking = classificarVariantes(job, saida.variantes, { bloqueadas: (arquivo?.bloqueadas ?? []).map(item => item.variante) });
    if (!ranking.length) throw erro('nenhuma variante disponível: todas estão bloqueadas na veracidade (rode verificar-variantes).');
    variante = saida.variantes.find(item => item.id === ranking[0].id);
  }
  const porque = porqueDado ?? ranking[0]?.porque ?? '';
  const lacunas = ranking[0]?.lacunas ?? [];

  // Base aprovada pela pessoa antes de valer como verdade (17.14).
  const fatos = await executar('fatos', { variante: variante.id }, opcoes);
  const situacao = situacaoDaBase(fatos.base, retratoDaBase(fatos, { ...camada, preparo }), camada.basesAprovadas);
  if (!situacao.aprovada) {
    await atualizarBasesPendentes(dataDir, { [fatos.base]: situacao.pendente });
    throw erro(`${situacao.mensagem}: base "${fatos.base}" da variante ${variante.id}. Veja candidaturas/bases-pendentes.json.`);
  }
  const fatosJuntos = juntarComplementos(fatos, camada.complementos);
  const opcoesVeracidade = { frasesAprovadas: camada.frasesAprovadas, proibidas: camada.proibidas, preparo };

  // O texto da variante é verificado de novo, contra os fatos de agora (o arquivo de bloqueadas pode estar velho).
  const daVariante = verificar(declaradoDaVariante(variante), fatosJuntos, opcoesVeracidade);
  if (!daVariante.aprovado) {
    const comControle = await registrarPendentes(dataDir, daVariante.frasesNovas.map(nova => ({ ...nova, origem: `variante ${variante.id}, ${nova.secao}` })));
    const falhas = anotarControle(daVariante.falhas, comControle);
    throw erro(`variante bloqueada na veracidade: ${[...new Set(falhas.map(falha => falha.checagem))].join(', ')}\n${resumoFalhas(falhas)}`);
  }

  const gerado = await executar('gerarCv', { variante: variante.id, pasta }, opcoes);
  const declarado = structuredClone(gerado.declarado);
  if (!declarado.textoLivre.some(item => item.secao === 'integral' && item.texto.trim())) {
    throw erro('declarado sem texto integral: a ponte precisa devolver a seção integral (o DOCX gerado inteiro).');
  }
  const secaoDivergente = divergencia(declarado, variante);
  if (secaoDivergente) throw erro(`declarado diverge da variante na seção ${secaoDivergente}: o CV gerado não traz o texto da variante escolhida.`);

  let gupy = null;
  if (ehGupy(job)) {
    let texto;
    try { texto = await readFile(join(pasta, 'texto-gupy.txt'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw erro(`texto da Gupy ausente: grave ${join(pasta, 'texto-gupy.txt')} antes de preparar.`);
      throw error;
    }
    gupy = contarGupy(texto);
    if (!gupy.aprovado) throw erro(`texto da Gupy reprovado: ${gupy.caracteres} caracteres (teto ${TETO_GUPY})${gupy.motivo ? `; ${gupy.motivo}` : ''}.`);
    declarado.textoLivre.push({ secao: 'gupy', texto });
  }
  await gravarJson(join(pasta, 'cv-declarado.json'), declarado);

  const veracidade = verificar(declarado, fatosJuntos, opcoesVeracidade);
  if (!veracidade.aprovado) {
    const comControle = await registrarPendentes(dataDir, veracidade.frasesNovas.map(nova => ({ ...nova, origem: `vaga ${canonico}, ${nova.secao}` })));
    veracidade.falhas = anotarControle(veracidade.falhas, comControle);
  }
  await gravarJson(join(pasta, 'veracidade.json'), veracidade);
  if (!veracidade.aprovado) throw erro(`veracidade reprovou o CV gerado; nada foi marcado como pronto.\n${resumoFalhas(veracidade.falhas)}`);

  let gate = 'não configurado em preparo.gateCv';
  if (preparo.gateCv) {
    try {
      const saidaGate = await executar('gateCv', { pdf: gerado.pdf }, opcoes);
      await gravarArquivo(join(pasta, 'gate.txt'), `${saidaGate.stdout}${saidaGate.stderr}`);
      gate = 'aprovado';
    } catch (error) {
      await gravarArquivo(join(pasta, 'gate.txt'), `${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
      throw erro(`o gate reprovou o CV (saída em ${join(pasta, 'gate.txt')}).`);
    }
  }

  await gravarArquivo(join(pasta, 'ficha.md'), ficha({ job, entry, variante, porque, lacunas, veracidade, gate, gupy, requisicoes: requisicoes() }));
  const pacote = { versao: 1, id: canonico, variante: variante.id, porque, pdf: gerado.pdf,
    pdfSha256: sha256(await readFile(gerado.pdf)), requisicoesDeRede: requisicoes(), preparadoEm: new Date().toISOString(),
    textoGupy: gupy ? { caracteres: gupy.caracteres } : null };
  // Por último: pacote.json só existe quando tudo passou.
  await gravarJson(join(pasta, 'pacote.json'), pacote);
  return { pasta, pacote };
}

/** Confere que o PDF do pacote ainda é o que passou na veracidade e no gate (17.16). */
export async function conferirPacote({ dataDir, state, id }) {
  const canonico = idCanonico(state, id);
  if (!canonico) throw erro('Vaga não encontrada no estado.', 2);
  const pasta = pastaSegura(dataDir, canonico);
  const pacote = await lerJsonOuNada(join(pasta, 'pacote.json'));
  if (!pacote) throw erro('sem pacote.json para esta vaga: rode o preparar.');
  if (typeof pacote.pdf !== 'string' || typeof pacote.pdfSha256 !== 'string') throw erro('pacote.json sem pdf ou sem pdfSha256 (versão anterior): refaça o preparar.');
  const dentro = relative(resolve(pasta), resolve(pacote.pdf));
  if (!isAbsolute(pacote.pdf) || dentro === '' || isAbsolute(dentro) || dentro === '..' || dentro.startsWith(`..${sep}`)) {
    throw erro('o pdf de pacote.json está fora da pasta da vaga: refaça o preparar.');
  }
  let bytes;
  try { bytes = await readFile(pacote.pdf); }
  catch (error) {
    if (error.code === 'ENOENT') throw erro('o PDF do pacote não existe mais: refaça o preparar.');
    throw error;
  }
  if (sha256(bytes) !== pacote.pdfSha256) throw erro('PDF mudou depois do preparo: refaça o preparar.');
  return { pdf: pacote.pdf };
}
