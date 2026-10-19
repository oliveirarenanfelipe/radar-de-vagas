// Variante de CV que melhor cobre a vaga (docs/spec.md, T16, 16.1 e 16.2).
// Função pura: sem disco, rede ou relógio. A mesma entrada dá sempre a mesma saída.
//
// Texto da variante: `titulo`, `perfil` e cada item de `habilidades`, unidos com `\n` só para contar termos
// (contrato do preparo). Pontos = 3 por termo do título da vaga coberto + 1 por termo da descrição coberto.
// Termo da descrição que já está no título conta só no título (não soma 3 + 1 pela mesma palavra).
// Variante bloqueada na veracidade nunca entra na lista (18.2: a escolha automática nunca a seleciona).

import { normalizarTexto } from './frases.mjs';

export const PESO_TITULO = 3;
export const PESO_DESCRICAO = 1;

// Palavras vazias em português e inglês: não dizem nada sobre o encaixe.
const VAZIAS = new Set(`a ao aos as com como da das de do dos e em entre na nas no nos o os ou para pela pelas pelo
pelos por que se sem sob sobre um uma umas uns nossa nosso nossas nossos sua seu suas seus voce voces ser estar
ter mais muito muita ja nao sim isso esta este essa esse and an at by for from in of on or the to with our your
you we is are be as it its this that will`.split(/\s+/).filter(Boolean));

/** Termos distintos, na ordem em que aparecem: sem acento, minúsculos, sem palavras vazias. */
export function termos(texto) {
  const vistos = new Set();
  for (const termo of normalizarTexto(texto).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!VAZIAS.has(termo)) vistos.add(termo);
  }
  return [...vistos];
}

function textoDaVariante(variante) {
  const habilidades = Array.isArray(variante.habilidades) ? variante.habilidades : [];
  return [variante.titulo, variante.perfil, ...habilidades].join('\n');
}

const porId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ordena as variantes para a vaga: [{ id, pontos, casados: { titulo, descricao }, lacunas, porque }].
 * Desempate pelo id (comparação de código, não de localidade). `lacunas` são os termos do título da vaga
 * que a variante não cobre. `bloqueadas`: ids (lista ou Set) que nunca aparecem no resultado.
 */
export function classificarVariantes(job, variantes, { bloqueadas = [] } = {}) {
  if (!Array.isArray(variantes)) throw new TypeError('variantes precisa ser uma lista.');
  const fora = new Set(bloqueadas);
  const doTitulo = termos(job?.title);
  const daDescricao = termos(job?.description).filter(termo => !doTitulo.includes(termo));
  return variantes.filter(variante => !fora.has(variante.id)).map(variante => {
    const cobertos = new Set(termos(textoDaVariante(variante)));
    const titulo = doTitulo.filter(termo => cobertos.has(termo));
    const descricao = daDescricao.filter(termo => cobertos.has(termo));
    const lacunas = doTitulo.filter(termo => !cobertos.has(termo));
    const pontos = PESO_TITULO * titulo.length + PESO_DESCRICAO * descricao.length;
    const porque = `Título: ${titulo.join(', ') || 'nenhum termo'}. Descrição: ${descricao.join(', ') || 'nenhum termo'}. ` +
      `Lacunas do título: ${lacunas.join(', ') || 'nenhuma'}.`;
    return { id: variante.id, pontos, casados: { titulo, descricao }, lacunas, porque };
  }).sort((a, b) => b.pontos - a.pontos || porId(a.id, b.id));
}
