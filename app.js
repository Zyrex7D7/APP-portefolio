'use strict';

/* =========================================================================
   GESTOR DE PATRIMÓNIO — app.js
   Vanilla JS, sem build, sem dependências. Abre-se com duplo-clique no
   index.html. Persistência local (localStorage) nesta fase; a ligação ao
   Supabase será feita depois, sem alterar o modelo de dados abaixo.
   ========================================================================= */

/* ---------- Utilitários ---------- */
const STORAGE_KEY = 'patrimonio-app-state-v1';
const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => (Number.isFinite(n) ? n : 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
const parseAmountInput = (raw) => Number(String(raw ?? '').replace(',', '.'));
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-PT');

function emptyState() {
  return { accounts: [], cash: [], investments: [], quotes: {}, tickers: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Array.isArray(parsed.accounts) &&
      Array.isArray(parsed.cash) &&
      Array.isArray(parsed.investments) &&
      parsed.quotes &&
      typeof parsed.quotes === 'object'
    ) {
      if (!parsed.tickers || typeof parsed.tickers !== 'object') parsed.tickers = {}; // compatibilidade com estados guardados antes desta funcionalidade
      return parsed;
    }
    return emptyState();
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* =========================================================================
   LÓGICA FINANCEIRA
   Correção principal face à versão anterior: uma compra/venda de ações
   passa a mexer no saldo da conta de corretora (accountId nas
   investment_transactions, tal como já estava previsto no schema.sql, mas
   que o frontend antigo ignorava). Sem isto, comprar ações "criava"
   dinheiro do nada no património total.
   ========================================================================= */

// Efeito das transações de conta corrente (receitas/despesas manuais) numa conta.
function cashEffect(accountId, cash) {
  return cash
    .filter((t) => t.accountId === accountId)
    .reduce((sum, t) => sum + (t.type === 'expense' ? -Math.abs(t.amount) : Math.abs(t.amount)), 0);
}

// Efeito das transações de investimento (compra/venda/dividendo/comissão/imposto) no saldo em dinheiro da conta.
function investmentCashEffect(accountId, investments) {
  return investments
    .filter((t) => t.accountId === accountId)
    .reduce((sum, t) => {
      if (t.operation === 'buy') return sum - t.amount;
      if (t.operation === 'sell') return sum + t.amount;
      if (t.operation === 'dividend') return sum + t.amount;
      if (t.operation === 'fee' || t.operation === 'tax') return sum - t.amount;
      return sum;
    }, 0);
}

function accountBalance(account, cash, investments) {
  return account.openingBalance + cashEffect(account.id, cash) + investmentCashEffect(account.id, investments);
}

// Posição por ativo (custo médio ponderado). Nunca lança exceções: uma linha
// mal formada ou uma venda "a mais" fica sinalizada em vez de rebentar a app inteira.
function computePosition(assetKey, assetName, txs) {
  let quantity = 0;
  let cost = 0;
  let realizedPnl = 0;
  let error = null;
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const t of sorted) {
    if (t.operation === 'buy') {
      cost += t.quantity * t.price;
      quantity += t.quantity;
    } else if (t.operation === 'sell') {
      if (t.quantity > quantity + 1e-9) {
        error = `Uma venda de ${t.quantity} unidades excede a posição registada (${quantity}). Foi contabilizado apenas o disponível — confirma as transações importadas.`;
      }
      const sellQty = Math.min(t.quantity, quantity);
      const avg = quantity ? cost / quantity : 0;
      cost -= sellQty * avg;
      quantity -= sellQty;
      realizedPnl += sellQty * (t.price - avg);
    }
    // dividendos, comissões e impostos não alteram a posição — só o saldo em dinheiro (ver investmentCashEffect).
  }
  return { assetKey, assetName, quantity, cost, averageCost: quantity ? cost / quantity : 0, realizedPnl, error };
}

function computePortfolio(investments, quotes) {
  const keys = [...new Set(investments.map((t) => t.assetKey))];
  return keys.map((assetKey) => {
    const txs = investments.filter((t) => t.assetKey === assetKey);
    const assetName = txs[0]?.assetName || assetKey;
    const position = computePosition(assetKey, assetName, txs);
    const quote = quotes[assetKey];
    const price = quote?.price ?? 0;
    const value = position.quantity * price;
    return { ...position, price, value, unrealizedPnl: value - position.cost, quote };
  });
}

function netWorth(accounts, cash, investments, portfolio) {
  const liquid = accounts
    .filter((a) => a.active)
    .reduce((sum, a) => sum + accountBalance(a, cash, investments), 0);
  const invested = portfolio.reduce((sum, p) => sum + p.value, 0);
  return liquid + invested;
}

function reportStart(range, now = new Date()) {
  const date = new Date(now);
  if (range === 'Ano atual') return new Date(date.getFullYear(), 0, 1);
  const months = range === 'Último mês' ? 1 : Number.parseInt(range, 10) || 1;
  date.setMonth(date.getMonth() - months);
  return date;
}

function groupExpensesByCategory(cash, range, now = new Date()) {
  const start = reportStart(range, now);
  return cash
    .filter((t) => t.type === 'expense' && t.category !== 'Ajuste interno DEGIRO' && new Date(`${t.date}T12:00:00`) >= start)
    .reduce((out, t) => {
      out[t.category] = (out[t.category] || 0) + Math.abs(t.amount);
      return out;
    }, {});
}

/* =========================================================================
   PARSER CSV DA DEGIRO
   Hash síncrono (FNV-1a) em vez de crypto.subtle assíncrono — mais simples
   e funciona sempre, incluindo ao abrir o ficheiro localmente (file://).
   ========================================================================= */

function hashRow(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // combina com o comprimento para reduzir ainda mais o risco de colisão
  return (h >>> 0).toString(16).padStart(8, '0') + str.length.toString(16);
}

function normalizeHeader(v) {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// Devolve: undefined -> campo em branco (válido, ex.: linhas de depósito sem quantidade/preço)
//          null      -> campo preenchido mas com um valor que não é um número válido (erro real)
//          número    -> valor interpretado com sucesso
function parseNumber(raw) {
  if (!raw || !raw.trim()) return undefined;
  let value = raw.replace(/\s/g, '').replace(/[€$]/g, '');
  if (value.includes(',') && value.includes('.')) {
    value = value.lastIndexOf(',') > value.lastIndexOf('.') ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');
  } else if (value.includes(',')) {
    value = value.replace(',', '.');
  }
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDMYDate(raw) {
  const parts = raw?.trim().split(/[./-]/).map(Number);
  if (!parts || parts.length !== 3 || parts.some(Number.isNaN)) return null;
  let [a, b, c] = parts;
  if (String(parts[0]).length === 4) [c, a, b] = parts; // formato AAAA-MM-DD
  const year = c < 100 ? 2000 + c : c;
  const d = new Date(Date.UTC(year, b - 1, a));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== b - 1 || d.getUTCDate() !== a) return null;
  return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
}

function splitCsvLine(line, separator) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === separator && !quoted) {
      cells.push(value.trim());
      value = '';
    } else {
      value += c;
    }
  }
  cells.push(value.trim());
  return cells;
}

