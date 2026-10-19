import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import {
  criarClienteTelegram, ErroTelegram, redigirToken, tokenValido,
  PRAZO_MS, TETO_RETRY_AFTER_MS, TENTATIVAS_429, ESPERAS_5XX_MS,
} from '../src/telegram.mjs';

// Token falso gerado em tempo de execução: nenhum token real no repositório.
function tokenFalso() {
  return `${randomInt(100000, 999999)}:${randomBytes(30).toString('base64url')}`;
}

// Servidor HTTP falso em 127.0.0.1, porta 0. `responder(pedido, n)` devolve
// { status, json } ou { status, bruto } ou 'pendurar' (não responde nunca).
async function servidorFalso(responder) {
  const pedidos = [];
  const server = http.createServer(async (req, res) => {
    const partes = [];
    for await (const parte of req) partes.push(parte);
    const pedido = {
      verbo: req.method, caminho: req.url, metodo: req.url.split('/').pop(),
      headers: req.headers, corpo: Buffer.concat(partes),
    };
    pedidos.push(pedido);
    const resposta = await responder(pedido, pedidos.length);
    if (resposta === 'pendurar') return;
    res.writeHead(resposta.status ?? 200, { 'content-type': 'application/json' });
    res.end(resposta.bruto ?? JSON.stringify(resposta.json));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    apiBase: `http://127.0.0.1:${port}`,
    pedidos,
    fechar() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

// Relógio e sleep injetados: o sleep anota quanto pediu e avança o relógio.
function relogio() {
  let t = 1_000_000;
  const esperas = [];
  return {
    esperas,
    agora: () => t,
    sleep: async ms => { esperas.push(ms); t += ms; },
    avancar: ms => { t += ms; },
  };
}

const ok = result => ({ status: 200, json: { ok: true, result } });
const mensagem = (extra = {}) => ({ message_id: 123, date: 1, chat: { id: 4242, type: 'private' }, ...extra });

// Guarda de 5 s: chamada que nunca volta (cliente sem prazo) reprova aqui, e o finally fecha o
// servidor; sem isso o processo do teste ficaria pendurado em vez de reprovar.
async function comServidor(responder, corpo) {
  const servidor = await servidorFalso(responder);
  let guarda;
  try {
    return await Promise.race([corpo(servidor), new Promise((_, rejeitar) => {
      guarda = setTimeout(() => rejeitar(new Error('chamada sem resposta em 5 s: o cliente não aplicou o prazo')), 5000);
    })]);
  } finally {
    clearTimeout(guarda);
    await servidor.fechar();
  }
}

function cliente(servidor, token, { relogio: r = relogio(), ...extra } = {}) {
  return criarClienteTelegram({ token, apiBase: servidor.apiBase, sleep: r.sleep, agora: r.agora, ...extra });
}

async function capturar(promessa) {
  try {
    await promessa;
  } catch (error) {
    return error;
  }
  assert.fail('era para lançar erro');
}

function semToken(error, token) {
  assert.ok(error instanceof ErroTelegram, `esperava ErroTelegram, veio ${error?.name}`);
  for (const texto of [error.message, error.stack, inspect(error, { depth: 5 }), JSON.stringify(error)]) {
    assert.ok(!texto.includes(token), `token apareceu em: ${texto.slice(0, 200)}`);
    assert.ok(!texto.includes(encodeURIComponent(token)), 'token codificado apareceu');
  }
}

test('23.1 token fora do formato: erro de configuração com código 2, sem eco do valor e sem requisição', async () => {
  await comServidor(() => ok({}), async servidor => {
    const bom = tokenFalso();
    const ruins = [undefined, '', 'abc', '123:curto', `${bom} `, `x${bom}`, bom.replace(':', ''), `${bom.split(':')[0]}:${'a'.repeat(29)}`, 12345];
    for (const token of ruins) {
      let error = null;
      try { criarClienteTelegram({ token, apiBase: servidor.apiBase }); } catch (e) { error = e; }
      assert.ok(error instanceof ErroTelegram, `token ${String(token).slice(0, 5)} passou`);
      assert.equal(error.codigo, 2);
      assert.equal(error.tipo, 'entrada');
      assert.match(error.message, /configure o Telegram: token/);
      if (typeof token === 'string' && token.length > 3) assert.ok(!error.message.includes(token));
    }
    assert.ok(tokenValido(bom));
    assert.equal(servidor.pedidos.length, 0);
  });
});

test('23.1 o endereço da API só vem do código: padrão api.telegram.org, sem leitura do ambiente', async () => {
  const token = tokenFalso();
  const urls = [];
  const fetchFalso = async url => {
    urls.push(url);
    return new Response(JSON.stringify({ ok: true, result: { id: 7, is_bot: true } }));
  };
  const c = criarClienteTelegram({ token, fetch: fetchFalso });
  assert.equal((await c.quemSouEu()).id, 7);
  assert.deepEqual(urls, [`https://api.telegram.org/bot${token}/getMe`]);
  const fonte = await readFile(new URL('../src/telegram.mjs', import.meta.url), 'utf8');
  assert.ok(!/process\s*\.\s*env/.test(fonte), 'telegram.mjs não lê o ambiente');
});

test('23.1 o token não aparece em erro nenhum (401, 429, 500, JSON inválido, ok:false, prazo, conexão recusada) e a URL sai com bot***', async () => {
  const token = tokenFalso();
  const cenarios = {
    401: () => ({ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }),
    429: () => ({ status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 1 } } }),
    500: () => ({ status: 500, bruto: 'erro' }),
    jsonInvalido: () => ({ status: 200, bruto: `{"ok":true,"result":"${token}"` }),
    okFalse: () => ({ status: 400, json: { ok: false, description: `Bad Request: bot${token} recusado` } }),
    prazo: () => 'pendurar',
  };
  for (const [nome, responder] of Object.entries(cenarios)) {
    await comServidor(responder, async servidor => {
      const error = await capturar(cliente(servidor, token, { prazoMs: 50 }).enviarTexto(4242, 'oi'));
      semToken(error, token);
      assert.match(error.message, /bot\*\*\*\/sendMessage/, `${nome}: ${error.message}`);
      assert.ok(servidor.pedidos.every(p => p.caminho.includes(token)), `${nome}: o token chegou ao servidor (o teste é sensível)`);
    });
  }
  // Conexão recusada: a porta foi aberta e fechada antes.
  const fechado = await servidorFalso(() => ok({}));
  await fechado.fechar();
  const error = await capturar(cliente(fechado, token).quemSouEu());
  semToken(error, token);
  assert.equal(error.tipo, 'conexao');
  assert.match(error.message, /bot\*\*\*\/getMe/);
  // Sucesso: o resultado não carrega o token.
  await comServidor(() => ok(mensagem({ text: 'oi' })), async servidor => {
    const result = await cliente(servidor, token).enviarTexto(4242, 'oi');
    assert.ok(!JSON.stringify(result).includes(token));
  });
});

test('23.1 descrição de erro que ecoa o token perto do corte de 200 caracteres não deixa sair pedaço dele', async () => {
  const token = tokenFalso();
  // Sem o prefixo "bot": só a redação do token inteiro pega; cortar antes de redigir deixaria sair o começo.
  const description = `${'x'.repeat(185)}${token}`;
  await comServidor(() => ({ status: 400, json: { ok: false, description } }), async servidor => {
    const error = await capturar(cliente(servidor, token).enviarTexto(4242, 'oi'));
    semToken(error, token);
    assert.ok(!error.message.includes(token.slice(0, 12)), `pedaço do token apareceu: ${error.message}`);
  });
});

test('23.1 a URL de download do getFile sai redigida no erro', async () => {
  const token = tokenFalso();
  await comServidor(pedido => (pedido.metodo === 'getFile'
    ? ok({ file_id: 'F1', file_unique_id: 'U1', file_path: 'documents/file_9.txt', file_size: 3 })
    : { status: 404, bruto: 'nao achei' }), async servidor => {
    const error = await capturar(cliente(servidor, token).baixarArquivo('F1'));
    semToken(error, token);
    assert.match(error.message, /\/file\/bot\*\*\*\/documents\/file_9\.txt/);
    assert.equal(servidor.pedidos[1].caminho, `/file/bot${token}/documents/file_9.txt`);
  });
});

test('23.1 redigirToken troca o token, a forma codificada e qualquer bot<id>:<segredo>', () => {
  const token = tokenFalso();
  const outro = tokenFalso();
  const texto = `a ${token} b ${encodeURIComponent(token)} c https://x/bot${outro}/getMe`;
  const saida = redigirToken(texto, token);
  assert.ok(!saida.includes(token) && !saida.includes(outro) && !saida.includes(encodeURIComponent(token)));
  assert.match(saida, /bot\*\*\*\/getMe/);
});

test('23.2 enviarTexto manda texto puro, sem parse_mode, byte a byte, e devolve a Message do servidor', async () => {
  const token = tokenFalso();
  const texto = 'Lote ab12cd34ef56\n1. perfil · variante v1\n"Reduzi custos em 12% na Alfa Fictícia"\nascii: "Reduzi custos em 12% na Alfa Fict\\u00edcia" 🚀 <b>x</b> *y*';
  await comServidor(pedido => ok(mensagem({ text: JSON.parse(pedido.corpo).text })), async servidor => {
    const result = await cliente(servidor, token).enviarTexto(4242, texto);
    assert.equal(servidor.pedidos.length, 1);
    const [pedido] = servidor.pedidos;
    assert.equal(pedido.metodo, 'sendMessage');
    assert.equal(pedido.verbo, 'POST');
    const corpo = JSON.parse(pedido.corpo.toString('utf8'));
    assert.deepEqual(Object.keys(corpo).sort(), ['chat_id', 'text']);
    assert.equal(corpo.chat_id, 4242);
    assert.ok(Buffer.from(corpo.text, 'utf8').equals(Buffer.from(texto, 'utf8')));
    assert.equal(result.text, texto);
    assert.equal(result.message_id, 123);
  });
});

test('23.2 e 23.9 enviarDocumento manda o arquivo com nome, caption e bytes intactos e devolve file_unique_id', async () => {
  const token = tokenFalso();
  const bytes = new Uint8Array(randomBytes(4096));
  bytes.set(Buffer.from('%PDF-1.7\n'), 0);
  const caption = 'Lote ab12cd34ef56 · base geral\nhash 0f0f\nResponda a ESTE documento com: aprovo';
  let recebido;
  await comServidor(async pedido => {
    const form = await new Response(pedido.corpo, { headers: { 'content-type': pedido.headers['content-type'] } }).formData();
    const documento = form.get('document');
    recebido = {
      chatId: form.get('chat_id'), caption: form.get('caption'), parseMode: form.get('parse_mode'),
      nome: documento.name, bytes: Buffer.from(await documento.arrayBuffer()),
    };
    return ok(mensagem({ caption: recebido.caption, document: { file_id: 'F1', file_unique_id: 'U-doc-1', file_name: documento.name } }));
  }, async servidor => {
    const result = await cliente(servidor, token).enviarDocumento(4242, { nome: 'Curriculo Fulano Ficticio.pdf', bytes, caption, tipo: 'application/pdf' });
    assert.equal(servidor.pedidos.length, 1);
    assert.equal(servidor.pedidos[0].metodo, 'sendDocument');
    assert.equal(recebido.chatId, '4242');
    assert.equal(recebido.caption, caption);
    // O caption chega com "\n" cru: o FormData do Node trocaria por "\r\n" e a comparação do 23.5 nunca bateria.
    assert.ok(servidor.pedidos[0].corpo.includes(Buffer.from(`\r\n\r\n${caption}\r\n--`, 'utf8')));
    assert.equal(recebido.parseMode, null);
    assert.equal(recebido.nome, 'Curriculo Fulano Ficticio.pdf');
    const sha = b => createHash('sha256').update(b).digest('hex');
    assert.equal(sha(recebido.bytes), sha(bytes));
    assert.equal(result.document.file_unique_id, 'U-doc-1');
    assert.equal(result.caption, caption);
  });
});

test('23.2 chatId inválido, texto vazio e documento sem bytes não chegam ao servidor', async () => {
  const token = tokenFalso();
  await comServidor(() => ok(mensagem()), async servidor => {
    const c = cliente(servidor, token);
    for (const chatId of [0, -5, 1.5, '4242', null]) {
      const error = await capturar(c.enviarTexto(chatId, 'oi'));
      assert.equal(error.codigo, 2);
    }
    assert.equal((await capturar(c.enviarTexto(4242, ''))).tipo, 'entrada');
    assert.equal((await capturar(c.enviarDocumento(4242, { nome: 'a.txt', bytes: new Uint8Array() }))).tipo, 'entrada');
    assert.equal((await capturar(c.enviarDocumento(4242, { nome: '../a.txt', bytes: new Uint8Array([1]) }))).tipo, 'entrada');
    assert.equal(servidor.pedidos.length, 0);
  });
});

test('23.8 429 com retry_after 7 e depois 200: o sleep recebe 7000 ms e o envio passa', async () => {
  const token = tokenFalso();
  const r = relogio();
  await comServidor((_, n) => (n === 1
    ? { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 7 } } }
    : ok(mensagem({ text: 'oi' }))), async servidor => {
    const result = await cliente(servidor, token, { relogio: r }).enviarTexto(4242, 'oi');
    assert.equal(result.message_id, 123);
    assert.equal(servidor.pedidos.length, 2);
    assert.deepEqual(r.esperas, [7000]);
  });
});

