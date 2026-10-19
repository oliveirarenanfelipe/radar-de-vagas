import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EXCLUIR, INCLUIR, MAPEAMENTO } from '../scripts/exportar-publico.mjs';

// T32: README de produto, CLAUDE.md público, licenças e CI (docs/spec.md, 32.1 a 32.6). 32.7 é conferido num clone.
const raiz = fileURLToPath(new URL('..', import.meta.url));
const ler = async caminho => (await readFile(new URL(`../${caminho}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const CREDITO_PAINEL = 'Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media';

// Arquivos do índice e o que deles vai ao público (lista de dentro, por pasta ou por nome, mais os destinos do mapeamento).
const indice = () => execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8' }).split('\0').filter(Boolean);
const vai = caminho => INCLUIR.some(item => (item.endsWith('/') ? caminho.startsWith(item) : caminho === item));
function publico() {
  const arquivos = new Set(indice().filter(vai));
  for (const destino of Object.values(MAPEAMENTO)) arquivos.add(destino);
  return arquivos;
}

test('32.1 o README diz o que faz e o que não faz', async () => {
  const readme = await ler('README.md');
  assert.match(readme, /^## O que faz$/m);
  assert.match(readme, /^## O que não faz$/m);
  const faz = readme.slice(readme.indexOf('## O que faz'), readme.indexOf('## O que não faz'));
  for (const item of ['fontes abertas', 'LinkedIn', 'filtro', 'página do dia', 'veracidade', 'painel', 'aprovação', 'retorno']) {
    assert.ok(faz.toLowerCase().includes(item.toLowerCase()), `falta em "O que faz": ${item}`);
  }
  for (const frase of ['não envia candidatura', 'não loga pela pessoa', 'não manda mensagem']) assert.ok(readme.includes(frase), frase);
});

test('32.2 créditos: o upstream, o painel e o servidor MCP do LinkedIn como ferramenta externa', async () => {
  const readme = await ler('README.md');
  const aviso = await ler('THIRD_PARTY_NOTICES.md');
  for (const texto of [readme, aviso]) {
    assert.ok(texto.includes('Radar de Vagas, de Dhiego Spinillo (MIT), github.com/dspinillo/radar-de-vagas'), 'crédito do upstream');
    assert.ok(texto.includes(CREDITO_PAINEL), 'crédito do painel');
    assert.match(texto, /github\.com\/stickerdaniel\/linkedin-mcp-server/);
    assert.match(texto, /Apache-2\.0/);
  }
  // Nenhum arquivo do repo traz código do servidor MCP: ele é instalado à parte.
  assert.ok(!indice().some(caminho => /linkedin[-_]mcp|linkedin_mcp_server/i.test(caminho)));
});

test('32.3 a linha de copyright do upstream no LICENSE fica igual', async () => {
  const linhas = (await ler('LICENSE')).split('\n');
  assert.equal(linhas[2], 'Copyright (c) 2026 Dhiego Spinillo');
});

test('32.4 o .gitattributes fixa o fim de linha em LF', async () => {
  assert.match(await ler('.gitattributes'), /^\* text=auto eol=lf$/m);
});

// Caminhos de arquivo do repo citados num .md: entre crases, em link markdown e no mapa em árvore.
function citados(texto, conhecidos) {
  const achados = new Set();
  const candidato = bruto => {
    const limpo = bruto.trim().replace(/^\.\//, '').replace(/[#?].*$/, '');
    if (conhecidos.has(limpo) || conhecidos.has(limpo.replace(/\/$/, ''))) achados.add(limpo.replace(/\/$/, ''));
  };
  for (const [, dentro] of texto.matchAll(/`([^`\n]+)`/g)) candidato(dentro);
  for (const [, alvo] of texto.matchAll(/\]\(([^)\s]+)\)/g)) candidato(alvo);
  for (const [, nome] of texto.matchAll(/^[│ ]*[├└]── ([^\s#]+)/gm)) candidato(nome);
  return achados;
}

test('32.5 todo arquivo citado nos .md públicos vai ao público, e o CLAUDE.md público tem só a parte do upstream', async () => {
  const noIndice = indice();
  // No repo de trabalho o CLAUDE.md público mora em publico/CLAUDE.md; no repo exportado ele já é o CLAUDE.md
  // (o mapeamento foi aplicado) e não há CLAUDE.md da casa para comparar.
  const deTrabalho = noIndice.includes('publico/CLAUDE.md');
  const publicos = publico();
  // "Conhecidos" = arquivos e pastas do repo de trabalho e da lista de fora: só eles contam como citação de arquivo.
  const conhecidos = new Set([...noIndice, ...EXCLUIR.map(item => item.replace(/\/$/, '')), ...Object.values(MAPEAMENTO)]);
  for (const caminho of noIndice) for (let i = caminho.indexOf('/'); i > 0; i = caminho.indexOf('/', i + 1)) conhecidos.add(caminho.slice(0, i));
  const pastaPublica = pasta => [...publicos].some(arquivo => arquivo.startsWith(`${pasta}/`));
  const mds = [...publicos].filter(caminho => caminho.endsWith('.md'));
  const problemas = [];
  for (const md of mds) {
    const origem = (deTrabalho && Object.entries(MAPEAMENTO).find(([, destino]) => destino === md)?.[0]) || md;
    for (const citado of citados(await ler(origem), conhecidos)) {
      if (!publicos.has(citado) && !pastaPublica(citado)) problemas.push(`${md} cita ${citado}, que não vai ao público`);
    }
  }
  assert.deepEqual(problemas, []);

  const claude = await ler(deTrabalho ? 'publico/CLAUDE.md' : 'CLAUDE.md');
  for (const titulo of ['## Stack', '## Como rodar', '## Gotchas específicos']) assert.ok(!claude.includes(titulo), titulo);
  assert.ok(!claude.includes('mente soberana') && !claude.includes('Projeto/CLAUDE.md'));
  const secao = (texto, titulo) => {
    const inicio = texto.indexOf(`${titulo}\n`);
    assert.ok(inicio >= 0, `seção ausente: ${titulo}`);
    const fim = texto.indexOf('\n## ', inicio + titulo.length);
    return texto.slice(inicio, fim < 0 ? undefined : fim).trim();
  };
  for (const titulo of ['## Usar não é implementar', '## Privacidade (regra dura)']) {
    const publicada = secao(claude, titulo);
    if (deTrabalho) assert.equal(publicada, secao(await ler('CLAUDE.md'), titulo));
  }
});

test('32.6 o CI roda a guarda de privacidade e depois os testes, no Ubuntu com Node 20', async () => {
  const ci = await ler('.github/workflows/checks.yml');
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.match(ci, /node-version: 20/);
  const guarda = ci.indexOf('node scripts/check-privacy.mjs');
  const testes = ci.indexOf('node --test');
  assert.ok(guarda >= 0 && testes > guarda, 'a guarda roda antes dos testes');
});