// O ficheiro real exportado pela DEGIRO ("Conta > Exportar movimentos") tem estas colunas:
// Data, Hora, Data Valor, Produto, ISIN, Descrição, T., Mudança, <moeda|valor>, Saldo, <moeda|valor>, ID da Ordem
// "Mudança" e "Saldo" ocupam DUAS colunas cada (moeda na coluna com o nome, valor na coluna seguinte, sem cabeçalho).
// Não há colunas de Quantidade/Preço — para compras/vendas, essa informação vem embutida na Descrição, ex.:
// "Compra 3 SAP SE@147,54 EUR (DE0007164600)". O parser também aceita variantes com colunas explícitas de
// Quantidade/Preço, caso existam (outros formatos de exportação).
function classifyDegiroRow(description) {
  const norm = normalizeHeader(description);
  if (/^compra\b/.test(norm)) return { operation: 'buy', category: 'Compra' };
  if (/^venda\b/.test(norm)) return { operation: 'sell', category: 'Venda' };
  if (/^dividendo/.test(norm)) return { operation: 'dividend', category: 'Dividendos' };
  if (/imposto/.test(norm)) return { operation: 'tax', category: 'Impostos' };
  if (/comiss|taxa de terceiros|corretagem|custo de conectividade/.test(norm)) return { operation: 'fee', category: 'Comissões' };
  // Movimentos internos da DEGIRO entre a "Conta Caixa" e o fundo de curto prazo (Cash Sweep) — cancelam-se
  // aos pares e não representam dinheiro a entrar/sair de verdade, por isso ficam marcados como internos
  // (excluídos do relatório de despesas, mas continuam a contar para o saldo da conta).
  if (/conta caixa/.test(norm)) return { operation: 'cash', category: 'Ajuste interno DEGIRO', internal: true };
  if (/cash sweep transfer/.test(norm)) return { operation: 'cash', category: 'Ajuste interno DEGIRO', internal: true };
  if (/^flatex deposit/.test(norm)) return { operation: 'cash', category: 'Depósito' };
  if (/interest income|juro/.test(norm)) return { operation: 'cash', category: 'Juros' };
  return { operation: 'cash', category: 'DEGIRO' };
}

// Extrai quantidade/preço de descrições como "Compra 3 SAP SE@147,54 EUR (DE0007164600)".
function extractQuantityPrice(description) {
  const m = description.match(/^(?:Compra|Venda)\s+([\d.,]+)\s+.+@\s*([\d.,]+)\s*[A-Za-z]{2,4}/i);
  if (!m) return null;
  const quantity = parseNumber(m[1]);
  const price = parseNumber(m[2]);
  if (quantity === null || quantity === undefined || price === null || price === undefined) return null;
  return { quantity, price };
}