test('23.8 retry_after acima de 60 s espera o teto de 60 s', async () => {
  const token = tokenFalso();
  const r = relogio();
  await comServidor((_, n) => (n === 1
    ? { status: 429, json: { ok: false, parameters: { retry_after: 600 } } }
    : ok(mensagem())), async servidor => {
    await cliente(servidor, token, { relogio: r }).enviarTexto(4242, 'oi');
    assert.equal(TETO_RETRY_AFTER_MS, 60000);
    assert.deepEqual(r.esperas, [60000]);
  });
});

test('23.8 429 sem parar: 3 tentativas ao todo e erro de limite, nada devolvido como enviado', async () => {
  const token = tokenFalso();
  const r = relogio();
  await comServidor(() => ({ status: 429, json: { ok: false, parameters: { retry_after: 2 } } }), async servidor => {
    const error = await capturar(cliente(servidor, token, { relogio: r }).enviarTexto(4242, 'oi'));
    assert.equal(TENTATIVAS_429, 3);
    assert.equal(servidor.pedidos.length, 3);
    assert.equal(error.tipo, 'limite');
    assert.equal(error.codigo, 1);
    assert.deepEqual(r.esperas, [2000, 2000]);
  });
});

test('23.8 5xx espera 1 s, 2 s e 4 s; depois disso desiste', async () => {
  const token = tokenFalso();
  const r = relogio();
  await comServidor((_, n) => (n <= 3 ? { status: 500 + n, bruto: 'x' } : ok({ id: 9, is_bot: true })), async servidor => {
    assert.equal((await cliente(servidor, token, { relogio: r }).quemSouEu()).id, 9);
    assert.deepEqual(ESPERAS_5XX_MS, [1000, 2000, 4000]);
    assert.deepEqual(r.esperas, [1000, 2000, 4000]);
    assert.equal(servidor.pedidos.length, 4);
  });
  const r2 = relogio();
  await comServidor(() => ({ status: 503, bruto: 'x' }), async servidor => {
    const error = await capturar(cliente(servidor, token, { relogio: r2 }).quemSouEu());
    assert.equal(error.tipo, 'servidor');
    assert.equal(servidor.pedidos.length, 4);
    assert.deepEqual(r2.esperas, [1000, 2000, 4000]);
  });
});

