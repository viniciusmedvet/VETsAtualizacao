require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAX_TABLES = 50;

// ─── Diretórios ────────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const EST_DIR       = path.join(DATA_DIR, 'establishments');
const UPLOADS_BASE  = path.join(__dirname, 'uploads');
const QRCODES_BASE  = path.join(__dirname, 'public', 'qrcodes');

[DATA_DIR, EST_DIR, UPLOADS_BASE, QRCODES_BASE].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Dados: contas e estabelecimentos ─────────────────────────────────────────

function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return {}; }
}

function writeAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

function defaultDB() {
  return {
    tables: [], menu: null, activeCalls: [], callHistory: [], orders: [],
    menuCategories: [], menuItems: [],
    settings: {
      barName: 'Meu Bar',
      tagline: 'Bem-vindo! Estamos felizes em atendê-lo.',
      welcomeMessage: 'Escaneie o QR code da sua mesa para chamar o garçom.',
      accentColor: '#f5a623',
      logo: null
    }
  };
}

function readDB(estId) {
  const p = path.join(EST_DIR, estId, 'db.json');
  if (!fs.existsSync(p)) return defaultDB();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return defaultDB(); }
}

function writeDB(estId, data) {
  const dir = path.join(EST_DIR, estId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(data, null, 2));
}

// ─── Uploads por estabelecimento ──────────────────────────────────────────────

function uploadsDir(estId) {
  const d = path.join(UPLOADS_BASE, estId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function qrDir(estId) {
  const d = path.join(QRCODES_BASE, estId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function buildMulter(fieldPrefix, mimetypes, maxBytes) {
  const storage = multer.diskStorage({
    destination(req, file, cb) { cb(null, uploadsDir(req.estId)); },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, `${fieldPrefix}_${Date.now()}${ext}`);
    }
  });
  return multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter(req, file, cb) {
      cb(mimetypes.includes(file.mimetype) ? null : new Error('Tipo de arquivo não suportado.'), mimetypes.includes(file.mimetype));
    }
  });
}

// ─── Middleware base ──────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_BASE));

app.use(session({
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
  store: new MemoryStore({ checkPeriod: 86400000 }),
  resave: false,
  saveUninitialized: false,
  secret: process.env.SESSION_SECRET || 'chamaogarcom-secret-mude-no-env'
}));
app.use(passport.initialize());
app.use(passport.session());

// ─── Google OAuth ─────────────────────────────────────────────────────────────

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID     || 'CONFIGURE_GOOGLE_CLIENT_ID',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'CONFIGURE_GOOGLE_CLIENT_SECRET',
  callbackURL:  BASE_URL + '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  try {
    const accounts = readAccounts();
    if (!accounts[profile.id]) {
      const estId = uuidv4();
      accounts[profile.id] = {
        estId,
        googleId: profile.id,
        email:   profile.emails?.[0]?.value || '',
        name:    profile.displayName || '',
        picture: profile.photos?.[0]?.value || null,
        createdAt: new Date().toISOString()
      };
      writeAccounts(accounts);
      writeDB(estId, defaultDB());
      console.log(`[Auth] Novo estabelecimento: ${accounts[profile.id].email} → ${estId}`);
    }
    return done(null, accounts[profile.id]);
  } catch (e) { return done(e); }
}));

passport.serializeUser((user, done) => done(null, user.googleId));
passport.deserializeUser((googleId, done) => {
  const accounts = readAccounts();
  done(null, accounts[googleId] || null);
});

// ─── Middlewares de auth ──────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/');
  req.estId = req.user.estId;
  next();
}

function requireAuthAPI(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  req.estId = req.user.estId;
  next();
}

function loadEstId(req, res, next) {
  req.estId = req.params.estId;
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?erro=auth' }),
  (req, res) => res.redirect('/admin')
);

app.post('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.json({ ok: true });
  });
});

// ─── Páginas ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/b/:estId/balcao', loadEstId, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'balcao', 'index.html'));
});

app.get('/b/:estId/mesa/:tableId', loadEstId, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mesa', 'index.html'));
});

// ─── API: Usuário atual ───────────────────────────────────────────────────────

app.get('/api/me', requireAuthAPI, (req, res) => {
  const { estId, email, name, picture } = req.user;
  res.json({
    estId, email, name, picture,
    balcaoUrl: `${BASE_URL}/b/${estId}/balcao`
  });
});