function parseDegiroCsv(csv) {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.trim());
  if (!lines.length) return { rows: [], rejected: [{ line: 1, reason: 'Ficheiro vazio', raw: '' }] };

  const separator = lines[0].includes(';') ? ';' : ',';
  const headers = splitCsvLine(lines[0], separator).map(normalizeHeader);
  const findCol = (names) => headers.findIndex((h) => names.some((n) => h === normalizeHeader(n)));
  const findColLoose = (names) => headers.findIndex((h) => h && names.some((n) => h.includes(normalizeHeader(n))));

  const dCol = findCol(['data', 'date']);
  const pCol = findCol(['produto', 'product']);
  const iCol = findCol(['isin']);
  const descCol = findCol(['descricao', 'mutacao', 'description', 'mutation']);
  // formato "clássico" com colunas explícitas de quantidade/preço, caso existam nalguma variante do export
  const qColExplicit = findColLoose(['quantidade', 'quantity']);
  const prColExplicit = findColLoose(['preco', 'price']);
  // formato real da DEGIRO: "Mudança" é o cabeçalho da coluna de moeda; o valor está na coluna seguinte
  const mudCol = findColLoose(['mudanca', 'mudança', 'change']);
  const amountColExplicit = findColLoose(['valor', 'amount', 'total']);

  if (dCol < 0) return { rows: [], rejected: [{ line: 1, reason: 'Coluna "Data" não encontrada no ficheiro', raw: lines[0] }] };
  if (descCol < 0) return { rows: [], rejected: [{ line: 1, reason: 'Coluna "Descrição" não encontrada no ficheiro', raw: lines[0] }] };

  const rows = [];
  const rejected = [];

  for (let n = 1; n < lines.length; n++) {
    const cells = splitCsvLine(lines[n], separator);
    const tradedOn = parseDMYDate(cells[dCol]);
    const product = pCol >= 0 ? cells[pCol]?.trim() : '';
    const isin = iCol >= 0 ? cells[iCol]?.trim() : '';
    const description = cells[descCol]?.trim();

    if (!tradedOn) {
      rejected.push({ line: n + 1, reason: 'Data inválida ou ausente', raw: lines[n] });
      continue;
    }
    if (!description) {
      rejected.push({ line: n + 1, reason: 'Descrição ausente', raw: lines[n] });
      continue;
    }

    const { operation, category, internal } = classifyDegiroRow(description);

    // valor da transação: tenta, por ordem, a coluna "Mudança" (formato real), depois uma coluna "Valor"
    // explícita, e por fim o valor embutido no texto (linhas de ajuste interno "Conta Caixa").
    let amount;
    if (mudCol >= 0 && cells[mudCol + 1] !== undefined && cells[mudCol + 1].trim()) {
      amount = parseNumber(cells[mudCol + 1]);
    } else if (amountColExplicit >= 0 && cells[amountColExplicit] && cells[amountColExplicit].trim()) {
      amount = parseNumber(cells[amountColExplicit]);
    }
    if (amount === undefined || amount === null) {
      const embedded = description.match(/([\d.,]+)\s*(?:EUR|USD|GBP)\s*$/i);
      if (embedded) {
        const n2 = parseNumber(embedded[1]);
        if (n2 !== null && n2 !== undefined) {
          amount = /^levantamento/.test(normalizeHeader(description)) ? -Math.abs(n2) : Math.abs(n2);
        }
      }
    }
    if (amount === null) {
      rejected.push({ line: n + 1, reason: 'Valor da transação inválido', raw: lines[n] });
      continue;
    }
    if (amount === undefined) {
      rejected.push({ line: n + 1, reason: 'Não foi possível determinar o valor desta linha', raw: lines[n] });
      continue;
    }

    let quantity = 0;
    let price = 0;
    if (qColExplicit >= 0 || prColExplicit >= 0) {
      const qv = qColExplicit >= 0 ? parseNumber(cells[qColExplicit]) : undefined;
      const pv = prColExplicit >= 0 ? parseNumber(cells[prColExplicit]) : undefined;
      if (qv === null || pv === null) {
        rejected.push({ line: n + 1, reason: 'Quantidade/preço inválidos', raw: lines[n] });
        continue;
      }
      quantity = qv ?? 0;
      price = pv ?? 0;
    } else if (operation === 'buy' || operation === 'sell') {
      const extracted = extractQuantityPrice(description);
      if (extracted) {
        quantity = extracted.quantity;
        price = extracted.price;
      } else if (Math.abs(amount) > 0) {
        // não conseguimos ler "3 SAP SE@147,54 EUR" — regista pelo menos o valor em dinheiro,
        // com quantidade 1 e preço = valor, para não perder o movimento; fica sinalizado.
        quantity = 1;
        price = Math.abs(amount);
        rejected.push({ line: n + 1, reason: 'Compra/venda registada, mas não foi possível ler a quantidade/preço exatos na descrição', raw: lines[n] });
      }
    }

    const isAssetRow = Boolean(isin) || (product && !internal && category !== 'DEGIRO' && category !== 'Depósito' && category !== 'Juros');

    const row = {
      tradedOn,
      product: product || 'Movimento de conta',
      isin: isin || undefined,
      operation,
      quantity,
      price,
      amount,
      description,
      category,
      internal: Boolean(internal),
      isAssetRow: Boolean(isAssetRow),
    };
    row.externalHash = hashRow(JSON.stringify(row));
    rows.push(row);
  }

  return { rows, rejected };
}

/* =========================================================================
   IMPORTAÇÃO DEGIRO → ESTADO DA APP
   Correções face à versão anterior:
   1) Se não existir conta DEGIRO, cria-se automaticamente (antes a
      importação falhava sem visibilidade se não a criasses primeiro à mão).
   2) As transações de investimento passam a ficar ligadas à conta (accountId),
      para o saldo da conta refletir compras/vendas/comissões corretamente.
   3) Comissões/impostos deixam de ser contabilizados a dobrar (antes entravam
      no custo da posição E como despesa em dinheiro ao mesmo tempo).
   ========================================================================= */

function importDegiroRows(state, rows) {
  let accounts = state.accounts;
  let account = accounts.find((a) => a.type === 'broker' && a.name.toLowerCase().includes('degiro'));
  let createdAccount = false;
  if (!account) {
    account = { id: uid(), name: 'DEGIRO', type: 'broker', openingBalance: 0, active: true };
    accounts = [...accounts, account];
    createdAccount = true;
  }

  const existingIds = new Set([...state.cash.map((t) => t.id), ...state.investments.map((t) => t.id)]);
  const cash = [...state.cash];
  const investments = [...state.investments];
  let imported = 0;
  let skippedDuplicates = 0;

  for (const row of rows) {
    if (existingIds.has(row.externalHash)) {
      skippedDuplicates++;
      continue;
    }
    const isTradeOp = ['buy', 'sell', 'dividend', 'fee', 'tax'].includes(row.operation);

    if (row.isAssetRow && isTradeOp) {
      investments.push({
        id: row.externalHash,
        accountId: account.id,
        assetKey: row.isin || row.product,
        assetName: row.product,
        operation: row.operation,
        date: row.tradedOn,
        quantity: Math.abs(row.quantity || 0),
        price: Math.abs(row.price || 0),
        amount: Math.abs(row.amount || 0),
      });
      imported++;
    } else {
      cash.push({
        id: row.externalHash,
        accountId: account.id,
        type: row.amount >= 0 ? 'income' : 'expense',
        amount: Math.abs(row.amount),
        date: row.tradedOn,
        category: row.category || 'DEGIRO',
        description: row.description || row.product,
      });
      imported++;
    }
    existingIds.add(row.externalHash);
  }

  return { state: { ...state, accounts, cash, investments }, imported, skippedDuplicates, createdAccount, account };
}

