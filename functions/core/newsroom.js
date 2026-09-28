'use strict';
/* 星界新聞網：把私有市場事件轉成多家媒體的公開報導。
   公開資料只含文章與事後查證結果；事件真相、媒體立場與正確性放在 marketAdmin/newsroom。 */

const { AppError, TW_OFFSET } = require('./util');
const { STOCKS, shockDayKey, shockSlot, slotClock } = require('./market');

const ARTICLE_LIMIT = 80;
const CLUSTER_LIMIT = 24;

const OUTLETS = [
  { id: 'central', name: '星界中央社', short: '中央社', accent: '#6ee7ff', motto: '文件、政策與正式聲明', mark: '央' },
  { id: 'token', name: 'TOKEN 財經', short: 'TOKEN 財經', accent: '#7cf0b2', motto: '數據、產業與資金流向', mark: 'T' },
  { id: 'royal', name: '皇家快報', short: '皇家快報', accent: '#ffd36d', motto: '最快、最敢問，也最有爭議', mark: 'R' },
  { id: 'deepnet', name: '深網觀測站', short: '深網觀測', accent: '#bd91ff', motto: '匿名線索與未公開文件', mark: '深' }
];

const COMPANY = {
  TKN: { sector: '科技', place: '天穹自由港', product: '雲端核心與通訊晶片', partner: '軌道運輸署', issue: '資料中心與供應鏈' },
  BNK: { sector: '金融', place: '星環金融區', product: '跨境清算與企業授信', partner: '中央清算局', issue: '資本適足率與呆帳' },
  DRG: { sector: '娛樂', place: '龍焰影城園區', product: '沉浸式內容與全球授權', partner: '北境媒體聯盟', issue: '開發進度與授權成本' },
  ROY: { sector: '觀光娛樂', place: '皇家海灣特區', product: '綜合度假與競技娛樂', partner: '海灣觀光署', issue: '牌照審查與旅客流量' },
  TRS: { sector: '收藏', place: '秘寶交易港', product: '稀有收藏與鑑定服務', partner: '古物保全公會', issue: '真偽鑑定與物流履約' }
};

const WORLD_REGIONS = ['北境聯盟', '天穹共和國', '赤環群島', '月海自由港'];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function rndOf(random) { return typeof random === 'function' ? random : Math.random; }
function pick(rnd, list) { return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))]; }
function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function outletOf(id) { return OUTLETS.find((x) => x.id === id) || OUTLETS[0]; }
function companyOf(symbol) { return COMPANY[symbol] || COMPANY.TKN; }
function stockOf(state, symbol) {
  const live = state && state.stocks && state.stocks[symbol];
  const def = STOCKS.find((x) => x.symbol === symbol) || STOCKS[0];
  return live || def;
}
function dayKey(t) { return shockDayKey(t); }
function newsroomWindow(t) {
  const d = new Date(Number(t) + TW_OFFSET);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 7 * 60 && mins <= 16 * 60 + 5;
}

function publicOutlet(row) {
  return { id: row.id, name: row.name, short: row.short, accent: row.accent, motto: row.motto, mark: row.mark };
}

function freshNewsroom(t) {
  const at = Number(t) || 0;
  return {
    version: 1,
    updatedAt: at,
    leadId: 'welcome-central',
    outlets: OUTLETS.map(publicOutlet),
    clusters: [{
      id: 'welcome', publishedAt: at, updatedAt: at, status: 'background', category: '編輯台',
      symbols: [], headline: '星界新聞網開台：同一事件，四種說法', articleIds: ['welcome-central']
    }],
    articles: [{
      id: 'welcome-central', clusterId: 'welcome', outlet: 'central', publishedAt: at, updatedAt: at,
      category: '編輯台', size: 'standard', symbols: [], status: 'background', verdict: '',
      headline: '星界新聞網開台：同一事件，四種說法',
      deck: '我們不會直接告訴你哪支股票要漲或跌；玩家要從來源、數字與多家報導的落差自行判斷。',
      body: [
        '星界新聞網正式上線。編輯台會追蹤公司公告、政策文件、產業數據與匿名線索，並保留不同媒體對同一事件的解讀。',
        '部分消息最後可能只被證實一部分，甚至遭到完全否認。文章會留下時間、來源類型與事後查證結果，方便讀者回頭檢查當時的判斷。'
      ], sourceNote: '編輯台公告', readingMin: 1
    }]
  };
}