// ─── API Pública (usa estId da URL) ──────────────────────────────────────────

app.get('/api/pub/:estId/settings', loadEstId, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.settings || {});
});

app.get('/api/pub/:estId/menu', loadEstId, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.menu);
});

app.get('/api/pub/:estId/cardapio', loadEstId, (req, res) => {
  const db = readDB(req.estId);
  const cats = (db.menuCategories || []).slice().sort((a, b) => a.order - b.order);
  const items = (db.menuItems || []).filter(i => i.available);
  res.json({ categories: cats, items });
});

app.get('/api/pub/:estId/mesas/:tableId', loadEstId, (req, res) => {
  const db = readDB(req.estId);
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });
  res.json(table);
});

app.post('/api/pub/:estId/pedidos', loadEstId, (req, res) => {
  const { tableId, items, note } = req.body;
  if (!tableId || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'tableId e items são obrigatórios' });

  const db = readDB(req.estId);
  const table = db.tables.find(t => t.id === tableId);
  if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });

  const dbItems = db.menuItems || [];
  const orderItems = [];
  for (const { itemId, qty } of items) {
    const dbItem = dbItems.find(i => i.id === itemId && i.available);
    if (!dbItem) return res.status(400).json({ error: `Item não encontrado: ${itemId}` });
    orderItems.push({ itemId: dbItem.id, name: dbItem.name, qty: Math.max(1, parseInt(qty) || 1), price: dbItem.price });
  }

  const total = orderItems.reduce((s, i) => s + i.price * i.qty, 0);
  const order = {
    orderId: uuidv4(), tableId: table.id, tableName: table.name,
    items: orderItems, note: note?.trim().slice(0, 200) || '',
    total, status: 'novo', createdAt: new Date().toISOString()
  };

  if (!db.orders) db.orders = [];
  db.orders.push(order);
  if (db.orders.length > 1000) db.orders = db.orders.slice(-1000);
  writeDB(req.estId, db);

  io.to(`balcao-${req.estId}`).emit('new:order', order);
  res.status(201).json({ ok: true, orderId: order.orderId });
});

app.patch('/api/pub/:estId/pedidos/:orderId/status', loadEstId, (req, res) => {
  const { status } = req.body;
  const allowed = ['novo', 'preparando', 'entregue', 'cancelado'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido' });

  const db = readDB(req.estId);
  const order = (db.orders || []).find(o => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

  order.status = status;
  order.updatedAt = new Date().toISOString();
  writeDB(req.estId, db);

  io.to(`est-${req.estId}`).emit('order:status-changed', order);
  res.json(order);
});

// ─── API Admin: Mesas ─────────────────────────────────────────────────────────

app.get('/api/mesas', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.tables);
});

app.post('/api/mesas', requireAuthAPI, async (req, res) => {
  try {
    const db = readDB(req.estId);
    if (db.tables.length >= MAX_TABLES)
      return res.status(400).json({ error: `Limite de ${MAX_TABLES} mesas atingido` });
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ error: 'Nome da mesa é obrigatório' });
    if (db.tables.find(t => t.name.toLowerCase() === name.toLowerCase()))
      return res.status(400).json({ error: 'Já existe uma mesa com esse nome' });

    const id = uuidv4();
    const mesaUrl = `${BASE_URL}/b/${req.estId}/mesa/${id}`;
    const qrPath  = path.join(qrDir(req.estId), `${id}.png`);

    await QRCode.toFile(qrPath, mesaUrl, { width: 400, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });

    const table = {
      id, name, mesaUrl,
      qrFile: `/qrcodes/${req.estId}/${id}.png`,
      createdAt: new Date().toISOString(),
      status: 'livre', occupiedAt: null
    };
    db.tables.push(table);
    writeDB(req.estId, db);
    res.status(201).json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar mesa' });
  }
});

app.delete('/api/mesas/:tableId', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const idx = db.tables.findIndex(t => t.id === req.params.tableId);
  if (idx === -1) return res.status(404).json({ error: 'Mesa não encontrada' });

  const [table] = db.tables.splice(idx, 1);
  db.activeCalls = db.activeCalls.filter(c => c.tableId !== table.id);

  const qrPath = path.join(QRCODES_BASE, req.estId, `${table.id}.png`);
  if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

  writeDB(req.estId, db);
  res.json({ ok: true });
});

