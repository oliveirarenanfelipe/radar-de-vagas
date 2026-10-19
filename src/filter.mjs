// Filtro configurado pela pessoa em busca.json.filtro, aplicado na leitura, depois da coleta.
// Função pura: sem estado, rede, disco ou relógio. O veredito nunca é gravado; a cortada
// continua visível com o motivo (docs/spec.md, T6 e decisão C1).
//
// Cada parte ausente do filtro não corta nada naquela dimensão:
// - sem `local`, presencial e híbrida passam em qualquer lugar;
// - sem `remoto`, a remota passa em qualquer país;
// - o título só corta com `titulo.ligado === true` (armadilha 3: na dúvida, mostrar).
//
// Remota só é cortada por país com sinal EXPLÍCITO de país estrangeiro (PREMISSA S5): a lista
// fechada PAISES_ESTRANGEIROS abaixo. Precedência do local: UF > Brasil > região > país estrangeiro.
// Região que inclui o Brasil vence o país citado junto ("LATAM, México" passa com alerta).
// Texto sem nenhum desses sinais ("Recife", "Lisboa") é "nao-identificado": a remota passa com o
// alerta "pais-nao-identificado"; presencial e híbrida continuam julgadas pelo local.

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

// Nome de estado também é UF. "Pará" só casa com acento, porque sem acento é a preposição.
const ESTADOS = [
  ['acre', 'AC'], ['alagoas', 'AL'], ['amapá', 'AP'], ['amazonas', 'AM'], ['bahia', 'BA'], ['ceará', 'CE'],
  ['distrito federal', 'DF'], ['federal district', 'DF'], ['espírito santo', 'ES'], ['goiás', 'GO'],
  ['maranhão', 'MA'], ['mato grosso', 'MT'], ['mato grosso do sul', 'MS'], ['minas gerais', 'MG'], ['pará', 'PA'],
  ['paraíba', 'PB'], ['paraná', 'PR'], ['pernambuco', 'PE'], ['piauí', 'PI'], ['rio de janeiro', 'RJ'],
  ['rio grande do norte', 'RN'], ['rio grande do sul', 'RS'], ['rondônia', 'RO'], ['roraima', 'RR'],
  ['santa catarina', 'SC'], ['são paulo', 'SP'], ['sergipe', 'SE'], ['tocantins', 'TO'],
].map(([nome, uf]) => ({ uf, comAcento: nome === 'pará', palavras: palavras(nome, nome === 'pará') }))
  // O nome mais longo vence: "mato grosso do sul" não pode virar também "mato grosso".
  .sort((a, b) => b.palavras.length - a.palavras.length);

const BRASIL = [['brasil'], ['brazil']];
const frases = nomes => nomes.map(nome => palavras(nome));
const REGIONAL = frases(['latam', 'américa latina', 'latin america', 'south america', 'américa do sul', 'americas',
  'worldwide', 'global', 'anywhere']);
// Fechada de propósito; "França" fica de fora porque Franca é cidade de SP. "US" só em maiúsculas.
const PAISES_ESTRANGEIROS = frases(['united states', 'usa', 'eua', 'estados unidos', 'canada', 'canadá', 'mexico', 'méxico',
  'argentina', 'chile', 'colombia', 'colômbia', 'peru', 'uruguay', 'uruguai', 'paraguay', 'paraguai', 'nicaragua',
  'costa rica', 'portugal', 'spain', 'espanha', 'uk', 'united kingdom', 'reino unido', 'england', 'inglaterra',
  'ireland', 'irlanda', 'germany', 'alemanha', 'france', 'netherlands', 'holanda', 'poland', 'polônia', 'india',
  'índia', 'europe', 'europa']);
const SO_REMOTO = /\b(?:home office|remoto|remota|remote)\b/g;