test('23.8 401 e 403 saem com "token inválido ou bot bloqueado", código 1, sem nova tentativa', async () => {
  const token = tokenFalso();
  for (const status of [401, 403]) {
    const r = relogio();
    await comServidor(() => ({ status, json: { ok: false, error_code: status, description: 'Forbidden' } }), async servidor => {
      const error = await capturar(cliente(servidor, token, { relogio: r }).enviarTexto(4242, 'oi'));
      assert.equal(error.tipo, 'autorizacao');
      assert.equal(error.codigo, 1);
      assert.equal(error.status, status);
      assert.match(error.message, /token inválido ou bot bloqueado/);
      assert.equal(servidor.pedidos.length, 1);
      assert.deepEqual(r.esperas, []);
    });
  }
});

test('23.8 servidor que não responde: erro de prazo (injetado 50 ms), uma requisição só', async () => {
  const token = tokenFalso();
  assert.equal(PRAZO_MS, 15000);
  await comServidor(() => 'pendurar', async servidor => {
    const inicio = Date.now();
    const error = await capturar(cliente(servidor, token, { prazoMs: 50 }).enviarTexto(4242, 'oi'));
    assert.equal(error.tipo, 'prazo');
    assert.match(error.message, /prazo de 50 ms/);
    assert.ok(Date.now() - inicio < 3000);
    assert.equal(servidor.pedidos.length, 1);
  });
});

