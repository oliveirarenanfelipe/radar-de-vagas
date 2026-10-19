import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/radar.mjs';

// T31: a skill de onboarding guia perfil, busca, preparo opcional e conexões opcionais (docs/spec.md, 31.1 a 31.6).
const SKILL = new URL('../skills/onboarding/SKILL.md', import.meta.url);
const AVISO = 'A conta pode ser restringida; use uma conta secundária, nunca a principal; o login é seu, numa janela que você abre; a ferramenta nunca manda mensagem, convite nem candidatura; o servidor MCP é de terceiro (Apache-2.0) e é instalado à parte.';
const ler = async () => (await readFile(SKILL, 'utf8')).replace(/\r\n/g, '\n');
// Posição de cada marca no texto; -1 reprova.
const posicao = (texto, marca) => {
  const i = texto.indexOf(marca);
  assert.ok(i >= 0, `marca ausente na skill: ${marca}`);
  return i;
};

test('31.1 os passos aparecem na ordem: perfil, busca com filtro, preparo opcional, conexões opcionais; a skill grava pela pessoa', async () => {
  const texto = await ler();
  const ordem = ['Grave `perfil.md`', 'Grave JSON válido em `search`', 'grave em `filtro` da busca', 'Preparo (opcional)', 'Conexões opcionais']
    .map(marca => posicao(texto, marca));
  assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b), `ordem: ${ordem}`);
  assert.match(texto, /Você grava os arquivos pela pessoa; ela não edita nada à mão\./);
  assert.match(texto, /vale a skill\s+`curriculo-por-vaga`/);
});

test('31.2 e 31.6 o aviso de risco vem inteiro, palavra por palavra, antes do passo do LinkedIn logado, com "aceito"', async () => {
  const texto = await ler();
  const aviso = posicao(texto, `"${AVISO}"`);
  assert.ok(aviso < posicao(texto, 'Se aceitar:'), 'o aviso tem de vir antes do ramo que segue');
  assert.ok(aviso < posicao(texto, 'Se recusar:'));
  assert.match(texto.slice(0, aviso), /siga só se a pessoa responder "aceito":\n\s*$/);
  assert.ok(texto.includes('A ferramenta nunca envia candidatura'));
});

test('31.3 recusar o LinkedIn mantém a fonte linkedin-logado desligada e nenhum passo a liga', async () => {
  const texto = await ler();
  const recusa = texto.slice(posicao(texto, 'Se recusar:'), posicao(texto, 'Telegram (aprovar'));
  assert.match(recusa, /`linkedin-logado` fica desligada/);
  assert.doesNotMatch(recusa, /\bligu|\bligar|\bative|\bativar|: true/i);
  const aceite = texto.slice(posicao(texto, 'Se aceitar:'), posicao(texto, 'Se recusar:'));
  assert.match(aceite, /não ligue nada agora/);
});

test('31.4 o passo do Telegram pede bot exclusivo, configurar-telegram no terminal dela e proíbe colar o token', async () => {
  const texto = await ler();
  const telegram = texto.slice(posicao(texto, 'Telegram (aprovar'), posicao(texto, '14. '));
  assert.match(telegram, /bot exclusivo/);
  assert.match(telegram, /`node bin\/radar\.mjs configurar-telegram`/);
  assert.match(telegram, /terminal dela/);
  assert.match(telegram, /nunca cole o token na conversa com o agente/);
});

test('31.5 configurar-telegram sem terminal sai 2 e não grava nada; token fora do formato sai 2', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'radar-onboarding-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const err = [];
  const base = { dataDir, stdout() {}, stderr: texto => err.push(texto), fetch: async () => { throw new Error('rede proibida no teste'); } };
  assert.equal(await main(['configurar-telegram'], { ...base, io: { isTTY: false, perguntar: async () => '', escrever() {} } }), 2);
  assert.match(err.join('\n'), /só pela pessoa, no terminal/);
  const naPasta = async () => (await readdir(dataDir)).filter(nome => nome.startsWith('telegram'));
  assert.deepEqual(await naPasta(), []);
  const io = { isTTY: true, perguntar: async () => '123:curto', perguntarSegredo: async () => '123:curto', escrever() {} };
  assert.equal(await main(['configurar-telegram'], { ...base, io }), 2);
  assert.deepEqual(await naPasta(), []);
});
