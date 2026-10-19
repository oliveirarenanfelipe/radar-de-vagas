const models = { remote: 'Remoto', hybrid: 'Híbrido', onsite: 'Presencial' };
const statuses = { applied: 'Inscrita', discarded: 'Descartada' };
// Mesma lista de RETORNOS de src/state.mjs (este módulo roda no navegador e não importa o estado; o teste confere).
export const RETORNOS_DA_PAGINA = ['Entrevista', 'Teste/Case', 'Proposta', 'Recusado', 'Sem retorno'];
const POSITIVOS = RETORNOS_DA_PAGINA.slice(0, 3);

// Único ponto de interpolação de texto externo em HTML, incluindo atributos.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.href) : '#';
  } catch { return '#'; }
}

function dateLabel(value) {
  if (!value) return 'Não informada';
  return value.slice(0, 10).split('-').reverse().join('/');
}

export function toJobs(state) {
  const counts = new Map();
  for (const entry of Object.values(state.jobs)) {
    counts.set(entry.seen.dedupKey, (counts.get(entry.seen.dedupKey) ?? 0) + 1);
  }
  return Object.entries(state.jobs).map(([id, entry]) => ({
    id, ...entry, possibleDuplicate: counts.get(entry.seen.dedupKey) > 1,
  })).sort((a, b) => (b.triage?.fit ?? 0) - (a.triage?.fit ?? 0) ||
    (b.job.publishedAt ?? '').localeCompare(a.job.publishedAt ?? '') ||
    b.seen.firstSeenAt.localeCompare(a.seen.firstSeenAt) || a.id.localeCompare(b.id));
}

const motivos = { 'fora-do-local': 'Fora do local da busca', 'remota-fora-do-pais': 'Remota fora do país',
  'titulo-sem-termo': 'Título sem nenhum termo da busca' };
const alertasDoFiltro = { 'local-nao-informado': 'local não informado', 'modelo-nao-informado': 'modelo não informado',
  'remota-regional': 'remota regional (pode aceitar o Brasil)', 'pais-nao-identificado': 'país não identificado' };
const passaTudo = () => ({ passa: true, motivo: null, alertas: [] });

/**
 * Vagas do dia: as que entraram no estado durante a última rodada (firstSeenAt entre inicio e fim).
 * Nada é gravado; a vista é recalculada na leitura, então mudar o filtro reclassifica na leitura seguinte.
 * `judge(job)` devolve { passa, motivo, alertas } (src/filter.mjs no servidor; este módulo também roda
 * no navegador e não importa o filtro). Mostradas levam `alertas`; cortadas levam `motivo` e `alertas`.
 */
export function toDay(state, rounds, judge = passaTudo) {
  const rodada = rounds.at(-1) ?? null;
  // Rodadas no mesmo milissegundo: o que entrou até o fim da anterior pertence à anterior.
  const previous = rounds.at(-2);
  const novas = rodada ? toJobs(state).filter(({ seen }) =>
    seen.firstSeenAt >= rodada.inicio && seen.firstSeenAt <= rodada.fim &&
    !(previous && seen.firstSeenAt <= previous.fim)) : [];
  const mostradas = [], cortadas = [], contagemPorMotivo = {};
  for (const entry of novas) {
    const { passa, motivo, alertas } = judge(entry.job);
    if (passa) mostradas.push({ ...entry, alertas });
    else {
      cortadas.push({ ...entry, motivo, alertas });
      contagemPorMotivo[motivo] = (contagemPorMotivo[motivo] ?? 0) + 1;
    }
  }
  return { rodada, mostradas, cortadas, contagemPorMotivo };
}

function renderCut(cortadas) {
  // Sem Object.groupBy: o CI roda Node 20.
  const byMotivo = new Map();
  for (const entry of cortadas) byMotivo.set(entry.motivo, [...(byMotivo.get(entry.motivo) ?? []), entry]);
  const groups = [...byMotivo];
  return `<p class="count">Cortadas pelo filtro: ${cortadas.length}</p>${groups.map(([motivo, list]) =>
    `<details class="cut" data-motivo="${escapeHtml(motivo)}"><summary>${escapeHtml(motivos[motivo] ?? motivo)} (${list.length})</summary><ul>${list.map(({ id, job }) =>
      `<li data-id="${escapeHtml(id)}"><a href="${safeLink(job.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.title)}</a> · ${escapeHtml(job.company)} · Fonte: ${escapeHtml(job.source)} · Motivo: ${escapeHtml(motivos[motivo] ?? motivo)}</li>`).join('')}</ul></details>`).join('')}`;
}