test('23.8 ok:false, JSON inválido e 400 são erro, sem nova tentativa', async () => {
  const token = tokenFalso();
  const respostas = [
    { status: 200, json: { ok: false, description: 'nao' } },
    { status: 200, bruto: '<html>' },
    { status: 200, json: { ok: true } },
    { status: 400, json: { ok: false, description: 'Bad Request: chat not found' } },
  ];
  for (const resposta of respostas) {
    await comServidor(() => resposta, async servidor => {
      const error = await capturar(cliente(servidor, token).enviarTexto(4242, 'oi'));
      assert.equal(error.tipo, 'resposta');
      assert.equal(error.codigo, 1);
      assert.equal(servidor.pedidos.length, 1);
    });
  }
});

test('23.8 entre dois envios há pelo menos 1 s; leitura não espera', async () => {
  const token = tokenFalso();
  const r = relogio();
  await comServidor(pedido => (pedido.metodo === 'getUpdates' ? ok([]) : ok(mensagem())), async servidor => {
    const c = cliente(servidor, token, { relogio: r });
    await c.enviarTexto(4242, 'um');
    r.avancar(200);
    await c.enviarDocumento(4242, { nome: 'a.txt', bytes: new Uint8Array([1, 2]) });
    assert.deepEqual(r.esperas, [800]);
    await c.lerAtualizacoes({ offset: 1 });
    assert.deepEqual(r.esperas, [800]);
    r.avancar(1500);
    await c.enviarTexto(4242, 'tres');
    assert.deepEqual(r.esperas, [800]);
    assert.equal(servidor.pedidos.length, 4);
  });
});

