// Escolha das 5 vagas da F2.5 (docs/spec.md, T16, 16.3 a 16.6; PREMISSA 17 do PRD).
// Função pura sobre entradas no formato de toJobs/toDay (src/page/view.mjs): { id, job, seen, triage, mark }.
//
// Elegível: com triagem (sem estrela não há encaixe para comparar), sem marcação (inscrevi/descartar) e não
// cortada pelo filtro (entrada de `cortadas` do toDay, com `motivo`). Ordem: estrelas, publicação mais recente
// (sem data vai para o fim), id. Restrições: ≥1 da Gupy e ≥2 fontes; cada uma corrigida trocando a pior das
// escolhidas pela melhor elegível que falta. Restrição que não fecha com elegíveis devolve ok: false com o que
// dá; nunca completa com vaga de fora da regra.

export const FONTE_GUPY = 'gupy';

const porTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ehGupy = entrada => entrada.job.source === FONTE_GUPY;
const fontes = lista => new Set(lista.map(entrada => entrada.job.source)).size;

function ordem(a, b) {
  const pa = a.job.publishedAt ?? '', pb = b.job.publishedAt ?? '';
  return b.triage.fit - a.triage.fit || porTexto(pb, pa) || porTexto(a.id, b.id);
}

function elegivel(entrada) {
  return Number.isInteger(entrada?.triage?.fit) && !entrada.mark && !entrada.motivo && entrada.passa !== false;
}

// Mesma janela do toDay, estendida para as últimas N rodadas: o que entrou até o fim da rodada anterior à
// janela fica de fora.
function dentroDaJanela(entradas, rounds, rodadas) {
  if (!Number.isInteger(rodadas) || rodadas < 1) throw new RangeError('rodadas precisa ser um inteiro maior que 0.');
  if (!Array.isArray(rounds) || rounds.length === 0) throw new TypeError('rodadas pede a lista de rodadas (rounds).');
  const primeira = rounds.at(-Math.min(rodadas, rounds.length)), ultima = rounds.at(-1);
  const antes = rodadas < rounds.length ? rounds.at(-rodadas - 1) : null;
  return entradas.filter(({ seen }) => seen?.firstSeenAt >= primeira.inicio && seen.firstSeenAt <= ultima.fim &&
    !(antes && seen.firstSeenAt <= antes.fim));
}

// Tira a pior das escolhidas que pode sair (`podeSair`) e põe `entra` no lugar.
function trocar(escolhidas, entra, podeSair) {
  for (let i = escolhidas.length - 1; i >= 0; i--) {
    if (!podeSair(escolhidas[i], escolhidas)) continue;
    const nova = escolhidas.filter((_, j) => j !== i);
    nova.push(entra);
    return nova.sort(ordem);
  }
  return escolhidas;
}

/**
 * { ok, selecionadas, faltam, restricaoFalhou } — `restricaoFalhou` é "gupy", "fontes" ou null.
 * `faltam` conta as vagas que faltaram para chegar a `quantidade` por não haver elegíveis (não muda `ok`).
 * `rodadas` (com `rounds`, a lista de rodadas.json) limita às vagas das últimas N rodadas.
 */
export function selecionar(entradas, { quantidade = 5, rodadas, rounds } = {}) {
  if (!Array.isArray(entradas)) throw new TypeError('entradas precisa ser uma lista.');
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new RangeError('quantidade precisa ser um inteiro maior que 0.');
  const janela = rodadas === undefined ? entradas : dentroDaJanela(entradas, rounds, rodadas);
  const ordenadas = janela.filter(elegivel).sort(ordem);
  let escolhidas = ordenadas.slice(0, quantidade);
  const fora = () => ordenadas.filter(entrada => !escolhidas.includes(entrada));

  if (!escolhidas.some(ehGupy)) {
    const gupy = fora().find(ehGupy);
    if (gupy) escolhidas = trocar(escolhidas, gupy, () => true);
  }
  if (fontes(escolhidas) < 2 && escolhidas.length) {
    const outra = fora().find(entrada => entrada.job.source !== escolhidas[0].job.source);
    // A troca de fonte não pode tirar a única Gupy.
    if (outra) escolhidas = trocar(escolhidas, outra, (sai, lista) => !ehGupy(sai) || lista.filter(ehGupy).length > 1);
  }

  const restricaoFalhou = !escolhidas.some(ehGupy) ? 'gupy' : fontes(escolhidas) < 2 ? 'fontes' : null;
  return { ok: restricaoFalhou === null, selecionadas: escolhidas, faltam: quantidade - escolhidas.length, restricaoFalhou };
}