function timeLabel(value) {
  return `${dateLabel(value)} ${value.slice(11, 16)} (UTC)`;
}

export function renderDay(day) {
  if (day?.erro) return `<h2>Vagas do dia</h2><p class="warning">${escapeHtml(day.erro)}</p>`;
  if (!day?.rodada) return '<h2>Vagas do dia</h2><p class="muted">Nenhuma rodada registrada ainda. Rode a coleta no terminal e clique em Atualizar vagas.</p>';
  const { rodada, mostradas, cortadas } = day;
  const inView = mostradas.length + cortadas.length;
  const items = mostradas.map(({ id, job, mark, alertas = [] }) => `<li data-id="${escapeHtml(id)}">
    <a href="${safeLink(job.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(job.title)}</strong></a>
    <span>${escapeHtml(job.company)}</span> · <span class="source">Fonte: ${escapeHtml(job.source)}</span> ·
    <span>${escapeHtml(job.location ?? 'Local não informado')}</span> · <span>${escapeHtml(models[job.workModel] ?? 'Modelo não informado')}</span>
    ${mark ? `· <span class="day-status">${statuses[mark.status]}</span>` : ''}
    ${alertas.map(alerta => `<span class="warning" data-alerta="${escapeHtml(alerta)}">Alerta do filtro: ${escapeHtml(alertasDoFiltro[alerta] ?? alerta)}</span>`).join(' ')}</li>`).join('');
  return `<h2>Vagas do dia</h2>
    <p class="muted">Rodada de ${escapeHtml(timeLabel(rodada.inicio))} a ${escapeHtml(timeLabel(rodada.fim))}${rodada.interrompida ? ' · interrompida antes do fim' : ''}.</p>
    <p class="count">Vagas novas nesta rodada: ${rodada.totalNovas}</p>
    ${inView !== rodada.totalNovas ? `<p class="warning">Atenção: a contagem diverge do registro da coleta (${inView} na vista, ${rodada.totalNovas} no registro). O estado pode ter sido editado à mão ou outra coleta gravou ao mesmo tempo.</p>` : ''}
    ${items ? `<ul class="day-list">${items}</ul>` : '<p class="muted">Nenhuma vaga nova mostrada nesta rodada.</p>'}
    ${renderCut(cortadas)}`;
}

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function filterJobs(jobs, status, query) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return jobs.filter(entry => {
    if (status !== 'all' && (entry.mark?.status ?? 'new') !== status) return false;
    const text = normalize([entry.job.company, entry.job.title, entry.job.location,
      models[entry.job.workModel], entry.job.source, entry.job.description,
      entry.mark?.cutReason, entry.triage?.reason, ...(entry.triage?.alerts ?? [])].join(' '));
    return terms.every(term => text.includes(term));
  });
}