test('23.7 lerAtualizacoes manda offset, limit 100 e timeout 0 e devolve a lista; limit fora de 1..100 não chega ao servidor', async () => {
  const token = tokenFalso();
  const updates = [{ update_id: 10, message: { message_id: 5, text: 'aprovo' } }];
  await comServidor(() => ok(updates), async servidor => {
    const c = cliente(servidor, token);
    assert.deepEqual(await c.lerAtualizacoes({ offset: 10 }), updates);
    assert.deepEqual(JSON.parse(servidor.pedidos[0].corpo), { limit: 100, timeout: 0, offset: 10 });
    await c.lerAtualizacoes({ allowedUpdates: ['message'] });
    assert.deepEqual(JSON.parse(servidor.pedidos[1].corpo), { limit: 100, timeout: 0, allowed_updates: ['message'] });
    for (const limit of [0, 101]) assert.equal((await capturar(c.lerAtualizacoes({ limit }))).tipo, 'entrada');
    assert.equal(servidor.pedidos.length, 2);
  });
  await comServidor(() => ok({ nao: 'lista' }), async servidor => {
    assert.equal((await capturar(cliente(servidor, token).lerAtualizacoes())).tipo, 'resposta');
  });
});

test('23.5 baixarArquivo: getFile e download devolvem os bytes; file_path com .. não baixa', async () => {
  const token = tokenFalso();
  const conteudo = Buffer.from('hash 0f0f\n"Engenheiro de Energia"\n', 'utf8');
  await comServidor(pedido => (pedido.metodo === 'getFile'
    ? ok({ file_id: 'F1', file_unique_id: 'U1', file_path: 'documents/file_1.txt', file_size: conteudo.length })
    : { status: 200, bruto: conteudo }), async servidor => {
    const { bytes, fileUniqueId, filePath } = await cliente(servidor, token).baixarArquivo('F1');
    assert.ok(Buffer.from(bytes).equals(conteudo));
    assert.equal(fileUniqueId, 'U1');
    assert.equal(filePath, 'documents/file_1.txt');
    assert.deepEqual(JSON.parse(servidor.pedidos[0].corpo), { file_id: 'F1' });
    assert.equal(servidor.pedidos[1].caminho, `/file/bot${token}/documents/file_1.txt`);
  });
  for (const filePath of ['../x', 'documents/../../x', '/etc/x', 'a b', undefined]) {
    await comServidor(() => ok({ file_id: 'F1', file_unique_id: 'U1', file_path: filePath }), async servidor => {
      assert.equal((await capturar(cliente(servidor, token).baixarArquivo('F1'))).tipo, 'resposta');
      assert.equal(servidor.pedidos.length, 1);
    });
  }
});

