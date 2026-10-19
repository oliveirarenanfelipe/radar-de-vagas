// Ponte de comando externo (docs/spec.md §3, T14): executa o comando declarado em busca.json.preparo por
// execFile, sem shell, e confere a resposta contra o contrato do preparo. Nenhum texto da vaga entra nos
// argumentos: só a variante, a pasta e o PDF, cada um validado antes de executar.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validarDeclarado, validarFatos } from './contrato.mjs';

export const PRAZO_MS = 180_000;
export const SAIDA_MAXIMA = 5 * 1024 * 1024;
export const OPERACOES = ['variantes', 'fatos', 'gerarCv', 'gateCv'];
const VALORES = { '{variante}': 'variante', '{pasta}': 'pasta', '{pdf}': 'pdf' };
const LINHAS_STDERR = 10;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const exactKeys = (value, keys) => isObject(value) && keys.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => keys.includes(key));
const primeirasLinhas = texto => String(texto ?? '').split(/\r?\n/).filter(linha => linha.trim()).slice(0, LINHAS_STDERR).join('\n');

// Resolve também os pais existentes, para que um atalho simbólico não leve a pasta para fora da área permitida.
async function caminhoFisico(caminho) {
  try {
    return await realpath(caminho);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pai = dirname(caminho);
    if (pai === caminho) throw error;
    return join(await caminhoFisico(pai), relative(pai, caminho));
  }
}

async function dentroDeCandidaturas(caminho, dataDir, rotulo) {
  if (typeof caminho !== 'string' || !isAbsolute(caminho)) throw new Error(`a ponte recusou: ${rotulo} precisa ser um caminho absoluto`);
  const raiz = await caminhoFisico(resolve(dataDir, 'candidaturas'));
  const alvo = await caminhoFisico(resolve(caminho));
  const dentro = relative(raiz, alvo);
  if (dentro === '' || isAbsolute(dentro) || dentro === '..' || dentro.startsWith(`..${sep}`)) {
    throw new Error(`a ponte recusou: ${rotulo} fora de <pasta de dados>/candidaturas/`);
  }
  return alvo;
}

// Só a variante, a pasta e o PDF chegam aos argumentos; qualquer outro campo (como a descrição da vaga) é recusado.
async function validarValores(valores, dataDir) {
  if (!isObject(valores)) throw new Error('a ponte recusou: valores precisam ser um objeto');
  const extras = Object.keys(valores).filter(key => !Object.values(VALORES).includes(key));
  if (extras.length) throw new Error(`a ponte recusou: campo não aceito nos argumentos: ${extras.join(', ')} (só variante, pasta e pdf)`);
  const prontos = {};
  if ('variante' in valores) {
    if (typeof valores.variante !== 'string' || !/^[a-z0-9-]+$/.test(valores.variante)) {
      throw new Error('a ponte recusou: variante precisa casar ^[a-z0-9-]+$');
    }
    prontos.variante = valores.variante;
  }
  if (('pasta' in valores || 'pdf' in valores) && !isText(dataDir)) throw new Error('a ponte recusou: pasta de dados não informada');
  if ('pasta' in valores) prontos.pasta = await dentroDeCandidaturas(valores.pasta, dataDir, 'pasta');
  if ('pdf' in valores) {
    prontos.pdf = await dentroDeCandidaturas(valores.pdf, dataDir, 'pdf');
    if (extname(prontos.pdf).toLowerCase() !== '.pdf') throw new Error('a ponte recusou: pdf precisa terminar em .pdf');
  }
  return prontos;
}

// Placeholder só substitui o argumento inteiro; placeholder no meio de um argumento é recusado, nunca trocado.
function montarArgs(operacao, comando, valores) {
  if (!isObject(comando) || !isText(comando.comando) || !Array.isArray(comando.args) || !comando.args.every(arg => typeof arg === 'string')) {
    throw new Error(`a ponte recusou: "preparo.${operacao}" precisa ser { comando, args }`);
  }
  if (/[\\/]/.test(comando.comando) && !isAbsolute(comando.comando)) {
    throw new Error(`a ponte recusou: "preparo.${operacao}" com comando relativo`);
  }
  return comando.args.map(arg => {
    if (Object.hasOwn(VALORES, arg)) {
      const nome = VALORES[arg];
      if (!(nome in valores)) throw new Error(`a ponte recusou: "preparo.${operacao}" usa ${arg}, que não foi informado`);
      return valores[nome];
    }
    if (/[{}]/.test(arg)) throw new Error(`a ponte recusou: argumento "${arg}" com placeholder fora do argumento inteiro`);
    return arg;
  });
}