export function renderRows(jobs) {
  return jobs.map(({ id, job, seen, mark, triage, tracking, possibleDuplicate }) => {
    const key = escapeHtml(id);
    return `<tr data-id="${key}">
      <td class="company">${escapeHtml(job.company)}</td>
      <th scope="row" class="vacancy"><strong>${escapeHtml(job.title)}</strong>
        <div><small class="muted">ID: ${key}</small> <button type="button" data-action="copy-id" aria-label="Copiar identificador ${key}">Copiar ID</button></div>
        <details><summary>Descrição completa</summary><p class="description">${escapeHtml(job.description)}</p></details>
      </th>
      <td>${escapeHtml(job.location ?? 'Não informado')}</td>
      <td>${escapeHtml(models[job.workModel] ?? 'Não informado')}</td>
      <td>${escapeHtml(job.source)}</td>
      <td class="date">${escapeHtml(dateLabel(job.publishedAt))}</td>
      <td class="date">${escapeHtml(dateLabel(seen.firstSeenAt))}</td>
      <td class="reason">${triage ? `<span class="fit" aria-label="Encaixe: ${triage.fit} de 5">${'★'.repeat(triage.fit)}${'☆'.repeat(5 - triage.fit)}</span><p>${escapeHtml(triage.reason)}</p>${triage.alerts.map(alert => `<p class="warning">Alerta da triagem: ${escapeHtml(alert)}</p>`).join('')}` : '<span class="muted">Ainda sem triagem</span>'}
        ${possibleDuplicate ? '<p class="warning">Possível duplicata · empresa e título semelhantes em outra linha.</p>' : ''}
      </td>
      <td><a href="${safeLink(job.url)}" target="_blank" rel="noopener noreferrer">Abrir anúncio<span class="sr-only">: ${escapeHtml(job.title)}</span></a></td>
      <td class="decision"><span class="status">${statuses[mark?.status] ?? 'Nova'}</span>
        ${mark ? `<p>${escapeHtml(mark.cutReason ?? 'Candidatura registrada.')}</p><button type="button" data-action="undo">Desfazer marcação</button>` : `<div class="actions"><button type="button" data-action="apply">Inscrevi</button><button type="button" data-action="discard">Descartar</button></div>
        <form hidden><label>Motivo do descarte<textarea name="cutReason" required rows="2" maxlength="2000" placeholder="O que não combina com sua busca?"></textarea></label><div class="actions"><button type="submit">Confirmar descarte</button><button type="button" data-action="cancel">Cancelar</button></div></form>`}
        ${mark?.status === 'applied' ? `<p>Etapa: ${escapeHtml(tracking?.stage ?? 'Inscrita')}</p><p>Próximo passo: ${escapeHtml(tracking?.next || 'Não definido')}</p>
        <label>Retorno<select data-retorno><option value=""${tracking?.retorno ? '' : ' selected'}>Sem registro</option>${RETORNOS_DA_PAGINA.map(valor =>
          `<option value="${escapeHtml(valor)}"${tracking?.retorno === valor ? ' selected' : ''}>${escapeHtml(valor)}</option>`).join('')}</select></label>
        <details><summary>Editar acompanhamento</summary><form data-tracking>
          <label>Etapa<input name="stage" required maxlength="200" value="${escapeHtml(tracking?.stage ?? 'Inscrita')}"></label>
          <label>Próximo passo<textarea name="next" rows="2" maxlength="2000">${escapeHtml(tracking?.next)}</textarea></label>
          <label>Notas<textarea name="notes" rows="2" maxlength="2000">${escapeHtml(tracking?.notes)}</textarea></label>
          <div class="actions"><button type="submit">Salvar acompanhamento</button></div>
        </form></details>` : ''}
      </td>
    </tr>`;
  }).join('');
}

/**
 * Indicadores de retorno (F2.7): por fonte, por estrela (1 a 5 e "sem triagem") e por variante do CV (lida do
 * pacote.json da vaga; sem pacote = "sem pacote"). Só candidaturas com "inscrevi"; taxa = positivas ÷ inscritas.
 */
export function indicadores(jobs, variantePorId = {}) {
  const zero = () => ({ inscritas: 0, positivas: 0, taxa: 0 });
  const grupos = { porFonte: {}, porEstrela: Object.fromEntries(['1', '2', '3', '4', '5', 'sem triagem'].map(chave => [chave, zero()])), porVariante: {} };
  const somar = (grupo, chave, positiva) => {
    grupo[chave] ??= zero();
    grupo[chave].inscritas++;
    if (positiva) grupo[chave].positivas++;
  };
  for (const entry of jobs) {
    if (entry.mark?.status !== 'applied') continue;
    const positiva = POSITIVOS.includes(entry.tracking?.retorno);
    somar(grupos.porFonte, entry.job.source, positiva);
    somar(grupos.porEstrela, entry.triage ? String(entry.triage.fit) : 'sem triagem', positiva);
    somar(grupos.porVariante, variantePorId[entry.id] ?? 'sem pacote', positiva);
  }
  for (const grupo of Object.values(grupos)) {
    for (const linha of Object.values(grupo)) linha.taxa = linha.inscritas ? linha.positivas / linha.inscritas : 0;
  }
  return grupos;
}