// ─── API Admin: QR Codes ──────────────────────────────────────────────────────

app.get('/api/qrcode/:tableId/print', requireAuthAPI, (req, res) => {
  const db  = readDB(req.estId);
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).send('Mesa não encontrada');
  const s = db.settings || {};
  const logoHtml = s.logo?.url
    ? `<img src="${s.logo.url}" alt="Logo" style="max-height:80px;max-width:200px;object-fit:contain;margin-bottom:0.5rem;">`
    : `<div style="font-size:2rem;">🍺</div>`;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>QR Code - ${table.name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;}
.card{border:2px solid #1a1a2e;border-radius:16px;padding:2rem 2.5rem;text-align:center;width:320px;display:flex;flex-direction:column;align-items:center;gap:0.5rem;}
.bar-name{font-size:1.3rem;font-weight:800;color:#1a1a2e;}.table-name{font-size:2rem;font-weight:800;color:#f5a623;margin:0.4rem 0;}
.qr{width:240px;height:240px;margin:0.5rem 0;}.tagline{font-size:0.85rem;color:#555;max-width:240px;line-height:1.4;}
.print-btn{margin-top:1.5rem;padding:0.6rem 2rem;cursor:pointer;font-size:1rem;}
@media print{.print-btn{display:none;}body{min-height:unset;}}</style></head>
<body><div class="card">${logoHtml}<div class="bar-name">${s.barName||'Meu Bar'}</div>
<div class="table-name">${table.name}</div>
<img class="qr" src="/qrcodes/${req.estId}/${table.id}.png" alt="QR Code">
<div class="tagline">${s.tagline||'Escaneie para chamar o garçom'}</div></div>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir</button>
<script>window.onload=()=>window.print();</script></body></html>`);
});

app.get('/api/qrcode/all/print', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  if (db.tables.length === 0) return res.status(404).send('Nenhuma mesa cadastrada.');
  const s = db.settings || {};
  const accent = s.accentColor || '#f5a623';
  const logoHtml = s.logo?.url
    ? `<img src="${s.logo.url}" alt="Logo" style="max-height:60px;max-width:160px;object-fit:contain;">`
    : `<span style="font-size:2rem">🍺</span>`;
  const cards = db.tables.map(t => `<div class="qr-card">${logoHtml}
    <div class="bar-name">${s.barName||'Meu Bar'}</div><div class="table-name" style="color:${accent}">${t.name}</div>
    <img src="/qrcodes/${req.estId}/${t.id}.png" alt="QR ${t.name}">
    <div class="caption">${s.tagline||'Escaneie para chamar o garçom'}</div></div>`).join('');
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>QR Codes</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f0f0f0;padding:1rem;}
h2{text-align:center;margin-bottom:1rem;color:#1a1a2e;font-size:1.2rem;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,220px);gap:1rem;justify-content:center;}
.qr-card{background:#fff;border:2px solid #1a1a2e;border-radius:12px;padding:1rem 0.75rem;text-align:center;display:flex;flex-direction:column;align-items:center;gap:0.35rem;break-inside:avoid;}
.bar-name{font-size:0.9rem;font-weight:700;color:#1a1a2e;}.table-name{font-size:1.5rem;font-weight:800;}
.qr-card img{width:170px;height:170px;margin:0.25rem 0;}.caption{font-size:0.72rem;color:#666;}
.print-btn{display:block;margin:1rem auto;padding:0.6rem 2rem;font-size:1rem;cursor:pointer;background:${accent};color:#fff;border:none;border-radius:8px;}
@media print{body{background:#fff;padding:0;}h2,.print-btn{display:none;}</style></head>
<body><h2>QR Codes — ${s.barName||'Meu Bar'} (${db.tables.length} mesa${db.tables.length>1?'s':''})</h2>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir Todos</button>
<div class="grid">${cards}</div><script>window.onload=()=>window.print();</script></body></html>`);
});

// ─── API Admin: Histórico ─────────────────────────────────────────────────────

app.get('/api/historico', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const history = db.callHistory || [];
  const { date, table: tableFilter, limit: limitParam } = req.query;
  const limit = Math.min(parseInt(limitParam) || 200, 500);
  let filtered = history;
  if (date) filtered = filtered.filter(h => h.date === date);
  if (tableFilter) filtered = filtered.filter(h =>
    h.tableId === tableFilter || h.tableName?.toLowerCase().includes(tableFilter.toLowerCase()));

  const withDuration = filtered.filter(h => h.attendedAt && h.calledAt);
  const durations = withDuration.map(h => (new Date(h.attendedAt) - new Date(h.calledAt)) / 1000);
  const avgSeconds = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const maxSeconds = durations.length ? Math.round(Math.max(...durations)) : null;
  const countByTable = {};
  filtered.forEach(h => { countByTable[h.tableName] = (countByTable[h.tableName] || 0) + 1; });
  const busiestTable = Object.entries(countByTable).sort((a, b) => b[1] - a[1])[0] || null;
  const byHour = Array(24).fill(0);
  filtered.forEach(h => { byHour[new Date(h.calledAt).getHours()]++; });
  const dates = [...new Set(history.map(h => h.date))].sort().reverse();
  const records = filtered.slice().reverse().slice(0, limit).map(h => ({
    ...h, durationSeconds: h.attendedAt && h.calledAt
      ? Math.round((new Date(h.attendedAt) - new Date(h.calledAt)) / 1000) : null
  }));

  res.json({
    total: filtered.length, totalAllTime: history.length, avgSeconds, maxSeconds,
    busiestTable: busiestTable ? { name: busiestTable[0], count: busiestTable[1] } : null,
    byHour, dates, records
  });
});