function normalizeArticle(raw, t) {
  const outlet = outletOf(raw && raw.outlet);
  const body = Array.isArray(raw && raw.body) ? raw.body.map((x) => cleanText(x, 900)).filter(Boolean).slice(0, 6) : [];
  return {
    id: cleanText(raw && raw.id, 72), clusterId: cleanText(raw && raw.clusterId, 72), outlet: outlet.id,
    publishedAt: Number(raw && raw.publishedAt) || t, updatedAt: Number(raw && raw.updatedAt) || t,
    category: cleanText(raw && raw.category, 20) || '市場', size: ['brief', 'standard', 'deep'].includes(raw && raw.size) ? raw.size : 'standard',
    symbols: (Array.isArray(raw && raw.symbols) ? raw.symbols : []).filter((s) => STOCKS.some((x) => x.symbol === s)).slice(0, 3),
    status: ['developing', 'confirmed', 'partial', 'disputed', 'background'].includes(raw && raw.status) ? raw.status : 'developing',
    verdict: cleanText(raw && raw.verdict, 90), headline: cleanText(raw && raw.headline, 90) || '市場觀察',
    deck: cleanText(raw && raw.deck, 220), body: body.length ? body : ['編輯台正在整理這則消息。'],
    sourceNote: cleanText(raw && raw.sourceNote, 80), readingMin: clamp(Math.floor(Number(raw && raw.readingMin) || 1), 1, 6)
  };
}

function normalizeCluster(raw, t) {
  return {
    id: cleanText(raw && raw.id, 72), publishedAt: Number(raw && raw.publishedAt) || t, updatedAt: Number(raw && raw.updatedAt) || t,
    status: ['developing', 'confirmed', 'partial', 'disputed', 'background'].includes(raw && raw.status) ? raw.status : 'developing',
    category: cleanText(raw && raw.category, 20) || '市場',
    symbols: (Array.isArray(raw && raw.symbols) ? raw.symbols : []).filter((s) => STOCKS.some((x) => x.symbol === s)).slice(0, 3),
    headline: cleanText(raw && raw.headline, 90) || '市場焦點',
    articleIds: (Array.isArray(raw && raw.articleIds) ? raw.articleIds : []).map((x) => cleanText(x, 72)).filter(Boolean).slice(0, 4)
  };
}

function normalizeNewsroom(raw, t) {
  const base = freshNewsroom(t);
  if (!raw || raw.version !== 1) return base;
  const articles = (Array.isArray(raw.articles) ? raw.articles : []).map((x) => normalizeArticle(x, t)).filter((x) => x.id).slice(0, ARTICLE_LIMIT);
  const ids = new Set(articles.map((x) => x.id));
  const clusters = (Array.isArray(raw.clusters) ? raw.clusters : []).map((x) => normalizeCluster(x, t)).filter((x) => x.id).map((x) => {
    x.articleIds = x.articleIds.filter((id) => ids.has(id));
    return x;
  }).filter((x) => x.articleIds.length).slice(0, CLUSTER_LIMIT);
  if (!articles.length || !clusters.length) return base;
  return {
    version: 1, updatedAt: Number(raw.updatedAt) || t,
    leadId: ids.has(raw.leadId) ? raw.leadId : articles[0].id,
    outlets: OUTLETS.map(publicOutlet), clusters, articles
  };
}

function normalizePrivate(raw, t) {
  const out = { version: 1, updatedAt: Number(t) || 0, rows: [] };
  if (!raw || raw.version !== 1) return out;
  out.updatedAt = Number(raw.updatedAt) || out.updatedAt;
  out.rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, CLUSTER_LIMIT).map((x) => ({
    clusterId: cleanText(x.clusterId, 72), eventId: cleanText(x.eventId, 72), day: cleanText(x.day, 8),
    symbol: cleanText(x.symbol, 4), truth: x.truth === 'down' ? 'down' : x.truth === 'neutral' ? 'neutral' : 'up',
    magnitude: Math.max(0, Number(x.magnitude) || 0), eventAt: Number(x.eventAt) || 0,
    publishedAt: Number(x.publishedAt) || 0, resolvedAt: Number(x.resolvedAt) || 0,
    articleTruth: x.articleTruth && typeof x.articleTruth === 'object' ? x.articleTruth : {}
  })).filter((x) => x.clusterId);
  return out;
}