export function renderIndicadores(dados) {
  const tabela = (titulo, grupo) => {
    const linhas = Object.entries(grupo).filter(([, linha]) => linha.inscritas);
    return `<h3>${escapeHtml(titulo)}</h3>${linhas.length ? `<table class="indicadores"><thead><tr><th scope="col">${escapeHtml(titulo)}</th><th scope="col">Inscritas</th><th scope="col">Retorno positivo</th><th scope="col">Taxa</th></tr></thead><tbody>${linhas.map(([chave, linha]) =>
      `<tr><td>${escapeHtml(chave)}</td><td>${linha.inscritas}</td><td>${linha.positivas}</td><td>${Math.round(linha.taxa * 100)}%</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nenhuma candidatura inscrita.</p>'}`;
  };
  return `<h2>Retorno das candidaturas</h2><p class="muted">Positivo: Entrevista, Teste/Case ou Proposta. "Sem retorno" só você marca, nunca por prazo.</p>
    ${tabela('Por fonte', dados.porFonte)}${tabela('Por estrela', dados.porEstrela)}${tabela('Por variante do CV', dados.porVariante)}`;
}

// Empresa consultada sem vagas (step "vazia") é aviso, não falha: fica num bloco próprio, com o nome da empresa.
export function renderSourceErrors(sources) {
  const all = Object.entries(sources).flatMap(([name, run]) => run.errors.map(error => ({ name, error })));
  const item = ({ name, error }) => `<li>${escapeHtml(name)} · ${escapeHtml(error.target)}: ${escapeHtml(error.message)}</li>`;
  const warnings = all.filter(({ error }) => error.step === 'vazia').map(item);
  const errors = all.filter(({ error }) => error.step !== 'vazia').map(item);
  return `${errors.length ? `<details class="source-errors"><summary>Falhas: algumas fontes tiveram falhas na última coleta (${errors.length})</summary><ul>${errors.join('')}</ul><p>As vagas já coletadas continuam disponíveis. Tente rodar a coleta novamente.</p></details>` : ''}${warnings.length ? `<details class="source-warnings"><summary>Avisos: empresas sem vagas publicadas agora (${warnings.length})</summary><ul>${warnings.join('')}</ul></details>` : ''}`;
}

export function renderPage(jobs, sources, day, dadosIndicadores) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radar de Vagas</title><link rel="stylesheet" href="/page.css"><script type="module" src="/page.mjs"></script></head>
<body><a class="skip-link" href="#radar">Pular para as vagas</a><main>
<header><div><h1>Radar de Vagas</h1><p>Compare as vagas. A decisão é sua.</p></div><label class="theme-label">Tema<select id="theme"><option value="system">Sistema</option><option value="light">Claro</option><option value="dark">Escuro</option></select></label></header>
<section class="toolbar" aria-label="Filtrar vagas"><label class="search-label">Buscar nas vagas<input id="search" type="search" placeholder="Empresa, título, local ou descrição" autocomplete="off"></label>
<label>Situação<select id="status"><option value="all">Todas</option><option value="new">Novas</option><option value="applied">Inscritas</option><option value="discarded">Descartadas</option></select></label><button id="refresh" type="button">Atualizar vagas</button></section>
<p id="feedback" role="status" aria-live="polite"></p><div id="source-errors">${renderSourceErrors(sources)}</div>
${day === undefined ? '' : `<section id="dia" class="day" aria-label="Vagas do dia">${renderDay(day)}</section>`}
${dadosIndicadores === undefined ? '' : `<section id="indicadores" class="day" aria-label="Retorno das candidaturas">${renderIndicadores(dadosIndicadores)}</section>`}
<section id="radar" aria-label="Vagas coletadas"><p id="count" class="count" aria-live="polite">${jobs.length} ${jobs.length === 1 ? 'vaga' : 'vagas'}</p>
<div id="empty" class="empty"${jobs.length ? ' hidden' : ''}><h2>Nenhuma vaga coletada ainda</h2><p>Configure sua busca e rode a coleta no terminal. Depois, clique em Atualizar vagas.</p></div>
<p id="no-results" hidden>Nenhuma vaga com esses filtros. Tente outra busca ou selecione Todas.</p>
<p id="scroll-hint" class="scroll-hint"${jobs.length ? '' : ' hidden'}>Deslize a tabela para os lados para ver os detalhes e as ações.</p>
<div id="table-wrap" class="table-wrap" tabindex="0" role="region" aria-label="Tabela de vagas, com rolagem horizontal"${jobs.length ? '' : ' hidden'}>
<table><caption class="sr-only">Vagas ordenadas por estrelas e depois pela publicação mais recente; datas desconhecidas aparecem ao final de cada nota.</caption><thead><tr><th scope="col">Empresa</th><th scope="col">Título</th><th scope="col">Local</th><th scope="col">Modelo</th><th scope="col">Fonte</th><th scope="col">Publicação</th><th scope="col">Primeira vez vista</th><th scope="col">Encaixe e motivo</th><th scope="col">Anúncio</th><th scope="col">Sua decisão</th></tr></thead>
<tbody id="jobs">${renderRows(jobs)}</tbody></table></div></section>
<noscript><p>Ative o JavaScript para buscar, filtrar e registrar suas decisões.</p></noscript>
<footer>Dados locais · Inscrevi registra uma candidatura que você já enviou.</footer>
</main></body></html>`;
}