// Palavras em minúsculas; sem acento, salvo quando o acento desfaz uma ambiguidade.
function palavras(value, manterAcento = false) {
  const texto = typeof value === 'string' ? value.normalize('NFC') : '';
  const base = manterAcento ? texto : texto.normalize('NFD').replace(/\p{Mn}/gu, '');
  return base.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Posição em que `trecho` aparece como sequência de palavras inteiras a partir de `inicio`, ou -1.
function posicao(lista, trecho, inicio = 0) {
  if (trecho.length === 0) return -1;
  for (let i = inicio; i + trecho.length <= lista.length; i++) {
    if (trecho.every((palavra, j) => lista[i + j] === palavra)) return i;
  }
  return -1;
}
const contem = (lista, trecho) => posicao(lista, trecho) !== -1;

function ufsPorNome(texto) {
  const sem = palavras(texto), com = palavras(texto, true);
  const achadas = [];
  for (let i = 0; i < sem.length; i++) {
    const estado = ESTADOS.find(e => posicao(e.comAcento ? com : sem, e.palavras, i) === i);
    if (!estado) continue;
    achadas.push(estado.uf);
    i += estado.palavras.length - 1;
  }
  return achadas;
}

/**
 * Classifica o texto de local sem gravar nada.
 * tipo: "vazio" | "brasil" | "regional" | "outro-pais" | "sem-pais" | "nao-identificado";
 * `ufs` só tem itens em "brasil". A sigla em maiúsculas decide; sem sigla, vale o nome do estado.
 * "sem-pais" é só palavra de remoto ("Remoto", "Home office"); "outro-pais" exige país da lista fechada.
 */
export function classificarLocal(location) {
  const texto = typeof location === 'string' ? location.trim() : '';
  if (!texto) return { tipo: 'vazio', ufs: [] };
  const tokens = texto.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const siglas = tokens.filter(token => UFS.includes(token));
  const ufs = [...new Set(siglas.length ? siglas : ufsPorNome(texto))];
  if (ufs.length) return { tipo: 'brasil', ufs };
  const ditas = palavras(texto);
  if (tokens.includes('BR') || BRASIL.some(nome => contem(ditas, nome))) return { tipo: 'brasil', ufs: [] };
  if (REGIONAL.some(nome => contem(ditas, nome))) return { tipo: 'regional', ufs: [] };
  if (tokens.includes('US') || PAISES_ESTRANGEIROS.some(nome => contem(ditas, nome))) return { tipo: 'outro-pais', ufs: [] };
  if (ditas.join(' ').replace(SO_REMOTO, '').trim() === '') return { tipo: 'sem-pais', ufs: [] };
  return { tipo: 'nao-identificado', ufs: [] };
}

// A lista de cidades só vale quando o texto não traz UF.
function dentroDoLocal(location, local, classe) {
  if (classe.ufs.length) return classe.ufs.some(uf => (local.ufs ?? []).includes(uf));
  const lista = palavras(location);
  return (local.cidades ?? []).some(cidade => contem(lista, palavras(cidade)));
}

/**
 * Veredito do filtro para uma vaga: { passa, motivo, alertas }.
 * Ordem: local/modelo, depois título; a cortada leva só o primeiro motivo.
 * Motivos: "fora-do-local", "remota-fora-do-pais", "titulo-sem-termo".
 * Alertas: "local-nao-informado", "modelo-nao-informado", "remota-regional", "pais-nao-identificado".
 */
export function aplicarFiltro(job, filtro, termos = []) {
  const alertas = [];
  const corta = motivo => ({ passa: false, motivo, alertas });
  if (filtro == null) return { passa: true, motivo: null, alertas };

  const classe = classificarLocal(job.location);
  const remota = job.workModel === 'remote' && filtro.remoto !== 'nao';
  if (classe.tipo === 'vazio') {
    // Sem local não há o que comparar: mostra e avisa, em qualquer modelo.
    if (filtro.local || filtro.remoto) alertas.push('local-nao-informado');
  } else if (remota) {
    if (filtro.remoto === 'brasil') {
      if (classe.tipo === 'regional') alertas.push('remota-regional');
      else if (classe.tipo === 'outro-pais') return corta('remota-fora-do-pais');
      // Cidade da lista conta como Brasil mesmo sem UF; outra cidade sem UF passa e avisa.
      else if (classe.tipo === 'nao-identificado' && !(filtro.local && dentroDoLocal(job.location, filtro.local, classe))) {
        alertas.push('pais-nao-identificado');
      }
    }
  } else if (filtro.local && !dentroDoLocal(job.location, filtro.local, classe)) {
    // Modelo desconhecido não é presencial declarado (PREMISSA S1).
    if (job.workModel == null) alertas.push('modelo-nao-informado');
    else return corta('fora-do-local');
  }

  if (filtro.titulo?.ligado === true) {
    const buscados = [...termos, ...(filtro.titulo.sinonimos ?? [])].map(termo => palavras(termo)).filter(t => t.length);
    const titulo = palavras(job.title);
    // Termo só com pontuação não vira "nenhum termo casa" e não corta tudo.
    if (buscados.length && !buscados.some(termo => contem(titulo, termo))) return corta('titulo-sem-termo');
  }
  return { passa: true, motivo: null, alertas };
}
