// Partição em frases, chave de frase e normalizações do preparo (docs/spec.md, T11; T12 itens 1 e 2).
// Fonte única: contrato.mjs (chave das frases aprovadas) e veracidade.mjs (T12) importam daqui e não reimplementam.

const TRACOS = /[‐-―−﹘﹣－]/g;

/** NFC, sem acento, minúsculo, traços unificados em "-" e espaços colapsados. */
export function normalizarTexto(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC')
    .toLowerCase().replace(TRACOS, '-').replace(/\s+/g, ' ').trim();
}

// Sufixo societário só como palavra inteira no fim; repetido até não sobrar ("Alfa Ltda ME").
const SUFIXO = /(?:^|\s)(?:ltda|eireli|s\/a|s a|sa|me|epp|inc|llc)$/;

/** normalizarTexto, sem "." e ",", e sem os sufixos societários do fim ("Alfa Fictícia S.A." vira "alfa ficticia"). */
export function normalizarEmpresa(texto) {
  let nome = normalizarTexto(String(texto ?? '').replace(/[.,]/g, ' '));
  while (SUFIXO.test(nome)) nome = nome.replace(SUFIXO, '').trim();
  return nome;
}

const MESES = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8,
  set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
const ATUAL = ['atual', 'present', 'em andamento', 'in progress', 'cursando'];

function ponta(texto, lado) {
  if (/^\d{4}$/.test(texto)) return `${texto}-${lado === 'inicio' ? '01' : '12'}`;
  const mes = /^([a-z]{3})\/(\d{4})$/.exec(texto);
  if (mes && MESES[mes[1]]) return `${mes[2]}-${String(MESES[mes[1]]).padStart(2, '0')}`;
  if (lado === 'fim' && ATUAL.includes(texto)) return 'atual';
  return null;
}

/**
 * "Mar/2023 – Mar/2026", "2010 – 2014", "2014", "Jan/2025 - Atual" → { inicio: "AAAA-MM", fim: "AAAA-MM" | "atual" }.
 * Formato não reconhecido lança erro em português: nunca chuta.
 */
export function normalizarPeriodo(texto) {
  const normal = normalizarTexto(texto);
  const partes = normal.split(/\s*-\s*/);
  const erro = () => new Error(`Período não reconhecido: "${String(texto ?? '')}". Use Mmm/AAAA – Mmm/AAAA, AAAA – AAAA, AAAA ou "Atual" no fim.`);
  if (partes.length === 1) {
    if (!/^\d{4}$/.test(normal)) throw erro();
    return { inicio: ponta(normal, 'inicio'), fim: ponta(normal, 'fim') };
  }
  if (partes.length !== 2) throw erro();
  const inicio = ponta(partes[0], 'inicio'), fim = ponta(partes[1], 'fim');
  if (!inicio || !fim || (fim !== 'atual' && fim < inicio)) throw erro();
  return { inicio, fim };
}

// Marcador de lista no começo do pedaço: símbolo, ou número de 1 ou 2 dígitos com "." ou ")" e espaço ("2024. " não é).
const MARCADOR = /^(?:[-–—*>]\s*|\d{1,2}[.)]\s+)/;
const temConteudo = texto => /[\p{L}\p{N}]/u.test(texto);

/**
 * Frases de um texto, agrupadas por linha (a unidade de comparação da T12 nunca atravessa linha).
 * Ordem: (a) linha; (b) ";", "|", "•", "·"; (c) marcador de lista; (d) ".", "!" ou "?" seguidos de espaço ou do fim.
 * Pedaço vazio ou só com pontuação é descartado; linha sem frase não entra.
 */
export function partirLinhas(texto) {
  const linhas = [];
  for (const linha of String(texto ?? '').split(/\r\n|\r|\n/)) {
    const frases = [];
    for (const pedaco of linha.split(/[;|•·]/)) {
      const semMarcador = pedaco.trim().replace(MARCADOR, '');
      for (const frase of semMarcador.split(/(?<=[.!?])(?=\s|$)/)) {
        const limpa = frase.trim();
        if (temConteudo(limpa)) frases.push(limpa);
      }
    }
    if (frases.length) linhas.push(frases);
  }
  return linhas;
}

/** Todas as frases do texto, na ordem. */
export function partirFrases(texto) {
  return partirLinhas(texto).flat();
}

/** Linhas de frases de uma seção do textoLivre: os itens da mesma seção unidos com "\n" (frase nunca atravessa itens). */
export function partirSecao(textoLivre, secao) {
  return partirLinhas((textoLivre ?? []).filter(item => item.secao === secao).map(item => item.texto).join('\n'));
}

/** normalizarTexto, sem marcador de lista inicial e sem pontuação final (". ! ? : ; ," e espaços, repetidamente). */
export function chaveFrase(frase) {
  return normalizarTexto(frase).replace(MARCADOR, '').replace(/[.!?:;,\s]+$/, '');
}

/**
 * Ponto de código do 1º caractere de controle no texto, como "U+001B"; null se não houver. Conta como controle
 * Cc, Cf e os separadores de linha e de parágrafo (Zl U+2028, Zp U+2029), que quebram a linha na tela.
 */
export function pontoDeControle(texto) {
  const achado = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.exec(String(texto ?? ''));
  return achado ? `U+${achado[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : null;
}