function scenarioFor(event, state, random) {
  const rnd = rndOf(random), stock = stockOf(state, event.symbol), c = companyOf(event.symbol);
  const region = pick(rnd, WORLD_REGIONS);
  const up = [
    {
      category: '企業', fact: stock.name + ' 與' + c.partner + '簽署框架協議',
      official: '雙方確認將在未來兩季擴大' + c.product + '合作，但尚未公開完整金額。',
      number: '供應端資料顯示，相關採購量較上季增加 ' + Math.round(18 + rnd() * 34) + '%。',
      doubt: '匿名人士稱最終合約仍附帶履約門檻，實際收入可能晚於市場預期。'
    },
    {
      category: '國際', fact: region + '調整產業政策，' + stock.name + ' 被列入首批合作名單',
      official: '公開文件提到' + c.sector + '產業，但補助細節仍待後續命令確認。',
      number: '區域訂單追蹤顯示，' + c.product + '詢價量在兩週內上升 ' + Math.round(12 + rnd() * 28) + '%。',
      doubt: '反對陣營質疑政策財源，並要求重新審查合作名單。'
    }
  ];
  const down = [
    {
      category: '調查', fact: stock.name + ' 就' + c.issue + '接受主管機關詢問',
      official: '公司表示營運正常，並稱已主動提交所需文件，現階段沒有停業命令。',
      number: '產業資料顯示，相關業務近一月的履約速度下降 ' + Math.round(9 + rnd() * 25) + '%。',
      doubt: '知情人士聲稱問題範圍比公告更廣，但無法提供完整文件。'
    },
    {
      category: '國際', fact: region + '突然收緊跨境規則，' + stock.name + ' 啟動應變計畫',
      official: '新規則將在數日內生效，公司仍在評估對' + c.product + '的實際影響。',
      number: '物流與訂單資料出現 ' + Math.round(11 + rnd() * 29) + '% 的短期落差。',
      doubt: '匿名供應商警告替代方案成本偏高，恢復時間可能比公司說法更久。'
    }
  ];
  return pick(rnd, event.dir === 'down' ? down : up);
}

function viewpointFor(outletId, truth, random) {
  const rnd = rndOf(random);
  if (outletId === 'central') {
    const accurate = rnd() < 0.82;
    return { view: accurate ? truth : 'neutral', accurate, source: '正式文件與記者會逐字稿' };
  }
  if (outletId === 'token') {
    const roll = rnd();
    return { view: roll < 0.72 ? truth : roll < 0.9 ? 'neutral' : (truth === 'up' ? 'down' : 'up'), accurate: roll < 0.72, source: '產業數據與成交紀錄交叉比對' };
  }
  if (outletId === 'royal') {
    const accurate = rnd() < 0.35;
    return { view: accurate ? truth : (truth === 'up' ? 'down' : 'up'), accurate, source: '市場人士與未具名交易員' };
  }
  const accurate = rnd() < 0.55;
  return { view: accurate ? truth : (truth === 'up' ? 'down' : 'up'), accurate, source: '匿名文件與內部通訊截圖' };
}

function headlineFor(outletId, stock, scenario, view) {
  if (outletId === 'central') return stock.name + '回應市場關切：' + scenario.fact.replace(stock.name, '').replace(/^\s*/, '');
  if (outletId === 'token') return '數據拆解｜' + scenario.fact + '，關鍵落差仍待確認';
  if (outletId === 'royal') return view === 'up'
    ? '獨家直擊｜' + stock.name + '醞釀大動作，資金提前卡位？'
    : '市場震動｜' + stock.name + '說法藏玄機，風險恐未完全揭露';
  return view === 'up'
    ? '深網文件流出：' + stock.name + '可能握有尚未公開的第二份協議'
    : '匿名線報：' + stock.name + '內部評估與公開說法出現落差';
}