/* =========================================================================
   COTAÇÕES AUTOMÁTICAS (Yahoo Finance, via proxy CORS público)
   O endpoint da Yahoo Finance não envia cabeçalhos CORS, por isso o browser
   bloqueia o pedido direto (foi por isso que a versão anterior tinha uma
   Edge Function a fazer de intermediária). Sem servidor próprio, a única
   forma de isto funcionar 100% no browser é passar por um proxy CORS
   público e gratuito. Isto é menos fiável do que um servidor teu (o proxy
   pode ficar em baixo ou ter limites de utilização) — por isso o botão de
   cotação manual continua sempre disponível como alternativa garantida.
   ========================================================================= */

// Vários proxies CORS gratuitos, tentados por ordem — se o primeiro falhar ou
// estiver em baixo, tenta o seguinte automaticamente antes de desistir. Cada
// tentativa tem um limite de tempo para nunca deixar o botão preso "a carregar".
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseYahooChartJson(json) {
  if (json?.chart?.error) throw new Error(json.chart.error.description || 'Ticker não encontrado');
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close?.filter((v) => v !== null && v !== undefined);
  const price = closes?.length ? closes[closes.length - 1] : result?.meta?.regularMarketPrice;
  if (typeof price !== 'number') throw new Error('Sem cotação válida na resposta.');
  return { price, currency: result?.meta?.currency || null };
}

async function fetchYahooQuote(ticker) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  let lastError = new Error('Nenhum serviço de cotações respondeu.');
  for (const buildProxyUrl of CORS_PROXIES) {
    try {
      const res = await fetchWithTimeout(buildProxyUrl(target), 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text); // se o proxy devolver HTML/texto em vez de JSON, falha aqui e passa ao próximo proxy
      return parseYahooChartJson(json);
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error('O serviço demorou demasiado tempo a responder.') : err;
      // tenta o proxy seguinte
    }
  }
  throw lastError;
}




/* =========================================================================
   ESTADO DA APLICAÇÃO E ROUTER
   ========================================================================= */

let state = loadState();
let page = 'Dashboard';
let range = 'Último mês';
let mobileOpen = false;
let lastImportResult = null; // { rows, rejected } vindo do parser
let lastImportSummary = null; // texto amigável sobre o que foi importado
let quoteFetchErrors = {}; // { [assetKey]: mensagem de erro do último pedido automático, se falhou }
let autoRefreshTimer = null;

/* =========================================================================
   ATUALIZAÇÃO AUTOMÁTICA DE COTAÇÕES
   Enquanto a aba do browser estiver aberta, a app atualiza sozinha as
   cotações de hora a hora, e faz uma atualização inicial ao abrir se os
   dados já tiverem mais de 1 hora. Nota honesta: isto só corre enquanto o
   browser está aberto — uma página estática sem servidor não consegue
   atualizar-se "em segundo plano" com o browser fechado (isso precisaria
   de um cron job num backend, que é a fase seguinte do projeto).
   ========================================================================= */

const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

async function refreshAllQuotesQuietly() {
  const pending = Object.entries(state.tickers).filter(([, t]) => t);
  if (!pending.length) return;
  for (const [key, ticker] of pending) {
    try {
      const { price, currency } = await fetchYahooQuote(ticker);
      delete quoteFetchErrors[key];
      state = { ...state, quotes: { ...state.quotes, [key]: { price, currency, updatedAt: new Date().toISOString(), manual: false, stale: false } } };
      saveState(state);
    } catch (err) {
      quoteFetchErrors[key] = `Não foi possível atualizar automaticamente (${err.message || 'erro desconhecido'}).`;
      if (state.quotes[key]) {
        state = { ...state, quotes: { ...state.quotes, [key]: { ...state.quotes[key], stale: true } } };
        saveState(state);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500)); // pausa entre pedidos, para não sobrecarregar os proxies gratuitos
  }
  if (page === 'Portfólio') renderAll();
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(refreshAllQuotesQuietly, AUTO_REFRESH_INTERVAL_MS);
  // atualização inicial se alguma cotação tiver mais de 1 hora (ou nunca foi buscada), sem bloquear o arranque da app
  setTimeout(() => {
    const needsRefresh = Object.keys(state.tickers).some((key) => {
      const q = state.quotes[key];
      return !q || !q.updatedAt || Date.now() - new Date(q.updatedAt).getTime() > AUTO_REFRESH_INTERVAL_MS;
    });
    if (needsRefresh) refreshAllQuotesQuietly();
  }, 1500);
}

function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'agora mesmo';
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.round(hours / 24);
  return `há ${days}d`;
}

async function refreshSingleQuote(key, ticker, btn) {
  const originalText = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '↻…';
  }
  try {
    const { price, currency } = await fetchYahooQuote(ticker);
    delete quoteFetchErrors[key];
    state = { ...state, quotes: { ...state.quotes, [key]: { price, currency, updatedAt: new Date().toISOString(), manual: false, stale: false } } };
    saveState(state);
  } catch (err) {
    quoteFetchErrors[key] = `Não foi possível atualizar automaticamente (${err.message || 'erro desconhecido'}). ${state.quotes[key] ? 'A manter a última cotação conhecida.' : 'Insere a cotação manualmente.'}`;
    if (state.quotes[key]) {
      state = { ...state, quotes: { ...state.quotes, [key]: { ...state.quotes[key], stale: true } } };
      saveState(state);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
  if (btn) renderAll();
}

function update(nextState, toastMsg) {
  state = nextState;
  saveState(state);
  renderAll();
  if (toastMsg) showToast(toastMsg);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.style.display = 'none'), 2600);
}