app.delete('/api/historico', requireAuthAPI, (req, res) => {
  const { date } = req.query;
  const db = readDB(req.estId);
  if (!db.callHistory) db.callHistory = [];
  db.callHistory = date ? db.callHistory.filter(h => h.date !== date) : [];
  writeDB(req.estId, db);
  res.json({ ok: true });
});

// ─── API Admin: Cardápio PDF ──────────────────────────────────────────────────

app.get('/api/menu', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.menu);
});

app.post('/api/menu', requireAuthAPI, (req, res) => {
  buildMulter('cardapio', ['application/pdf','image/jpeg','image/png','image/webp'], 20*1024*1024)
    .single('cardapio')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
      const db = readDB(req.estId);
      if (db.menu?.storedPath && fs.existsSync(db.menu.storedPath)) fs.unlinkSync(db.menu.storedPath);
      db.menu = {
        originalName: req.file.originalname, storedName: req.file.filename,
        storedPath: req.file.path, mimetype: req.file.mimetype,
        url: `/uploads/${req.estId}/${req.file.filename}`,
        uploadedAt: new Date().toISOString()
      };
      writeDB(req.estId, db);
      res.json(db.menu);
    });
});

app.delete('/api/menu', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  if (!db.menu) return res.status(404).json({ error: 'Nenhum cardápio cadastrado' });
  if (db.menu.storedPath && fs.existsSync(db.menu.storedPath)) fs.unlinkSync(db.menu.storedPath);
  db.menu = null;
  writeDB(req.estId, db);
  res.json({ ok: true });
});

// ─── API Admin: Configurações ─────────────────────────────────────────────────

app.get('/api/settings', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.settings || {});
});

app.post('/api/settings', requireAuthAPI, (req, res) => {
  const { barName, tagline, welcomeMessage, accentColor } = req.body;
  const db = readDB(req.estId);
  if (!db.settings) db.settings = {};
  if (barName !== undefined) db.settings.barName = barName.trim().slice(0, 80);
  if (tagline !== undefined) db.settings.tagline = tagline.trim().slice(0, 120);
  if (welcomeMessage !== undefined) db.settings.welcomeMessage = welcomeMessage.trim().slice(0, 240);
  if (accentColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(accentColor)) db.settings.accentColor = accentColor;
  writeDB(req.estId, db);
  res.json(db.settings);
});

app.post('/api/settings/logo', requireAuthAPI, (req, res) => {
  buildMulter('logo', ['image/jpeg','image/png','image/webp','image/gif','image/svg+xml'], 5*1024*1024)
    .single('logo')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
      const db = readDB(req.estId);
      if (!db.settings) db.settings = {};
      if (db.settings.logo?.storedPath && fs.existsSync(db.settings.logo.storedPath))
        fs.unlinkSync(db.settings.logo.storedPath);
      db.settings.logo = {
        originalName: req.file.originalname, storedName: req.file.filename,
        storedPath: req.file.path,
        url: `/uploads/${req.estId}/${req.file.filename}`,
        uploadedAt: new Date().toISOString()
      };
      writeDB(req.estId, db);
      res.json(db.settings.logo);
    });
});