function articleFor(event, state, clusterId, outletId, scenario, t, random) {
  const rnd = rndOf(random), stock = stockOf(state, event.symbol), outlet = outletOf(outletId);
  const point = viewpointFor(outletId, event.dir, rnd);
  const positive = point.view === 'up';
  const neutral = point.view === 'neutral';
  let deck, body, size;
  if (outletId === 'central') {
    deck = scenario.official + ' 編輯台整理目前可確認與仍待釐清的部分。';
    body = [
      scenario.fact + '。' + scenario.official,
      '截至發稿，公開資料只能確認事件已進入執行或調查階段，尚不足以推算最終財務影響。公司表示若有重大進展，將依規定補充說明。',
      '讀者應留意後續正式文件的金額、期限與附帶條件，而不是只看單一標題。'
    ];
    size = 'standard';
  } else if (outletId === 'token') {
    deck = scenario.number + ' 但數字是否代表長期趨勢，仍要看下一批資料。';
    body = [
      scenario.fact + '。TOKEN 財經比對公司公告、產業資料與近期成交紀錄後，發現市場目前最容易忽略的是時間差。',
      scenario.number + (neutral ? '目前訊號互相抵銷，無法只靠單一數字下結論。' : positive ? '這項變化對短期營運較有利，但不代表所有收入會立刻入帳。' : '若落差持續，成本與履約壓力可能在下一期報表才完全出現。'),
      '接下來值得觀察三個項目：正式金額、執行時程，以及合作方是否同步更新說法。任何一項不同，都可能改變原先判斷。'
    ];
    size = 'deep';
  } else if (outletId === 'royal') {
    deck = positive ? '多名市場人士認為這可能是被低估的轉折。' : '交易圈開始質疑公開說法是否避重就輕。';
    body = [
      scenario.fact + '。皇家快報接觸的市場人士，對事件的解讀明顯比正式聲明更強烈。',
      positive ? '支持者認為相關準備不可能只是例行作業，並指出資金已提前出現異常集中。' : '質疑者認為公司沒有回答最核心的風險範圍，短期內仍可能出現更多負面細節。',
      '不過，受訪者均未提供可公開驗證的完整合約或處分文件，部分說法仍屬推測。'
    ];
    size = 'brief';
  } else {
    deck = scenario.doubt + ' 本站無法獨立確認文件來源。';
    body = [
      scenario.fact + '。深網觀測站取得的片段資料顯示，內部討論的重點與公開版本並不完全相同。',
      scenario.doubt + (positive ? ' 若文件屬實，市場可能低估後續合作範圍。' : ' 若文件屬實，現有說明可能尚未涵蓋全部風險。'),
      '文件缺少完整頁碼與簽章，發布時間也可能早於最新決策。本站將保留原始判讀，並在正式結果出現後標示查證狀態。'
    ];
    size = 'standard';
  }
  const id = clusterId + '-' + outletId;
  return {
    public: {
      id, clusterId, outlet: outlet.id, publishedAt: t, updatedAt: t, category: scenario.category,
      size, symbols: [event.symbol], status: 'developing', verdict: '',
      headline: headlineFor(outletId, stock, scenario, point.view), deck, body,
      sourceNote: point.source, readingMin: size === 'deep' ? 3 : size === 'brief' ? 1 : 2
    },
    private: { id, view: point.view, accurate: point.accurate }
  };
}

function buildEventCluster(event, state, t, random) {
  const rnd = rndOf(random), clusterId = 'event-' + dayKey(t) + '-' + cleanText(event.id || event.symbol + '-' + event.slot, 40);
  const scenario = scenarioFor(event, state, rnd);
  const count = 3 + (rnd() < 0.45 ? 1 : 0);
  const ids = count === 4 ? OUTLETS.map((x) => x.id) : ['central', 'token', rnd() < 0.5 ? 'royal' : 'deepnet'];
  const articles = ids.map((id) => articleFor(event, state, clusterId, id, scenario, t, rnd));
  const stock = stockOf(state, event.symbol);
  const articleTruth = {};
  articles.forEach((x) => { articleTruth[x.private.id] = { view: x.private.view, accurate: x.private.accurate }; });
  return {
    cluster: {
      id: clusterId, publishedAt: t, updatedAt: t, status: 'developing', category: scenario.category,
      symbols: [event.symbol], headline: scenario.fact, articleIds: articles.map((x) => x.public.id)
    },
    articles: articles.map((x) => x.public),
    privateRow: {
      clusterId, eventId: cleanText(event.id, 72), day: dayKey(t), symbol: event.symbol,
      truth: event.dir, magnitude: Number(event.size) || 0, eventAt: t + Math.max(0, Number(event.slot) - shockSlot(t)) * 5 * 60000,
      publishedAt: t, resolvedAt: 0, articleTruth
    },
    stockName: stock.name
  };
}