function rodar(executarArquivo, operacao, comando, args, prazoMs) {
  const opcoes = { shell: false, windowsHide: true, timeout: prazoMs, maxBuffer: SAIDA_MAXIMA, encoding: 'utf8' };
  return new Promise((ok, falha) => {
    executarArquivo(comando, args, opcoes, (error, stdout, stderr) => {
      if (!error) return ok({ stdout, stderr });
      let mensagem;
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') mensagem = `a ponte (${operacao}) passou do limite de saída de ${SAIDA_MAXIMA / 1024 / 1024} MiB e foi encerrada`;
      else if (error.killed || error.signal) mensagem = `a ponte (${operacao}) passou do prazo de ${prazoMs / 1000} s e foi encerrada`;
      else if (typeof error.code === 'number') mensagem = `a ponte (${operacao}) saiu com código ${error.code}`;
      else mensagem = `não foi possível executar o comando da ponte (${operacao}): ${error.code ?? error.message}`;
      const linhas = primeirasLinhas(stderr);
      const erro = new Error(linhas ? `${mensagem}\n${linhas}` : mensagem);
      Object.assign(erro, { codigo: typeof error.code === 'number' ? error.code : null, stdout, stderr });
      falha(erro);
    });
  });
}

function conferirResposta(operacao, json, valores) {
  if (operacao === 'fatos') return validarFatos(json);
  if (operacao === 'variantes') {
    if (!exactKeys(json, ['versao', 'variantes']) || json.versao !== 1 || !Array.isArray(json.variantes)) {
      return ['esperado { versao: 1, variantes: [...] }'];
    }
    const problemas = [];
    json.variantes.forEach((item, i) => {
      if (!exactKeys(item, ['id', 'titulo', 'perfil', 'habilidades']) || typeof item.id !== 'string' || !/^[a-z0-9-]+$/.test(item.id) ||
          !isText(item.titulo) || !isText(item.perfil) || !Array.isArray(item.habilidades) || !item.habilidades.every(isText)) {
        problemas.push(`variantes[${i}] precisa ter só id (^[a-z0-9-]+$), titulo, perfil e habilidades (lista de textos)`);
      }
    });
    return problemas;
  }
  // gerarCv
  if (!exactKeys(json, ['versao', 'pdf', 'declarado']) || json.versao !== 1) return ['esperado { versao: 1, pdf, declarado }'];
  const problemas = [];
  if (typeof json.pdf !== 'string' || !isAbsolute(json.pdf) || resolve(dirname(json.pdf)) !== valores.pasta ||
      extname(json.pdf).toLowerCase() !== '.pdf') {
    problemas.push('"pdf" precisa ser um arquivo .pdf direto na pasta informada');
  }
  problemas.push(...validarDeclarado(json.declarado).map(problema => `declarado: ${problema}`));
  return problemas;
}

/**
 * Executa a operação declarada em `preparo` ('variantes', 'fatos', 'gerarCv' ou 'gateCv').
 * Devolve o JSON conferido; no 'gateCv' (o gate não emite JSON), devolve { stdout, stderr } do código 0.
 * Código ≠ 0, prazo estourado ou resposta fora do contrato viram erro em português.
 */
export async function executar(operacao, valores = {}, { preparo, dataDir, prazoMs = PRAZO_MS, executarArquivo = execFile } = {}) {
  if (!OPERACOES.includes(operacao)) throw new Error(`a ponte recusou: operação desconhecida "${operacao}"`);
  if (!isObject(preparo) || !(operacao in preparo)) throw new Error(`a ponte não está configurada: falta "preparo.${operacao}" em busca.json`);
  const prontos = await validarValores(valores, dataDir);
  const args = montarArgs(operacao, preparo[operacao], prontos);
  const { stdout, stderr } = await rodar(executarArquivo, operacao, preparo[operacao].comando, args, prazoMs);
  if (operacao === 'gateCv') return { stdout, stderr };
  let json;
  let problemas;
  try {
    json = JSON.parse(stdout);
    problemas = conferirResposta(operacao, json, prontos);
  } catch {
    problemas = ['a saída não é JSON'];
  }
  if (problemas.length) {
    const linhas = primeirasLinhas(stderr);
    throw new Error(`a ponte respondeu fora do contrato (${operacao}): ${problemas.join('; ')}${linhas ? `\nstderr:\n${linhas}` : ''}`);
  }
  return json;
}