app.delete('/api/settings/logo', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  if (!db.settings?.logo) return res.status(404).json({ error: 'Nenhum logotipo cadastrado' });
  if (db.settings.logo.storedPath && fs.existsSync(db.settings.logo.storedPath))
    fs.unlinkSync(db.settings.logo.storedPath);
  db.settings.logo = null;
  writeDB(req.estId, db);
  res.json({ ok: true });
});

// ─── API Admin: Ocupação ──────────────────────────────────────────────────────

app.post('/api/mesas/:tableId/status', requireAuthAPI, (req, res) => {
  const { status } = req.body;
  if (!['livre', 'ocupada'].includes(status)) return res.status(400).json({ error: 'Status inválido' });
  const db = readDB(req.estId);
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });
  if (status === 'livre') {
    table.status = 'livre'; table.occupiedAt = null;
    db.activeCalls = db.activeCalls.filter(c => c.tableId !== table.id);
  } else {
    table.status = 'ocupada'; table.occupiedAt = new Date().toISOString();
  }
  writeDB(req.estId, db);
  io.to(`est-${req.estId}`).emit('table:status-changed', { tableId: table.id, status: table.status, occupiedAt: table.occupiedAt });
  res.json({ tableId: table.id, status: table.status });
});

// ─── API Admin: Cardápio Digital ─────────────────────────────────────────────

app.get('/api/cardapio/categorias', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.menuCategories || []);
});

app.post('/api/cardapio/categorias', requireAuthAPI, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const db = readDB(req.estId);
  if (!db.menuCategories) db.menuCategories = [];
  const cat = { id: uuidv4(), name: name.trim(), order: db.menuCategories.length, createdAt: new Date().toISOString() };
  db.menuCategories.push(cat);
  writeDB(req.estId, db);
  res.status(201).json(cat);
});

app.delete('/api/cardapio/categorias/:catId', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const idx = (db.menuCategories || []).findIndex(c => c.id === req.params.catId);
  if (idx === -1) return res.status(404).json({ error: 'Categoria não encontrada' });
  db.menuCategories.splice(idx, 1);
  db.menuItems = (db.menuItems || []).filter(i => i.categoryId !== req.params.catId);
  writeDB(req.estId, db);
  res.json({ ok: true });
});

app.get('/api/cardapio/itens', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  res.json(db.menuItems || []);
});

app.post('/api/cardapio/itens', requireAuthAPI, (req, res) => {
  const { categoryId, name, description, price } = req.body;
  if (!categoryId || !name?.trim()) return res.status(400).json({ error: 'categoryId e name são obrigatórios' });
  const db = readDB(req.estId);
  if (!(db.menuCategories || []).find(c => c.id === categoryId))
    return res.status(400).json({ error: 'Categoria não encontrada' });
  if (!db.menuItems) db.menuItems = [];
  const available = req.body.available !== false;
  const item = {
    id: uuidv4(), categoryId, name: name.trim(),
    description: description?.trim() || '',
    price: parseFloat(price) || 0,
    available, createdAt: new Date().toISOString()
  };
  db.menuItems.push(item);
  writeDB(req.estId, db);
  res.status(201).json(item);
});

app.put('/api/cardapio/itens/:itemId', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const item = (db.menuItems || []).find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  const { name, description, price, available } = req.body;
  if (name !== undefined) item.name = name.trim();
  if (description !== undefined) item.description = description.trim();
  if (price !== undefined) item.price = parseFloat(price) || 0;
  if (available !== undefined) item.available = Boolean(available);
  writeDB(req.estId, db);
  res.json(item);
});

app.delete('/api/cardapio/itens/:itemId', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const idx = (db.menuItems || []).findIndex(i => i.id === req.params.itemId);
  if (idx === -1) return res.status(404).json({ error: 'Item não encontrado' });
  db.menuItems.splice(idx, 1);
  writeDB(req.estId, db);
  res.json({ ok: true });
});

// ─── API Admin: Pedidos ───────────────────────────────────────────────────────

