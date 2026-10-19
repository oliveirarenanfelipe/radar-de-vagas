// Texto da Gupy (docs/spec.md §3, T13): só conta. A veracidade do texto é da T12 (seção `gupy`, 12.33),
// chamada pelo `preparar` (17.4); a impressão e o código de saída do `contar-gupy` são da T17.

export const TETO_GUPY = 1500;

/**
 * Conta o texto como o formulário da Gupy contaria no pior caso (PREMISSA 16: espaços e quebras de linha contam).
 * Antes de contar: `\r\n` vira `\n` e o texto vai para NFC. Conta o maior entre pontos de código e unidades UTF-16.
 * → `{ caracteres, aprovado: true }` até o teto; acima dele ou vazio, `{ caracteres, aprovado: false, motivo }`.
 */
export function contarGupy(texto) {
  if (typeof texto !== 'string') throw new TypeError('O texto da Gupy precisa ser uma string.');
  const normal = texto.replace(/\r\n/g, '\n').normalize('NFC');
  const caracteres = Math.max([...normal].length, normal.length);
  if (normal.trim() === '') return { caracteres, aprovado: false, motivo: 'texto vazio' };
  if (caracteres > TETO_GUPY) return { caracteres, aprovado: false, motivo: `${caracteres} caracteres (teto ${TETO_GUPY})` };
  return { caracteres, aprovado: true };
}
