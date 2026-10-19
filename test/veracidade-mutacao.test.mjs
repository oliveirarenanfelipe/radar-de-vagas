import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verificar } from '../src/preparo/veracidade.mjs';

// Mutação F2.3 (docs/spec.md, T12): a pasta src/preparo/ inteira é copiada para a pasta temporária do sistema,
// a expressão marcada pelo sentinela vira `true`, e o caso que o original reprova passa a aprovar na cópia.
const PREPARO = fileURLToPath(new URL('../src/preparo/', import.meta.url));

async function copiaMutada(t, sentinela) {
  const pasta = await mkdtemp(join(tmpdir(), 'radar-mutacao-'));
  t.after(() => rm(pasta, { recursive: true, force: true }));
  await cp(PREPARO, pasta, { recursive: true });
  for (const nome of (await readdir(pasta)).filter(nome => nome.endsWith('.mjs'))) {
    const arquivo = join(pasta, nome);
    // Import para fora de src/preparo/ vira caminho absoluto; os de dentro continuam relativos e valendo.
    const fonte = (await readFile(arquivo, 'utf8')).replace(/from '(\.\.\/[^']+)'/g,
      (_, relativo) => `from '${pathToFileURL(resolve(dirname(join(PREPARO, nome)), relativo)).href}'`);
    await writeFile(arquivo, fonte);
  }
  const alvo = join(pasta, 'veracidade.mjs');
  const original = await readFile(alvo, 'utf8');
  const marca = new RegExp(`/\\* MUTACAO:${sentinela} \\*/[^;\\n]*;`, 'g');
  const achados = original.match(marca) ?? [];
  assert.equal(achados.length, 1, `sentinela MUTACAO:${sentinela} ausente ou repetido no original (mutação vazia não prova nada)`);
  const mutado = original.replace(marca, 'true;');
  assert.notEqual(mutado, original);
  await writeFile(alvo, mutado);
  return import(pathToFileURL(alvo).href);
}

const ALFA = { cargo: 'Analista de Operações', empresa: 'Alfa Fictícia Ltda.', periodo: 'Mar/2023 – Mar/2026', local: 'Cidade Inventada', aliases: ['Alfa'] };
const PERFIL = 'Analista de operações com foco em campo. Reduzo custos em 12% ao ano.';
const fatos = {
  versao: 1, base: 'ana_ficticia', experiencias: [ALFA],
  formacao: [{ titulo: 'Bacharelado em Engenharia', instituicao: 'Universidade Gama Inventada', periodo: '2010 – 2014' }],
  cursos: ['Curso Inventado'], idiomas: [{ idioma: 'Inglês', nivel: 'Avançado' }],
  textoLivre: [{ secao: 'perfil', texto: PERFIL }, { secao: 'experiencia', texto: 'Reduzi perdas em 14% na manutenção' }],
};
const declarado = ({ cargo = ALFA.cargo, perfil = PERFIL } = {}) => ({
  versao: 1, experiencias: [{ cargo, empresa: ALFA.empresa, periodo: ALFA.periodo, local: ALFA.local }],
  formacao: fatos.formacao, cursos: fatos.cursos, idiomas: fatos.idiomas,
  textoLivre: [{ secao: 'titulo', texto: 'Analista de operações' }, { secao: 'perfil', texto: perfil }],
});
// 12.2: cargo promovido no bloco, texto livre sem termo de hierarquia. 12.5: frase inventada no perfil.
const caso122 = declarado({ cargo: 'Coordenador Sênior' });
const caso125 = declarado({ perfil: `${PERFIL}\nReduzi custos em 90% no primeiro ano` });

test('mutação MUTACAO:cargo → true: o 12.2 passa na cópia e reprova no original', async t => {
  const original = verificar(caso122, fatos);
  assert.deepEqual(original.falhas.map(falha => falha.checagem), ['cargo']);
  const mutante = await copiaMutada(t, 'cargo');
  assert.deepEqual(mutante.verificar(caso122, fatos), { aprovado: true, falhas: [], frasesNovas: [] });
});

test('mutação MUTACAO:frase → true: o 12.5 passa na cópia e reprova no original', async t => {
  const original = verificar(caso125, fatos);
  assert.deepEqual(original.falhas.map(falha => falha.checagem), ['frase-nova']);
  const mutante = await copiaMutada(t, 'frase');
  assert.deepEqual(mutante.verificar(caso125, fatos), { aprovado: true, falhas: [], frasesNovas: [] });
});