app.get('/api/pedidos', requireAuthAPI, (req, res) => {
  const db = readDB(req.estId);
  const { status, tableId } = req.query;
  let orders = (db.orders || []).slice().reverse();
  if (status) orders = orders.filter(o => o.status === status);
  if (tableId) orders = orders.filter(o => o.tableId === tableId);
  res.json(orders.slice(0, 100));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join:balcao', ({ estId }) => {
    if (!estId) return;
    socket.join(`balcao-${estId}`);
    socket.join(`est-${estId}`);
    const db = readDB(estId);
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = (db.callHistory || []).filter(h => h.date === today).length;
    const tableStatuses = db.tables.map(t => ({
      tableId: t.id, name: t.name, status: t.status || 'livre', occupiedAt: t.occupiedAt || null
    }));
    const pendingOrders = (db.orders || []).filter(o => o.status === 'novo' || o.status === 'preparando').slice(-50).reverse();
    socket.emit('init:balcao', { pendingCalls: db.activeCalls, todayCount, tableStatuses, pendingOrders });
  });

  socket.on('join:mesa', ({ tableId, estId }) => {
    if (!estId) return;
    socket.join(`est-${estId}`);
  });

  socket.on('table:call', ({ tableId, estId }) => {
    if (!estId) return;
    const db = readDB(estId);
    const table = db.tables.find(t => t.id === tableId);
    if (!table) { socket.emit('erro', { message: 'Mesa não encontrada' }); return; }

    const existing = db.activeCalls.find(c => c.tableId === tableId);
    if (existing) { socket.emit('call:confirmed', { tableId, tableName: table.name, repeated: true }); return; }

    const call = {
      callId: uuidv4(), tableId: table.id, tableName: table.name,
      calledAt: new Date().toISOString(), timestamp: Date.now()
    };
    db.activeCalls.push(call);
    table.status = 'chamando';
    if (!table.occupiedAt) table.occupiedAt = call.calledAt;
    writeDB(estId, db);

    io.to(`balcao-${estId}`).emit('table:calling', call);
    io.to(`est-${estId}`).emit('table:status-changed', { tableId: table.id, status: 'chamando', occupiedAt: table.occupiedAt });
    socket.emit('call:confirmed', { tableId, tableName: table.name });
  });

  socket.on('call:attend', ({ tableId, estId }) => {
    if (!estId) return;
    const db = readDB(estId);
    const callIdx = db.activeCalls.findIndex(c => c.tableId === tableId);
    if (callIdx === -1) return;

    const [call] = db.activeCalls.splice(callIdx, 1);
    if (!db.callHistory) db.callHistory = [];
    db.callHistory.push({
      tableId: call.tableId, tableName: call.tableName,
      calledAt: call.calledAt, attendedAt: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10)
    });
    if (db.callHistory.length > 500) db.callHistory = db.callHistory.slice(-500);
    const table = db.tables.find(t => t.id === tableId);
    if (table) table.status = 'ocupada';
    writeDB(estId, db);

    const today = new Date().toISOString().slice(0, 10);
    io.to(`est-${estId}`).emit('call:attended', { tableId, callId: call.callId });
    io.to(`est-${estId}`).emit('table:status-changed', { tableId, status: 'ocupada', occupiedAt: table?.occupiedAt });
    io.to(`balcao-${estId}`).emit('stats:update', { todayCount: db.callHistory.filter(h => h.date === today).length });
  });

  socket.on('table:open', ({ tableId, estId }) => {
    if (!estId) return;
    const db = readDB(estId);
    const table = db.tables.find(t => t.id === tableId);
    if (!table || table.status === 'chamando') return;
    table.status = 'ocupada'; table.occupiedAt = new Date().toISOString();
    writeDB(estId, db);
    io.to(`est-${estId}`).emit('table:status-changed', { tableId, status: 'ocupada', occupiedAt: table.occupiedAt });
  });

  socket.on('table:close', ({ tableId, estId }) => {
    if (!estId) return;
    const db = readDB(estId);
    const table = db.tables.find(t => t.id === tableId);
    if (!table) return;
    table.status = 'livre'; table.occupiedAt = null;
    db.activeCalls = db.activeCalls.filter(c => c.tableId !== tableId);
    writeDB(estId, db);
    io.to(`est-${estId}`).emit('table:status-changed', { tableId, status: 'livre', occupiedAt: null });
    io.to(`est-${estId}`).emit('call:attended', { tableId, callId: null });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🍺 Chama o Garçom — ${BASE_URL}`);
  console.log(`   Admin:  ${BASE_URL}/admin  (login com Google)\n`);
});
