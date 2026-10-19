import { createSource, array, object, identifier, html, text, date, workModel } from '../source-utils.mjs';
// A descrição em HTML já vem na listagem: não há requisição de detalhe.
// Cada filtro de solidesFiltros vira uma consulta própria; sem filtro, busca o Brasil inteiro.
const companiesByCtx = new WeakMap();
// Desligada de fábrica: busca.json antigo, sem fontes.solides, não passa a chamar uma fonte nova sem pedir.
const base = createSource({ name: 'solides', label: 'Sólides', kind: 'search', defaultEnabled: false, async run(s, term) {
  for (const filter of s.ctx.search?.solidesFiltros ?? [{}]) {
    const key = [term, ...Object.values(filter)].join(' · ');
    // Falha num filtro não derruba os outros filtros do mesmo termo.
    try { await searchSolides(s, term, filter, key); }
    catch (error) { if (s.ctx.signal?.aborted) throw error; s.warn(key, 'busca', error); }
  }
} });
async function searchSolides(s, term, filter, key) {
  const companies = companiesByCtx.get(s.ctx);
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ page: String(page), take: '14', title: term, ...filter });
    const result = object(await s.request(`https://vagas.solides.com.br/api/vacancies?${params}`));
    if (!Number.isInteger(result.totalPages)) throw new Error('Resposta malformada: total de páginas ausente.');
    const items = array(result.data);
    s.listing(key, page, items.length);
    if (!items.length) break;
    for (const item of items) {
      const id = String(item?.id);
      if (!companies.has(id)) companies.set(id, new Set());
      companies.get(id).add(text(item?.companyName));
      await s.item(id, async () => build(object(item)), item?.createdAt);
    }
    await s.flush();
    if (page >= result.totalPages) break;
    if (!s.page(items, key, page)) break;
  }
}
function build(item) {
  const id = identifier(item.id);
  // A API devolve id numérico ou alfanumérico; qualquer outro formato não vira link.
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('Identificador da vaga em formato inesperado na Sólides.');
  const description = html(item.description);
  if (!description) throw new Error('Descrição ausente na listagem da vaga.');
  const city = text(item.city?.name), uf = text(item.state?.code);
  const contracts = Array.isArray(item.recruitmentContractType) ? item.recruitmentContractType.map(type => text(type?.name)).filter(Boolean) : [];
  // redirectLink vem com o domínio quebrado; o link do portal abre com ou sem slug (inclusive confidencial).
  return { source: 'solides', sourceId: id, url: `https://vagas.solides.com.br/vaga/${id}`,
    title: item.title, company: item.isHiddenJob ? 'Empresa não informada' : text(item.companyName) || 'Empresa não informada',
    description, location: city && uf ? `${city} - ${uf}` : city || text(item.state?.name) || null,
    workModel: item.homeOffice === true ? 'remote' : workModel(item.jobType),
    publishedAt: date(item.createdAt), employmentType: contracts.join(', ') || null };
}
// O mesmo id com empresas diferentes na mesma rodada é identidade ambígua: nenhuma das duas entra.
export const solides = { ...base, async collect(ctx = {}) {
  const companies = new Map();
  companiesByCtx.set(ctx, companies);
  const result = await base.collect(ctx);
  const ambiguous = new Set([...companies].filter(([, names]) => names.size > 1).map(([id]) => id));
  if (!ambiguous.size) return result;
  return { ...result, jobs: result.jobs.filter(job => !ambiguous.has(job.sourceId)),
    observed: result.observed?.filter(id => !ambiguous.has(id)),
    errors: [...result.errors, ...[...ambiguous].map(id => ({ target: id, step: 'identidade',
      message: 'O mesmo identificador apareceu com empresas diferentes nesta rodada; a vaga não foi salva.' }))] };
} };