function goTo(nextPage) {
  page = nextPage;
  mobileOpen = false;
  renderAll();
}

/* ---------- Render principal ---------- */

const PAGE_TITLES = {
  Dashboard: 'Bom dia 👋',
  Contas: 'Contas',
  'Transações': 'Transações',
  'Relatórios': 'Relatórios',
  'Portfólio': 'Portfólio',
  'Importar DEGIRO': 'Importar DEGIRO',
  'Definições': 'Definições',
};

function renderAll() {
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  document.getElementById('sidebar').classList.toggle('open', mobileOpen);

  const portfolio = computePortfolio(state.investments, state.quotes);
  const total = netWorth(state.accounts, state.cash, state.investments, portfolio);
  const content = document.getElementById('content');

  if (page === 'Dashboard') content.innerHTML = renderDashboard(portfolio, total);
  else if (page === 'Contas') content.innerHTML = renderAccounts();
  else if (page === 'Transações') content.innerHTML = renderTransactions();
  else if (page === 'Relatórios') content.innerHTML = renderReports();
  else if (page === 'Portfólio') content.innerHTML = renderPortfolio(portfolio.map((p) => ({ ...p, fetchError: quoteFetchErrors[p.assetKey] })));
  else if (page === 'Importar DEGIRO') content.innerHTML = renderImport();
  else content.innerHTML = renderSettings();

  attachPageHandlers(portfolio);
}

/* ---------- Dashboard ---------- */

function renderDashboard(portfolio, total) {
  const liquidity = state.accounts.filter((a) => a.active).reduce((s, a) => s + accountBalance(a, state.cash, state.investments), 0);
  const invested = total - liquidity;
  const groups = groupExpensesByCategory(state.cash, range);
  const groupEntries = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const maxGroup = Math.max(...Object.values(groups), 1);
  const liquidityPct = total ? Math.round((liquidity / total) * 100) : 0;

  return `
    <section class="hero-grid">
      <div class="networth-card">
        <span class="eyebrow light">Património líquido total</span>
        <h2>${money(total)}</h2>
        <span class="positive">Atualizado com os teus dados locais</span>
      </div>
      <div class="card distribution">
        <h3>Distribuição</h3>
        <p>Valores calculados a partir dos teus dados.</p>
        <div class="donut-wrap">
          <div class="donut" style="background:conic-gradient(#0f766e 0 ${liquidityPct}%, #e5a844 ${liquidityPct}% 100%)">
            <div><strong>${money(total)}</strong><span>Total</span></div>
          </div>
          <div class="legend">
            <div class="legend-row"><span><b style="background:#0f766e"></b>Liquidez</span><strong>${liquidityPct}%</strong></div>
            <div class="legend-row"><span><b style="background:#e5a844"></b>Investimentos</span><strong>${total ? Math.round((invested / total) * 100) : 0}%</strong></div>
          </div>
        </div>
      </div>
    </section>
    <section class="lower-grid">
      <div class="card spending">
        <div class="section-heading">
          <div><h3>Despesas por categoria</h3><p>Período selecionado</p></div>
          <select id="range-select">${rangeOptions()}</select>
        </div>
        <div class="bars">
          ${
            groupEntries.length
              ? groupEntries
                  .map(([name, value]) => `
                <div class="bar-row"><span>${escapeHtml(name)}</span>
                  <div class="bar-track"><div style="width:${Math.min(100, (value / maxGroup) * 100)}%;background:#0f766e"></div></div>
                  <strong>${money(value)}</strong>
                </div>`)
                  .join('')
              : '<p class="muted" style="font-size:11px">Sem despesas neste período.</p>'
          }
        </div>
      </div>
      <div class="card accounts">
        <div class="section-heading">
          <div><h3>Contas</h3><p>Saldos atuais</p></div>
          <button type="button" class="link-button" data-goto="Contas">Gerir contas ↗</button>
        </div>
        ${state.accounts.filter((a) => a.active).map((a) => accountRow(a)).join('') || '<p class="muted" style="font-size:11px">Ainda não tens contas.</p>'}
      </div>
    </section>
    <section class="card activity">
      <h3>Transações recentes</h3>
      ${transactionTable(false)}
    </section>
  `;
}

function accountRow(a) {
  return `
    <div class="account-row">
      <span class="bank-icon">${escapeHtml(a.name[0] || '?')}</span>
      <span class="account-name"><strong>${escapeHtml(a.name)}</strong><small>${accountTypeLabel(a.type)}</small></span>
      <strong>${money(accountBalance(a, state.cash, state.investments))}</strong>
    </div>`;
}

function accountTypeLabel(type) {
  return { bank: 'Banco', broker: 'Corretora', cash: 'Numerário' }[type] || type;
}

function rangeOptions() {
  return ['Último mês', '3 meses', '6 meses', '12 meses', 'Ano atual']
    .map((r) => `<option value="${r}" ${r === range ? 'selected' : ''}>${r}</option>`)
    .join('');
}

/* ---------- Contas ---------- */