test('23.11 quemSouEu devolve o id do bot e lerWebhook devolve url e pendentes', async () => {
  const token = tokenFalso();
  await comServidor(pedido => (pedido.metodo === 'getMe'
    ? ok({ id: 555, is_bot: true, username: 'radar_teste_bot' })
    : ok({ url: 'https://exemplo.invalid/hook', pending_update_count: 3 })), async servidor => {
    const c = cliente(servidor, token);
    assert.equal((await c.quemSouEu()).id, 555);
    const info = await c.lerWebhook();
    assert.equal(info.url, 'https://exemplo.invalid/hook');
    assert.equal(info.pending_update_count, 3);
    assert.deepEqual(servidor.pedidos.map(p => p.metodo), ['getMe', 'getWebhookInfo']);
  });
  await comServidor(() => ok({ id: 1, is_bot: false }), async servidor => {
    assert.equal((await capturar(cliente(servidor, token).quemSouEu())).tipo, 'resposta');
  });
});

test('23.10 checagem estática: só telegram.mjs fala com o Telegram, sem node:fs e sem nada de src/preparo; src/preparo sem rede', async () => {
  const raiz = fileURLToPath(new URL('../src/', import.meta.url));
  async function listar(dir) {
    const saida = [];
    for (const entrada of await readdir(dir, { withFileTypes: true })) {
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) saida.push(...await listar(caminho));
      else if (/\.(mjs|js)$/.test(entrada.name)) saida.push(caminho);
    }
    return saida;
  }
  const comTelegram = [];
  for (const arquivo of await listar(raiz)) {
    const fonte = await readFile(arquivo, 'utf8');
    const relativo = arquivo.slice(raiz.length).replaceAll('\\', '/').replace(/^\//, '');
    if (fonte.includes('api.telegram.org')) comTelegram.push(relativo);
    if (relativo.startsWith('preparo/')) {
      assert.ok(!/(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*(?:telegram|network)\.mjs['"]/.test(fonte), `${relativo} importa rede`);
      assert.ok(!/\bfetch\s*\(/.test(fonte), `${relativo} chama fetch`);
    }
  }
  assert.deepEqual(comTelegram, ['telegram.mjs']);
  const fonte = await readFile(join(raiz, 'telegram.mjs'), 'utf8');
  const imports = [...fonte.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)].map(m => m[1] ?? m[2]);
  assert.ok(!imports.some(i => /^(node:)?fs(\/promises)?$/.test(i)), 'telegram.mjs não importa node:fs');
  assert.ok(!imports.some(i => i.includes('preparo')), 'telegram.mjs não importa src/preparo');
  assert.ok(!/require\(/.test(fonte));
});
