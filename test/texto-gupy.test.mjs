import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TETO_GUPY, contarGupy } from '../src/preparo/texto-gupy.mjs';

// Pasta temporária: cada texto nasce num arquivo, por código, com conteúdo inventado, e é lido de volta como o comando leria.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-gupy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let n = 0;
  const ler = async conteudo => {
    const arquivo = join(dir, `texto-${n++}.txt`);
    await writeFile(arquivo, conteudo, 'utf8');
    return readFile(arquivo, 'utf8');
  };
  return { ler };
}

test('13.1 teto da Gupy: 1.500 caracteres passa, 1.501 reprova', async t => {
  const { ler } = await setup(t);
  assert.equal(TETO_GUPY, 1500);
  assert.deepEqual(contarGupy(await ler('a'.repeat(1500))), { caracteres: 1500, aprovado: true });
  const acima = contarGupy(await ler('a'.repeat(1501)));
  assert.equal(acima.caracteres, 1501);
  assert.equal(acima.aprovado, false);
  assert.match(acima.motivo, /1501 caracteres \(teto 1500\)/);
  // Espaço e quebra de linha contam (PREMISSA 16): 1.499 letras + "\n" = 1.500; + " " = 1.501.
  assert.deepEqual(contarGupy(await ler(`${'b'.repeat(1499)}\n`)), { caracteres: 1500, aprovado: true });
  assert.equal(contarGupy(await ler(`${'b'.repeat(1499)}\n `)).aprovado, false);
});

test('13.2 NFC antes de contar e o pior caso entre pontos de código e unidades UTF-16', async t => {
  const { ler } = await setup(t);
  const decomposto = 'ç'; // "ç" em NFD: 2 pontos de código, 1 depois de NFC
  assert.equal(contarGupy(await ler(decomposto)).caracteres, 1);
  assert.deepEqual(contarGupy(await ler(`${decomposto}${'a'.repeat(1499)}`)), { caracteres: 1500, aprovado: true });
  const emoji = '\u{1F600}'; // fora do plano básico: 1 ponto de código, 2 unidades UTF-16
  assert.equal(contarGupy(await ler(emoji)).caracteres, 2);
  // 1.499 pontos de código, 1.500 unidades UTF-16: passa no limite; uma letra a mais reprova pelo pior caso.
  assert.deepEqual(contarGupy(await ler(`${emoji}${'a'.repeat(1498)}`)), { caracteres: 1500, aprovado: true });
  assert.equal(contarGupy(await ler(`${emoji}${'a'.repeat(1499)}`)).aprovado, false);
});

test('13.3 "\\r\\n" vira "\\n" antes de contar', async t => {
  const { ler } = await setup(t);
  assert.equal(contarGupy(await ler('linha um\r\nlinha dois')).caracteres, 'linha um\nlinha dois'.length);
  // 750 quebras CRLF: 1.500 depois de virar LF (2.250 sem a troca).
  assert.deepEqual(contarGupy(await ler('\r\na'.repeat(750))), { caracteres: 1500, aprovado: true });
});

test('13.4 arquivo vazio ou só espaços reprova com "texto vazio"', async t => {
  const { ler } = await setup(t);
  for (const conteudo of ['', '   ', '\r\n\t \n']) {
    const resultado = contarGupy(await ler(conteudo));
    assert.equal(resultado.aprovado, false, JSON.stringify(conteudo));
    assert.equal(resultado.motivo, 'texto vazio');
  }
  assert.throws(() => contarGupy(undefined), /precisa ser uma string/);
});