function renderAccounts() {
  return `
    <section class="card page-card">
      <div class="section-heading">
        <div><h2>Contas</h2><p>Cria, edita, inativa e reativa contas.</p></div>
        <button class="primary" id="btn-nova-conta">＋ Nova conta</button>
      </div>
      ${
        state.accounts.length
          ? state.accounts.map((a) => `
        <div class="account-row ${a.active ? '' : 'inactive'}">
          <span class="bank-icon">${escapeHtml(a.name[0] || '?')}</span>
          <span class="account-name">
            <strong>${escapeHtml(a.name)}</strong>
            <small>${a.active ? 'Ativa' : 'Inativa'} · ${accountTypeLabel(a.type)} · ${money(accountBalance(a, state.cash, state.investments))}</small>
          </span>
          <button type="button" class="link-button" data-edit-account="${a.id}">Editar</button>
          ${
            a.active
              ? `<button type="button" class="link-button" data-deactivate-account="${a.id}">Inativar</button>`
              : `<button type="button" class="link-button" data-activate-account="${a.id}">Reativar</button>`
          }
        </div>`).join('')
          : '<div class="empty"><strong>Ainda não tens contas. Cria a primeira para começar.</strong></div>'
      }
    </section>
  `;
}

/* ---------- Transações ---------- */

function renderTransactions() {
  return `
    <section class="card page-card">
      <div class="section-heading">
        <div><h2>Transações</h2><p>Receitas e despesas com impacto imediato no saldo.</p></div>
        <button class="primary" id="btn-nova-transacao-page">＋ Nova</button>
      </div>
      ${transactionTable(true)}
    </section>
  `;
}

function transactionTable(editable) {
  const rows = [...state.cash].sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) return '<div class="empty"><strong>Ainda não há transações.</strong></div>';
  return `
    <div class="table-scroll">
      <table>
        <thead><tr><th>DESCRIÇÃO</th><th>CATEGORIA</th><th>DATA</th><th>CONTA</th><th class="align-right">VALOR</th>${editable ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${rows
            .map((t) => {
              const acc = state.accounts.find((a) => a.id === t.accountId);
              return `<tr>
                <td><strong>${escapeHtml(t.description || '—')}</strong></td>
                <td>${escapeHtml(t.category || '—')}</td>
                <td>${fmtDate(t.date)}</td>
                <td>${acc ? escapeHtml(acc.name) : '—'}</td>
                <td class="align-right ${t.type === 'income' ? 'positive' : 'negative'}">${t.type === 'income' ? '+' : '−'} ${money(t.amount)}</td>
                ${editable ? `<td><button type="button" class="link-button" data-delete-transaction="${t.id}">Eliminar</button></td>` : ''}
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---------- Relatórios ---------- */

function renderReports() {
  const groups = groupExpensesByCategory(state.cash, range);
  const entries = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...Object.values(groups), 1);
  return `
    <section class="card page-card">
      <div class="section-heading">
        <div><h2>Relatórios</h2><p>Despesas agregadas por categoria.</p></div>
        <select id="range-select-reports">${rangeOptions()}</select>
      </div>
      <div class="bars report-bars">
        ${
          entries.length
            ? entries
                .map(([k, v]) => `<div class="bar-row"><span>${escapeHtml(k)}</span><div class="bar-track"><div style="width:${Math.min(100, (v / max) * 100)}%;background:#0f766e"></div></div><strong>${money(v)}</strong></div>`)
                .join('')
            : '<p class="muted" style="font-size:11px">Sem despesas neste período.</p>'
        }
      </div>
      <button class="link-button" id="btn-export-csv" style="margin-top:16px">Exportar CSV ↗</button>
    </section>
  `;
}

/* ---------- Portfólio ---------- */

function renderPortfolio(portfolio) {
  return `
    <section class="card page-card">
      <div class="section-heading">
        <div><h2>Portfólio</h2><p>Define o ticker da Yahoo Finance para cada posição (ex.: SAP.DE) — a partir daí a app atualiza a cotação sozinha de hora a hora, enquanto tiveres esta aba aberta. Se preferires, também podes atualizar ou corrigir na hora.</p></div>
        <button type="button" class="link-button" id="btn-refresh-all">↻ Atualizar todas as cotações</button>
      </div>
      ${
        portfolio.length
          ? portfolio
              .map(
                (p) => `
        <div class="account-row">
          <span class="bank-icon">↗</span>
          <span class="account-name">
            <strong>${escapeHtml(p.assetName)}</strong>
            <small>${p.quantity} unid. · custo médio ${money(p.averageCost)} · cotação ${money(p.price)}${p.quote?.currency && p.quote.currency !== 'EUR' ? ` <span class="stale">moeda: ${escapeHtml(p.quote.currency)}</span>` : ''}${p.quote?.stale ? ' <span class="stale">desatualizada</span>' : ''}${p.quote?.updatedAt ? ` <span class="muted">(${timeAgo(p.quote.updatedAt)})</span>` : ''} · P&amp;L realizado ${money(p.realizedPnl)}</small>
            ${p.error ? `<span class="error-tag">${escapeHtml(p.error)}</span>` : ''}
            ${p.fetchError ? `<span class="error-tag">${escapeHtml(p.fetchError)}</span>` : ''}
          </span>
          <strong class="${p.unrealizedPnl >= 0 ? 'positive' : 'negative'}">${money(p.unrealizedPnl)}</strong>
        </div>
        <div class="account-row" style="margin-top:-8px 0 17px">
          <span style="width:28px;flex-shrink:0"></span>
          <input type="text" class="quote-input" style="width:110px!important" placeholder="ticker Yahoo (ex. SAP.DE)" data-ticker-input="${escapeAttr(p.assetKey)}" value="${escapeAttr(state.tickers[p.assetKey] || '')}" />
          <button type="button" class="link-button" data-refresh-quote="${escapeAttr(p.assetKey)}">↻ Atualizar</button>
          <input type="text" class="quote-input" placeholder="cotação manual" data-quote-input="${escapeAttr(p.assetKey)}" value="${p.quote ? p.quote.price : ''}" />
          <button type="button" class="link-button" data-save-quote="${escapeAttr(p.assetKey)}">Guardar</button>
        </div>`
              )
              .join('')
          : '<div class="empty"><strong>Importa um CSV DEGIRO para criar posições.</strong></div>'
      }
    </section>
  `;
}

