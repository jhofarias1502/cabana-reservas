// Servidor de reservas da Cabana: reserva direta + sincronização com o Airbnb via iCal.
// Sem dependências externas: `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toISO, addDays, nightsBetween, overlaps, parseICal, buildICal } = require('./lib');

// --- Configuração (variáveis de ambiente ou config.json) -------------------
const fileCfg = fs.existsSync(path.join(__dirname, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) : {};
const env = (k, d) => {
  const v = process.env[k] ?? fileCfg[k] ?? d;
  // Listas podem vir de variável de ambiente como JSON ou separadas por ";"
  if (Array.isArray(d) && typeof v === 'string') { try { return JSON.parse(v); } catch { return v.split(';').map(x => x.trim()).filter(Boolean); } }
  return v;
};
const CFG = {
  PORT: Number(env('PORT', 3000)),
  CABIN_NAME: env('CABIN_NAME', 'Cabana'),
  TAGLINE: env('TAGLINE', 'Um refúgio no meio da natureza'),
  LOCATION: env('LOCATION', ''),
  DESCRIPTION: env('DESCRIPTION', ''),
  PHOTOS: env('PHOTOS', []),          // ex.: ["/fotos/capa.jpg", "/fotos/sala.jpg"] (arquivos em public/fotos)
  INSTAGRAM: env('INSTAGRAM', ''),    // ex.: cabana.oficial
  BEDROOMS: Number(env('BEDROOMS', 1)),
  BEDS: Number(env('BEDS', 1)),
  BATHROOMS: Number(env('BATHROOMS', 1)),
  AMENITIES: env('AMENITIES', ['Wi-Fi', 'Cozinha completa', 'Lareira', 'Estacionamento grátis', 'Roupa de cama', 'Vista para a natureza']),
  RULES: env('RULES', ['Proibido fumar', 'Sem festas ou eventos', 'Silêncio das 22h às 8h']),
  CHECKIN_TIME: env('CHECKIN_TIME', '15:00'),
  CHECKOUT_TIME: env('CHECKOUT_TIME', '12:00'),
  MAP_QUERY: env('MAP_QUERY', ''),    // endereço ou coordenadas para o mapa
  MAPS_URL: env('MAPS_URL', ''),      // link do Google Maps para "Como chegar"
  NEARBY: env('NEARBY', []),          // ex.: ["Estacionamento no local", "5 min do vilarejo"]
  PERKS: env('PERKS', []),            // diferenciais
  INCLUDED: env('INCLUDED', []),
  REVIEWS_SUMMARY: env('REVIEWS_SUMMARY', null), // nota, selos e categorias copiados do anúncio no Airbnb
  REVIEWS: env('REVIEWS', []),                   // [{ "name": "Ana", "date": "setembro de 2026", "text": "..." }]      // [{ "title": "Cozinha", "icon": "🍳", "items": [...], "note": "..." }]
  AIRBNB_ICAL_URLS: String(env('AIRBNB_ICAL_URLS', '')).split(',').map(s => s.trim()).filter(Boolean),
  SYNC_MINUTES: Number(env('SYNC_MINUTES', 15)),
  // Preços do site (podem ser editados no painel)
  NIGHTLY_RATE: Number(env('NIGHTLY_RATE', 400)),
  WEEKEND_RATE: Number(env('WEEKEND_RATE', 0)) || null, // sexta e sábado
  CLEANING_FEE: Number(env('CLEANING_FEE', 0)),
  STAY_DISCOUNT_PCT: Number(env('STAY_DISCOUNT_PCT', 18)),       // desconto para estadias longas
  STAY_DISCOUNT_MIN_NIGHTS: Number(env('STAY_DISCOUNT_MIN_NIGHTS', 2)), // a partir de quantas diárias
  AIRBNB_LISTING_URL: env('AIRBNB_LISTING_URL', ''),             // ex.: https://www.airbnb.com.br/rooms/123456
  MIN_NIGHTS: Number(env('MIN_NIGHTS', 2)),
  MAX_GUESTS: Number(env('MAX_GUESTS', 4)),
  HOLD_HOURS: Number(env('HOLD_HOURS', 24)),    // tempo que as datas ficam seguradas enquanto você negocia no WhatsApp
  WHATSAPP: env('WHATSAPP', ''),                 // ex.: 5511999999999
  ADMIN_PASSWORD: env('ADMIN_PASSWORD', 'troque-esta-senha'),
  FEED_TOKEN: env('FEED_TOKEN', ''),             // protege a URL do feed iCal exportado
};

// --- Armazenamento em arquivo JSON ----------------------------------------
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json'); // DATA_DIR: disco persistente na hospedagem
let db = { bookings: [], blocks: [], airbnb: [], specialRates: [], pricing: {}, lastSync: null, lastSyncError: null,
  stays: {}, costs: { perStay: [], monthly: [] }, expenses: [] };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
if (!CFG.FEED_TOKEN) { db.feedToken ||= crypto.randomBytes(12).toString('hex'); CFG.FEED_TOKEN = db.feedToken; }
function save() { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
save();

// --- Sincronização com o Airbnb -------------------------------------------
async function syncAirbnb() {
  if (!CFG.AIRBNB_ICAL_URLS.length) return;
  try {
    const all = [];
    for (const url of CFG.AIRBNB_ICAL_URLS) {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cabana-Reservas/1.0)', 'Accept': 'text/calendar,*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar o calendário ${new URL(url).hostname}`);
      all.push(...parseICal(await res.text()).map(e => ({ ...e, source: 'airbnb' })));
    }
    db.airbnb = all;
    db.lastSync = new Date().toISOString();
    db.lastSyncError = null;
    // Alerta: reserva direta que bate com uma RESERVA do Airbnb (bloqueios manuais, "Not available", não contam:
    // são o próprio anfitrião fechando as datas da reserva direta)
    for (const b of activeBookings()) {
      b.conflict = all.some(e => /reserved/i.test(e.summary || '') && overlaps(b.checkIn, b.checkOut, e.start, e.end)) || undefined;
    }
    recordAirbnbStays(all);
  } catch (err) {
    db.lastSyncError = `${new Date().toISOString()} ${err.message}`;
    console.error('Falha na sincronização:', err.message);
  }
  save();
}
async function syncIfStale(maxAgeMin = 5) {
  if (!db.lastSync || Date.now() - Date.parse(db.lastSync) > maxAgeMin * 60000) await syncAirbnb();
}


// --- Gestão: estadias, custos e faturamento --------------------------------
// db.stays guarda cada estadia de forma permanente (o feed do Airbnb some com o passado).
// Chaves: "site:<id da reserva>", "airbnb:<uid do iCal>", "manual:<id>".
function recordSiteStay(b) {
  const key = 'site:' + b.id, cur = db.stays[key];
  if (b.status === 'confirmada') {
    db.stays[key] = { revenue: b.total, extraCost: 0, notes: '', ...cur, key, channel: 'site', checkIn: b.checkIn, checkOut: b.checkOut, guest: b.name, cancelled: false };
  } else if (cur) cur.cancelled = true;
}
function recordAirbnbStays(events) {
  const today = toISO(new Date());
  const seen = new Set();
  for (const e of events) {
    if (!/reserved/i.test(e.summary || '') || !e.uid) continue; // só reservas de hóspedes, não bloqueios
    const key = 'airbnb:' + e.uid; seen.add(key);
    const cur = db.stays[key];
    db.stays[key] = { revenue: null, extraCost: 0, notes: '', guest: '', ...cur, key, channel: 'airbnb', checkIn: e.start, checkOut: e.end, cancelled: false };
  }
  // Reserva futura que sumiu do feed = cancelada no Airbnb. As passadas somem naturalmente e ficam guardadas.
  for (const st of Object.values(db.stays)) {
    if (st.channel === 'airbnb' && !seen.has(st.key) && st.checkOut > today) st.cancelled = true;
  }
}
for (const b of db.bookings) recordSiteStay(b); // reservas confirmadas antes desta versão

function financeReport(year) {
  const y = String(year);
  const perStayCost = (db.costs.perStay || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const monthlyCost = (db.costs.monthly || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const nowYM = toISO(new Date()).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => {
    const ym = `${y}-${String(i + 1).padStart(2, '0')}`;
    const days = new Date(Date.UTC(Number(y), i + 1, 0)).getUTCDate();
    return { month: ym, stays: 0, nights: 0, days, revenue: 0, revenueSite: 0, revenueAirbnb: 0, revenueOther: 0, missingRevenue: 0,
      stayCosts: 0, fixedCosts: ym <= nowYM && ym >= (db.costs.since || nowYM) ? monthlyCost : 0, expenses: 0 };
  });
  const stays = Object.values(db.stays).filter(st => !st.cancelled && st.checkIn.slice(0, 4) === y).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  for (const st of stays) {
    const m = months[Number(st.checkIn.slice(5, 7)) - 1]; // estadia conta no mês do check-in
    const n = nightsBetween(st.checkIn, st.checkOut);
    m.stays++; m.nights += n;
    if (st.revenue == null) m.missingRevenue++;
    const r = Number(st.revenue) || 0;
    m.revenue += r;
    m[st.channel === 'site' ? 'revenueSite' : st.channel === 'airbnb' ? 'revenueAirbnb' : 'revenueOther'] += r;
    m.stayCosts += perStayCost + (Number(st.extraCost) || 0);
  }
  for (const e of db.expenses || []) if (e.date.slice(0, 4) === y) months[Number(e.date.slice(5, 7)) - 1].expenses += Number(e.amount) || 0;
  for (const m of months) {
    m.costs = m.stayCosts + m.fixedCosts + m.expenses;
    m.profit = m.revenue - m.costs;
    m.occupancy = m.nights / m.days;
  }
  const sum = k => months.reduce((s, m) => s + m[k], 0);
  const total = Object.fromEntries(['stays', 'nights', 'days', 'revenue', 'revenueSite', 'revenueAirbnb', 'revenueOther', 'missingRevenue', 'stayCosts', 'fixedCosts', 'expenses', 'costs', 'profit'].map(k => [k, sum(k)]));
  total.occupancy = total.nights / total.days;
  return { year: Number(y), months, total, stays: stays.map(st => ({ ...st, nights: nightsBetween(st.checkIn, st.checkOut) })),
    costs: db.costs, perStayCost, monthlyCost, expenses: (db.expenses || []).filter(e => e.date.slice(0, 4) === y).sort((a, b) => a.date.localeCompare(b.date)) };
}

// --- Regras de disponibilidade --------------------------------------------
function expireHolds() {
  const now = Date.now();
  let changed = false;
  for (const b of db.bookings) if (b.status === 'pendente' && Date.parse(b.holdUntil) < now) { b.status = 'expirada'; changed = true; }
  if (changed) save();
}
function activeBookings() { return db.bookings.filter(b => b.status === 'pendente' || b.status === 'confirmada'); }
function busyRanges() {
  expireHolds();
  return [
    ...db.airbnb.map(e => ({ start: e.start, end: e.end, source: 'airbnb' })),
    ...activeBookings().map(b => ({ start: b.checkIn, end: b.checkOut, source: 'direta' })),
    ...db.blocks.map(k => ({ start: k.start, end: k.end, source: 'bloqueio' })),
  ];
}
function isFree(checkIn, checkOut) { return !busyRanges().some(r => overlaps(checkIn, checkOut, r.start, r.end)); }
// Preços editados no painel valem mais que os do config
function pricing() {
  const p = db.pricing || {};
  return {
    nightly: p.nightly ?? CFG.NIGHTLY_RATE, weekend: p.weekend ?? CFG.WEEKEND_RATE, cleaning: p.cleaning ?? CFG.CLEANING_FEE,
    discountPct: p.discountPct ?? CFG.STAY_DISCOUNT_PCT, discountMinNights: p.discountMinNights ?? CFG.STAY_DISCOUNT_MIN_NIGHTS,
  };
}
function nightRate(d, pr) {
  // Feriados/datas especiais: a noite de `start` até a noite de `end`, inclusive
  const special = (db.specialRates || []).find(r => d >= r.start && d <= r.end);
  if (special) return special.rate;
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  return (pr.weekend && (dow === 5 || dow === 6)) ? pr.weekend : pr.nightly;
}
function quote(checkIn, checkOut) {
  const pr = pricing();
  let total = 0;
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) total += nightRate(d, pr);
  const cleaning = pr.cleaning || 0;
  const subtotal = total + cleaning;
  const nights = nightsBetween(checkIn, checkOut);
  const discountPct = pr.discountPct && nights >= pr.discountMinNights ? pr.discountPct : 0;
  const finalTotal = Math.round(subtotal * (100 - discountPct) / 100); // arredonda para reais inteiros
  return { nights, lodging: total, cleaning, subtotal, discountPct, discount: subtotal - finalTotal, total: finalTotal };
}
function validateStay(checkIn, checkOut, guests) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(checkIn) || !re.test(checkOut)) return 'Datas inválidas.';
  if (checkIn < toISO(new Date())) return 'O check-in não pode ser no passado.';
  const n = nightsBetween(checkIn, checkOut);
  if (n < 1) return 'O check-out precisa ser depois do check-in.';
  if (n < CFG.MIN_NIGHTS) return `Mínimo de ${CFG.MIN_NIGHTS} noites.`;
  if (guests && (guests < 1 || guests > CFG.MAX_GUESTS)) return `Máximo de ${CFG.MAX_GUESTS} hóspedes.`;
  return null;
}

function whatsappLink(b) {
  const br = s => s.split('-').reverse().join('/');
  const money = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const text = [
    `Olá! Quero reservar a ${CFG.CABIN_NAME} direto com vocês.`,
    ``,
    `Código: ${b.id}`,
    `Check-in: ${br(b.checkIn)}`,
    `Check-out: ${br(b.checkOut)} (${b.nights} diária${b.nights > 1 ? 's' : ''})`,
    `Hóspedes: ${b.guests}`,
    `Nome: ${b.name}`,
    b.discountPct ? `Valor: ${money(b.total)} (com ${b.discountPct}% de desconto, de ${money(b.subtotal)})` : `Valor: ${money(b.total)}`,
    b.notes ? `Obs.: ${b.notes}` : '',
    ``,
    `Como faço o pagamento?`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return `https://wa.me/${CFG.WHATSAPP}?text=${encodeURIComponent(text)}`;
}

// --- HTTP ------------------------------------------------------------------
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e5) throw new Error('corpo grande demais'); }
  return data ? JSON.parse(data) : {};
}
function isAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(CFG.ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const STATIC = { '/': 'index.html', '/admin': 'admin.html', '/gestao': 'gestao.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Página pública e painel
    if (req.method === 'GET' && STATIC[p]) {
      if ((p === '/admin' || p === '/gestao') && !isAdmin(req)) return send(res, 401, 'Acesso restrito', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="Cabana"' });
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', STATIC[p])), 'text/html; charset=utf-8');
    }

    // Fotos da cabana (public/fotos)
    if (req.method === 'GET' && p.startsWith('/fotos/')) {
      const file = path.join(__dirname, 'public', 'fotos', path.basename(decodeURIComponent(p)));
      const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
      const type = types[path.extname(file).toLowerCase()];
      if (type && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), type, { 'Cache-Control': 'public, max-age=86400' });
      return send(res, 404, { error: 'não encontrado' });
    }

    // Feed iCal para importar no Airbnb (só reservas diretas e bloqueios; nunca reexporta o próprio Airbnb)
    if (req.method === 'GET' && p === `/ical/${CFG.FEED_TOKEN}.ics`) {
      expireHolds();
      const events = [
        ...activeBookings().map(b => ({ uid: `${b.id}@cabana`, start: b.checkIn, end: b.checkOut, summary: 'Reserva direta' })),
        ...db.blocks.map(k => ({ uid: `${k.id}@cabana`, start: k.start, end: k.end, summary: 'Bloqueado' })),
      ];
      return send(res, 200, buildICal(events, `${CFG.CABIN_NAME} - reservas diretas`), 'text/calendar; charset=utf-8');
    }

    // API pública
    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, { name: CFG.CABIN_NAME, minNights: CFG.MIN_NIGHTS, maxGuests: CFG.MAX_GUESTS, holdHours: CFG.HOLD_HOURS, discountPct: pricing().discountPct, discountMinNights: pricing().discountMinNights, airbnbUrl: CFG.AIRBNB_LISTING_URL,
        tagline: CFG.TAGLINE, location: CFG.LOCATION, description: CFG.DESCRIPTION, photos: CFG.PHOTOS, instagram: CFG.INSTAGRAM,
        bedrooms: CFG.BEDROOMS, beds: CFG.BEDS, bathrooms: CFG.BATHROOMS, amenities: CFG.AMENITIES, rules: CFG.RULES,
        checkinTime: CFG.CHECKIN_TIME, checkoutTime: CFG.CHECKOUT_TIME, mapQuery: CFG.MAP_QUERY,
        mapsUrl: CFG.MAPS_URL, reviewsSummary: CFG.REVIEWS_SUMMARY, reviews: CFG.REVIEWS, nearby: CFG.NEARBY, perks: CFG.PERKS, included: CFG.INCLUDED, whatsapp: CFG.WHATSAPP });
    }
    // Diagnóstico da sincronização (sem expor o link do Airbnb)
    if (req.method === 'GET' && p === '/api/status') {
      return send(res, 200, { airbnbConfigured: CFG.AIRBNB_ICAL_URLS.length > 0, lastSync: db.lastSync, lastSyncError: db.lastSyncError, airbnbEvents: db.airbnb.length });
    }
    if (req.method === 'GET' && p === '/api/availability') {
      await syncIfStale(CFG.SYNC_MINUTES);
      return send(res, 200, { busy: busyRanges().map(({ start, end }) => ({ start, end })) });
    }
    if (req.method === 'GET' && p === '/api/quote') {
      const ci = url.searchParams.get('checkIn'), co = url.searchParams.get('checkOut');
      const err = validateStay(ci, co);
      if (err) return send(res, 400, { error: err });
      return send(res, 200, { ...quote(ci, co), available: isFree(ci, co) });
    }
    if (req.method === 'POST' && p === '/api/bookings') {
      const body = await readBody(req);
      const { checkIn, checkOut, name, email, phone } = body;
      const guests = Number(body.guests);
      const err = validateStay(checkIn, checkOut, guests);
      if (err) return send(res, 400, { error: err });
      if (!name || !phone) return send(res, 400, { error: 'Informe nome e telefone.' });
      await syncIfStale(2); // confere o Airbnb de novo logo antes de segurar as datas
      if (!isFree(checkIn, checkOut)) return send(res, 409, { error: 'Essas datas acabaram de ser reservadas. Escolha outras.' });
      const q = quote(checkIn, checkOut);
      const id = 'R' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
      const booking = {
        id, checkIn, checkOut, guests, name: String(name).slice(0, 120), email: String(email || '').slice(0, 120), phone: String(phone).slice(0, 40),
        notes: String(body.notes || '').slice(0, 1000), ...q, status: 'pendente',
        createdAt: new Date().toISOString(), holdUntil: new Date(Date.now() + CFG.HOLD_HOURS * 3600000).toISOString(),
      };
      db.bookings.push(booking);
      save();
      return send(res, 201, { booking, whatsappUrl: whatsappLink(booking) });
    }

    // API do painel
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'não autorizado' }, undefined, { 'WWW-Authenticate': 'Basic realm="Cabana"' });
      if (req.method === 'GET' && p === '/api/admin/state') {
        expireHolds();
        const feedUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/ical/${CFG.FEED_TOKEN}.ics`;
        return send(res, 200, { bookings: db.bookings, blocks: db.blocks, airbnb: db.airbnb, lastSync: db.lastSync, lastSyncError: db.lastSyncError, feedUrl, airbnbConfigured: CFG.AIRBNB_ICAL_URLS.length > 0,
          pricing: pricing(), specialRates: db.specialRates || [] });
      }
      if (req.method === 'POST' && p === '/api/admin/sync') { await syncAirbnb(); return send(res, 200, { ok: true, lastSync: db.lastSync, error: db.lastSyncError }); }
      const m = p.match(/^\/api\/admin\/bookings\/([\w]+)\/(confirmar|cancelar)$/);
      if (req.method === 'POST' && m) {
        const b = db.bookings.find(x => x.id === m[1]);
        if (!b) return send(res, 404, { error: 'reserva não encontrada' });
        if (m[2] === 'confirmar') {
          if (b.status === 'expirada' && !isFree(b.checkIn, b.checkOut)) return send(res, 409, { error: 'As datas já foram ocupadas.' });
          b.status = 'confirmada'; b.confirmedAt = new Date().toISOString();
        } else b.status = 'cancelada';
        recordSiteStay(b);
        save();
        return send(res, 200, b);
      }
      if (req.method === 'PUT' && p === '/api/admin/pricing') {
        const body = await readBody(req);
        const num = v => (v === '' || v == null) ? null : Number(v);
        const next = { nightly: num(body.nightly), weekend: num(body.weekend), cleaning: num(body.cleaning),
          discountPct: num(body.discountPct), discountMinNights: num(body.discountMinNights) };
        if (!(next.nightly > 0) || [next.weekend, next.cleaning, next.discountMinNights].some(v => v != null && !(v >= 0))
          || (next.discountPct != null && !(next.discountPct >= 0 && next.discountPct < 100))) return send(res, 400, { error: 'valores inválidos' });
        db.pricing = next; save();
        return send(res, 200, pricing());
      }
      if (req.method === 'POST' && p === '/api/admin/special') {
        const { start, end, rate, label } = await readBody(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start || !(Number(rate) > 0)) return send(res, 400, { error: 'dados inválidos' });
        const item = { id: 'P' + Date.now().toString(36), start, end, rate: Number(rate), label: String(label || '').slice(0, 100) };
        (db.specialRates ||= []).push(item); save();
        return send(res, 201, item);
      }
      const sp = p.match(/^\/api\/admin\/special\/(\w+)$/);
      if (req.method === 'DELETE' && sp) { db.specialRates = (db.specialRates || []).filter(r => r.id !== sp[1]); save(); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p === '/api/admin/blocks') {
        const { start, end, reason } = await readBody(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) return send(res, 400, { error: 'datas inválidas' });
        const block = { id: 'B' + Date.now().toString(36), start, end, reason: String(reason || '').slice(0, 200) };
        db.blocks.push(block); save();
        return send(res, 201, block);
      }
      // Gestão
      if (req.method === 'GET' && p === '/api/admin/finance') {
        const year = /^\d{4}$/.test(url.searchParams.get('year') || '') ? url.searchParams.get('year') : toISO(new Date()).slice(0, 4);
        return send(res, 200, financeReport(year));
      }
      const money = v => (v === '' || v == null) ? null : Math.round(Number(v) * 100) / 100;
      if (req.method === 'PUT' && p === '/api/admin/costs') {
        const body = await readBody(req);
        const list = a => (Array.isArray(a) ? a : []).map(c => ({ name: String(c.name || '').slice(0, 80), amount: money(c.amount) }))
          .filter(c => c.name && c.amount != null && c.amount >= 0);
        const since = /^\d{4}-\d{2}$/.test(body.since || '') ? body.since : (db.costs.since || toISO(new Date()).slice(0, 7));
        db.costs = { perStay: list(body.perStay), monthly: list(body.monthly), since }; save();
        return send(res, 200, db.costs);
      }
      if (req.method === 'POST' && p === '/api/admin/stays') {
        const { checkIn, checkOut, guest, revenue, channel, notes } = await readBody(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) return send(res, 400, { error: 'datas inválidas' });
        const key = 'manual:' + Date.now().toString(36);
        db.stays[key] = { key, channel: ['airbnb', 'site'].includes(channel) ? channel : 'outro', checkIn, checkOut, guest: String(guest || '').slice(0, 120),
          revenue: money(revenue), extraCost: 0, notes: String(notes || '').slice(0, 300), cancelled: false };
        save(); return send(res, 201, db.stays[key]);
      }
      const st = p.match(/^\/api\/admin\/stays\/(.+)$/);
      if (st && (req.method === 'PUT' || req.method === 'DELETE')) {
        const key = decodeURIComponent(st[1]), item = db.stays[key];
        if (!item) return send(res, 404, { error: 'estadia não encontrada' });
        if (req.method === 'DELETE') {
          if (item.channel === 'site' || key.startsWith('airbnb:')) item.cancelled = true; else delete db.stays[key];
        } else {
          const body = await readBody(req);
          if ('revenue' in body) item.revenue = money(body.revenue);
          if ('extraCost' in body) item.extraCost = money(body.extraCost) || 0;
          if ('guest' in body) item.guest = String(body.guest || '').slice(0, 120);
          if ('notes' in body) item.notes = String(body.notes || '').slice(0, 300);
        }
        save(); return send(res, 200, item || { ok: true });
      }
      if (req.method === 'POST' && p === '/api/admin/expenses') {
        const { date, desc, amount } = await readBody(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(money(amount) > 0)) return send(res, 400, { error: 'dados inválidos' });
        const item = { id: 'E' + Date.now().toString(36), date, desc: String(desc || '').slice(0, 120), amount: money(amount) };
        (db.expenses ||= []).push(item); save();
        return send(res, 201, item);
      }
      const ex = p.match(/^\/api\/admin\/expenses\/(\w+)$/);
      if (req.method === 'DELETE' && ex) { db.expenses = (db.expenses || []).filter(e => e.id !== ex[1]); save(); return send(res, 200, { ok: true }); }
      const d = p.match(/^\/api\/admin\/blocks\/(\w+)$/);
      if (req.method === 'DELETE' && d) { db.blocks = db.blocks.filter(k => k.id !== d[1]); save(); return send(res, 200, { ok: true }); }
    }

    send(res, 404, { error: 'não encontrado' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'erro interno' });
  }
});

if (require.main === module) {
  server.listen(CFG.PORT, () => {
    console.log(`Cabana rodando em http://localhost:${CFG.PORT}`);
    console.log(`Feed iCal para o Airbnb: http://localhost:${CFG.PORT}/ical/${CFG.FEED_TOKEN}.ics`);
    if (!CFG.AIRBNB_ICAL_URLS.length) console.log('Aviso: AIRBNB_ICAL_URLS não configurado; o calendário do Airbnb não será importado.');
  });
  syncAirbnb();
  setInterval(syncAirbnb, CFG.SYNC_MINUTES * 60000);
}
module.exports = { server, CFG };