function buildMacroCluster(state, t, random) {
  const rnd = rndOf(random), key = dayKey(t), clusterId = 'macro-' + key;
  const region = pick(rnd, WORLD_REGIONS), other = pick(rnd, WORLD_REGIONS.filter((x) => x !== region));
  const subject = pick(rnd, ['能源運輸費率', '跨境清算規則', '數位內容授權', '稀有素材出口審查']);
  const baseEvent = { id: clusterId, symbol: pick(rnd, STOCKS).symbol, dir: rnd() < 0.5 ? 'up' : 'down', size: 0, slot: 12 };
  const scenario = {
    category: '國際', fact: region + '與' + other + '就' + subject + '展開緊急協商',
    official: '雙方只確認談判仍在進行，尚未公布生效日期與適用範圍。',
    number: '近兩週相關運輸與報價指數出現 ' + Math.round(6 + rnd() * 15) + '% 落差。',
    doubt: '匿名代表稱談判一度中斷，但兩國均未證實此說法。'
  };
  const ids = ['central', 'token', 'royal'];
  const articles = ids.map((id) => articleFor(baseEvent, state, clusterId, id, scenario, t, rnd));
  articles.forEach((x) => { x.public.symbols = []; x.public.status = 'background'; });
  return {
    cluster: { id: clusterId, publishedAt: t, updatedAt: t, status: 'background', category: '國際', symbols: [], headline: scenario.fact, articleIds: articles.map((x) => x.public.id) },
    articles: articles.map((x) => x.public)
  };
}

function prependCluster(state, built, t) {
  const articleIds = new Set(built.articles.map((x) => x.id));
  state.articles = built.articles.concat(state.articles.filter((x) => !articleIds.has(x.id))).slice(0, ARTICLE_LIMIT);
  state.clusters = [built.cluster].concat(state.clusters.filter((x) => x.id !== built.cluster.id)).slice(0, CLUSTER_LIMIT);
  const lead = built.articles.length ? built.articles[Math.floor(Number(t) / 60000) % built.articles.length] : null;
  state.leadId = lead ? lead.id : state.leadId;
  state.updatedAt = t;
}

function resolveCluster(state, privateRow, event, t) {
  if (!event || !event.applied || privateRow.resolvedAt) return false;
  privateRow.resolvedAt = Number(event.applied) || t;
  const truths = privateRow.articleTruth || {};
  const related = state.articles.filter((x) => x.clusterId === privateRow.clusterId);
  related.forEach((article) => {
    const row = truths[article.id] || {};
    article.status = row.accurate ? 'confirmed' : row.view === 'neutral' ? 'partial' : 'disputed';
    article.verdict = row.accurate
      ? '事後查證：核心方向與正式結果一致。'
      : row.view === 'neutral' ? '事後查證：部分細節成立，但結論仍有保留。' : '事後查證：主要判讀與正式結果不符。';
    article.updatedAt = t;
  });
  const cluster = state.clusters.find((x) => x.id === privateRow.clusterId);
  if (cluster) { cluster.status = 'confirmed'; cluster.updatedAt = t; }
  state.updatedAt = t;
  return true;
}