/* ---------- Importar DEGIRO ---------- */

function renderImport() {
  const result = lastImportResult;
  return `
    <section class="card import-card">
      <div class="section-heading">
        <div><h2>Importar DEGIRO</h2><p>Suporta o ficheiro Account.csv exportado pela DEGIRO. Linhas já importadas são ignoradas automaticamente (sem duplicados).</p></div>
        <label class="primary upload">⇧ Escolher CSV
          <input type="file" accept=".csv,text/csv" hidden id="input-degiro-file" />
        </label>
      </div>
      ${
        lastImportSummary
          ? `<div class="import-result"><strong>${escapeHtml(lastImportSummary)}</strong></div>`
          : ''
      }
      ${
        result
          ? `
        <div class="import-result">
          <strong>${result.rows.length} linhas aceites</strong>
          <p>${result.rejected.length} linhas rejeitadas</p>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>DATA</th><th>PRODUTO</th><th>OPERAÇÃO</th><th>CATEGORIA</th><th>QUANTIDADE</th><th>PREÇO</th><th class="align-right">VALOR</th></tr></thead>
            <tbody>
              ${result.rows
                .map(
                  (r) => `<tr>
                    <td>${r.tradedOn}</td>
                    <td>${escapeHtml(r.product)}</td>
                    <td>${r.operation}</td>
                    <td>${escapeHtml(r.category)}${r.internal ? ' <small class="muted">(interno)</small>' : ''}</td>
                    <td>${r.operation === 'buy' || r.operation === 'sell' ? r.quantity : '—'}</td>
                    <td>${r.operation === 'buy' || r.operation === 'sell' ? money(r.price) : '—'}</td>
                    <td class="align-right ${r.amount >= 0 ? 'positive' : 'negative'}">${money(r.amount)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        ${
          result.rejected.length
            ? `<div class="rejected-list">${result.rejected.map((r) => `<p class="negative" style="font-size:11px">Linha ${r.line}: ${escapeHtml(r.reason)}</p>`).join('')}</div>`
            : ''
        }`
          : '<div class="empty"><strong>Escolhe um CSV exportado da DEGIRO para começar.</strong></div>'
      }
    </section>
  `;
}

/* ---------- Definições ---------- */

function renderSettings() {
  return `
    <section class="card page-card">
      <h2>Definições</h2>
      <p style="font-size:12px;color:#89999a">Aplicação a correr apenas em modo local (localStorage). A ligação ao Supabase será ativada numa fase seguinte, sem perder os dados que já tens aqui.</p>
      <button class="primary" id="btn-limpar-dados">Limpar todos os dados locais</button>
    </section>
  `;
}

/* =========================================================================
   HANDLERS / EVENTOS
   ========================================================================= */

function attachPageHandlers(portfolio) {
  document.getElementById('btn-nova-transacao')?.addEventListener('click', () => openModal('transaction'));
  document.getElementById('btn-nova-transacao-page')?.addEventListener('click', () => openModal('transaction'));
  document.getElementById('btn-nova-conta')?.addEventListener('click', () => openModal('account'));
  document.getElementById('btn-limpar-dados')?.addEventListener('click', () => {
    if (confirm('Isto apaga todos os dados locais. Continuar?')) {
      localStorage.removeItem(STORAGE_KEY);
      update(emptyState(), 'Dados locais limpos.');
    }
  });

  document.getElementById('range-select')?.addEventListener('change', (e) => {
    range = e.target.value;
    renderAll();
  });
  document.getElementById('range-select-reports')?.addEventListener('change', (e) => {
    range = e.target.value;
    renderAll();
  });

  document.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => goTo(btn.dataset.goto)));

  document.querySelectorAll('[data-edit-account]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const acc = state.accounts.find((a) => a.id === btn.dataset.editAccount);
      const name = prompt('Nome da conta', acc.name)?.trim();
      if (name) update({ ...state, accounts: state.accounts.map((a) => (a.id === acc.id ? { ...a, name } : a)) }, 'Conta atualizada.');
    })
  );
  document.querySelectorAll('[data-deactivate-account]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (confirm('Inativar conta?')) {
        update({ ...state, accounts: state.accounts.map((a) => (a.id === btn.dataset.deactivateAccount ? { ...a, active: false } : a)) }, 'Conta inativada.');
      }
    })
  );
  document.querySelectorAll('[data-activate-account]').forEach((btn) =>
    btn.addEventListener('click', () => {
      update({ ...state, accounts: state.accounts.map((a) => (a.id === btn.dataset.activateAccount ? { ...a, active: true } : a)) }, 'Conta reativada.');
    })
  );

  document.querySelectorAll('[data-delete-transaction]').forEach((btn) =>
    btn.addEventListener('click', () => {
      update({ ...state, cash: state.cash.filter((t) => t.id !== btn.dataset.deleteTransaction) }, 'Transação eliminada.');
    })
  );

  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const groups = groupExpensesByCategory(state.cash, range);
    const csv = 'Categoria,Valor\n' + Object.entries(groups).map(([k, v]) => `${k},${v}`).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relatorio.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelectorAll('[data-save-quote]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.saveQuote;
      const input = document.querySelector(`[data-quote-input="${cssEscape(key)}"]`);
      const price = parseAmountInput(input.value);
      if (!Number.isFinite(price) || price < 0) {
        alert('Indica uma cotação válida.');
        return;
      }
      update({ ...state, quotes: { ...state.quotes, [key]: { price, updatedAt: new Date().toISOString(), manual: true } } }, 'Cotação atualizada.');
    })
  );

  document.querySelectorAll('[data-ticker-input]').forEach((input) =>
    input.addEventListener('change', () => {
      const key = input.dataset.tickerInput;
      const ticker = input.value.trim().toUpperCase();
      const tickers = { ...state.tickers };
      if (ticker) tickers[key] = ticker;
      else delete tickers[key];
      state = { ...state, tickers };
      saveState(state);
    })
  );

  document.querySelectorAll('[data-refresh-quote]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.refreshQuote;
      const tickerInput = document.querySelector(`[data-ticker-input="${cssEscape(key)}"]`);
      const ticker = tickerInput?.value.trim().toUpperCase();
      if (!ticker) {
        alert('Escreve primeiro o ticker da Yahoo Finance para este ativo (ex.: SAP.DE). Procura o teu ativo em finance.yahoo.com para confirmar o símbolo certo.');
        return;
      }
      await refreshSingleQuote(key, ticker, btn);
    })
  );

  document.getElementById('btn-refresh-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const pending = Object.entries(state.tickers).filter(([, t]) => t);
    if (!pending.length) {
      alert('Ainda não definiste nenhum ticker. Escreve o ticker da Yahoo Finance junto de cada ativo primeiro.');
      return;
    }
    btn.disabled = true;
    btn.textContent = '↻ A atualizar…';
    for (const [key, ticker] of pending) {
      await refreshSingleQuote(key, ticker, null);
    }
    btn.disabled = false;
    btn.textContent = '↻ Atualizar todas as cotações';
    renderAll();
  });

  document.getElementById('input-degiro-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const result = parseDegiroCsv(text);
    lastImportResult = result;
    if (result.rows.length) {
      const { state: nextState, imported, skippedDuplicates, createdAccount, account } = importDegiroRows(state, result.rows);
      state = nextState;
      saveState(state);
      const parts = [`${imported} movimento(s) importado(s) para a conta "${account.name}".`];
      if (skippedDuplicates) parts.push(`${skippedDuplicates} já tinham sido importados antes e foram ignorados.`);
      if (createdAccount) parts.push('Conta DEGIRO criada automaticamente porque ainda não existia.');
      lastImportSummary = parts.join(' ');
    } else {
      lastImportSummary = 'Nenhuma linha válida foi encontrada no ficheiro.';
    }
    renderAll();
    e.target.value = '';
  });

  document.getElementById('open-menu')?.addEventListener('click', () => {
    mobileOpen = true;
    renderAll();
  });
  document.getElementById('close-menu')?.addEventListener('click', () => {
    mobileOpen = false;
    renderAll();
  });
}

/* ---------- Modal (Nova conta / Nova transação) ---------- */

function openModal(kind) {
  const root = document.getElementById('modal-root');
  root.classList.add('show');
  root.innerHTML = modalMarkup(kind);
  root.addEventListener('click', (e) => {
    if (e.target === root) closeModal();
  }, { once: true });
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-form')?.addEventListener('submit', (e) => handleModalSubmit(e, kind));
}

function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.remove('show');
  root.innerHTML = '';
}

function modalMarkup(kind) {
  if (kind === 'account') {
    return `
      <form class="modal" id="modal-form" novalidate>
        <button type="button" class="modal-close" id="modal-close">✕</button>
        <h2>Nova conta</h2>
        <label>Nome<input name="name" required /></label>
        <label>Tipo<select name="type"><option value="bank">Banco</option><option value="broker">Corretora</option><option value="cash">Numerário</option></select></label>
        <label>Saldo inicial<input name="amount" inputmode="decimal" required /></label>
        <button class="primary full">Guardar</button>
      </form>`;
  }
  const activeAccounts = state.accounts.filter((a) => a.active);
  return `
    <form class="modal" id="modal-form" novalidate>
      <button type="button" class="modal-close" id="modal-close">✕</button>
      <h2>Nova transação</h2>
      <label>Tipo<select name="type"><option value="expense">Despesa</option><option value="income">Receita</option></select></label>
      <label>Valor<input name="amount" inputmode="decimal" required /></label>
      <label>Data<input type="date" name="date" value="${today()}" required /></label>
      <label>Conta<select name="accountId" required>${activeAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></label>
      <label>Categoria<input name="category" required /></label>
      <label>Descrição<input name="description" required /></label>
      <button class="primary full">Guardar</button>
    </form>`;
}

function handleModalSubmit(e, kind) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  if (kind === 'account') {
    const opening = parseAmountInput(f.get('amount'));
    const name = String(f.get('name')).trim();
    if (!name || !Number.isFinite(opening) || opening < 0) {
      alert('Preenche um nome e um saldo válido.');
      return;
    }
    update({ ...state, accounts: [...state.accounts, { id: uid(), name, type: f.get('type'), openingBalance: opening, active: true }] }, 'Conta criada.');
  } else {
    if (!state.accounts.some((a) => a.active)) {
      alert('Cria primeiro uma conta ativa.');
      return;
    }
    const amount = parseAmountInput(f.get('amount'));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Indica um valor maior que zero.');
      return;
    }
    const tx = {
      id: uid(),
      accountId: String(f.get('accountId')),
      type: f.get('type'),
      amount,
      date: String(f.get('date')),
      category: String(f.get('category')).trim(),
      description: String(f.get('description')).trim(),
    };
    update({ ...state, cash: [tx, ...state.cash] }, 'Transação guardada.');
  }
  closeModal();
}

/* ---------- Helpers de escape ---------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
function cssEscape(str) {
  return String(str).replace(/["\\]/g, '\\$&');
}

/* =========================================================================
   ARRANQUE
   ========================================================================= */

document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => goTo(btn.dataset.page)));
renderAll();
startAutoRefresh();