function createNewsroom({ db, now, requireSession, requireAdmin }) {
  const publicRef = () => db.collection('marketNews').doc('main');
  const privateRef = () => db.collection('marketAdmin').doc('newsroom');
  const marketRef = () => db.collection('market').doc('main');
  const engineRef = () => db.collection('marketAdmin').doc('engine');

  async function getPublic() {
    const snap = await publicRef().get();
    if (snap.exists) return normalizeNewsroom(snap.data(), now());
    const data = freshNewsroom(now());
    try { await publicRef().create(data); } catch (e) {
      const latest = await publicRef().get();
      if (latest.exists) return normalizeNewsroom(latest.data(), now());
      throw e;
    }
    return data;
  }

  async function state(req) {
    await requireSession(req);
    return { newsroom: await getPublic() };
  }

  async function publish(t, random, options) {
    const at = Number(t) || now();
    const opts = options && typeof options === 'object' ? options : { force: !!options };
    const force = !!opts.force, dailyEdition = !!opts.dailyEdition;
    if (!force && !dailyEdition && !newsroomWindow(at)) return { skipped: true, reason: 'outside-newsroom-window', updatedAt: at };
    let result = { skipped: true, published: [], resolved: [] };
    await db.runTransaction(async (tx) => {
      const [pubSnap, priSnap, marketSnap, engineSnap] = await Promise.all([
        tx.get(publicRef()), tx.get(privateRef()), tx.get(marketRef()), tx.get(engineRef())
      ]);
      const state = normalizeNewsroom(pubSnap.exists ? pubSnap.data() : null, at);
      const privateState = normalizePrivate(priSnap.exists ? priSnap.data() : null, at);
      const market = marketSnap.exists ? marketSnap.data() : { stocks: {} };
      const engine = engineSnap.exists ? engineSnap.data() : { day: '', events: [] };
      const today = dayKey(at), slot = shockSlot(at), known = new Set(privateState.rows.map((x) => x.eventId));
      const published = [], resolved = [];

      if (!state.clusters.some((x) => x.id === 'macro-' + today) && (dailyEdition || slot >= 12)) {
        const macro = buildMacroCluster(market, at, random);
        prependCluster(state, macro, at);
        published.push(macro.cluster.id);
      }

      const events = engine.day === today && Array.isArray(engine.events) ? engine.events : [];
      events.forEach((event) => {
        if (!event || known.has(String(event.id || '')) || (!dailyEdition && Number(event.hintSlot) > slot)) return;
        const built = buildEventCluster(event, market, at, random);
        prependCluster(state, built, at);
        privateState.rows.unshift(built.privateRow);
        known.add(String(event.id || ''));
        published.push(built.cluster.id);
      });

      privateState.rows.forEach((row) => {
        const event = events.find((x) => String(x.id || '') === row.eventId);
        if (resolveCluster(state, row, event, at)) resolved.push(row.clusterId);
      });

      if (!published.length && !resolved.length && pubSnap.exists && priSnap.exists) return;
      privateState.rows = privateState.rows.slice(0, CLUSTER_LIMIT);
      privateState.updatedAt = at;
      tx.set(publicRef(), state);
      tx.set(privateRef(), privateState);
      result = { skipped: false, published, resolved, articles: state.articles.length, clusters: state.clusters.length };
    });
    return result;
  }

  async function adminState(req) {
    await requireAdmin(req);
    const [pubSnap, priSnap] = await Promise.all([publicRef().get(), privateRef().get()]);
    return {
      newsroom: normalizeNewsroom(pubSnap.exists ? pubSnap.data() : null, now()),
      private: normalizePrivate(priSnap.exists ? priSnap.data() : null, now())
    };
  }

  async function adminPublish(req) {
    const admin = await requireAdmin(req);
    const result = await publish(now(), null, true);
    if (result.skipped) throw new AppError('目前沒有可發布或更新的新聞', 'no-news');
    return Object.assign({ ok: true, by: admin.pid }, result);
  }

  async function publishDailyEdition(t, random) {
    return publish(t, random, { force: true, dailyEdition: true });
  }

  return { state, adminState, adminPublish, publish, publishDailyEdition, getPublic };
}

module.exports = {
  createNewsroom, freshNewsroom, normalizeNewsroom, normalizePrivate, buildEventCluster, buildMacroCluster,
  prependCluster, resolveCluster, newsroomWindow, outletOf, OUTLETS, ARTICLE_LIMIT, CLUSTER_LIMIT
};
