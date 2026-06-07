require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const QRCODES_DIR = path.join(__dirname, 'public', 'qrcodes');
const MAX_TABLES = 50;

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não suportado. Use PDF ou imagem.'));
  }
});

const uploadImage = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Use uma imagem (JPG, PNG, WEBP, GIF ou SVG).'));
  }
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

// ─── Páginas ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/balcao'));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/balcao', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'balcao', 'index.html'));
});

app.get('/mesa/:tableId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mesa', 'index.html'));
});

// ─── API: Admin Auth ──────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ─── API: Mesas ───────────────────────────────────────────────────────────────

app.get('/api/mesas', (req, res) => {
  const db = readDB();
  res.json(db.tables);
});

app.get('/api/mesas/:tableId', (req, res) => {
  const db = readDB();
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });
  res.json(table);
});

app.post('/api/mesas', adminAuth, async (req, res) => {
  try {
    const db = readDB();
    if (db.tables.length >= MAX_TABLES) {
      return res.status(400).json({ error: `Limite de ${MAX_TABLES} mesas atingido` });
    }
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ error: 'Nome da mesa é obrigatório' });
    if (db.tables.find(t => t.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: 'Já existe uma mesa com esse nome' });
    }

    const id = uuidv4();
    const mesaUrl = `${BASE_URL}/mesa/${id}`;
    const qrFile = path.join(QRCODES_DIR, `${id}.png`);

    await QRCode.toFile(qrFile, mesaUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });

    const table = { id, name, mesaUrl, qrFile: `/qrcodes/${id}.png`, createdAt: new Date().toISOString() };
    db.tables.push(table);
    writeDB(db);

    res.status(201).json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar mesa' });
  }
});

app.delete('/api/mesas/:tableId', adminAuth, (req, res) => {
  const db = readDB();
  const idx = db.tables.findIndex(t => t.id === req.params.tableId);
  if (idx === -1) return res.status(404).json({ error: 'Mesa não encontrada' });

  const [table] = db.tables.splice(idx, 1);
  db.activeCalls = db.activeCalls.filter(c => c.tableId !== table.id);

  const qrPath = path.join(__dirname, 'public', 'qrcodes', `${table.id}.png`);
  if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

  writeDB(db);
  res.json({ ok: true });
});

// ─── API: QR Code ─────────────────────────────────────────────────────────────

app.get('/api/qrcode/:tableId/print', (req, res) => {
  const db = readDB();
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).send('Mesa não encontrada');

  const s = db.settings || {};
  const barName = s.barName || 'Meu Bar';
  const tagline = s.tagline || 'Escaneie para chamar o garçom';
  const logoHtml = s.logo?.url
    ? `<img src="${s.logo.url}" alt="Logo" style="max-height:80px;max-width:200px;object-fit:contain;margin-bottom:0.5rem;">`
    : `<div style="font-size:2rem;">🍺</div>`;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>QR Code - ${table.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
  .card {
    border: 2px solid #1a1a2e; border-radius: 16px;
    padding: 2rem 2.5rem; text-align: center;
    width: 320px; display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
  }
  .bar-name { font-size: 1.3rem; font-weight: 800; color: #1a1a2e; }
  .table-name { font-size: 2rem; font-weight: 800; color: #f5a623; margin: 0.4rem 0; }
  .qr { width: 240px; height: 240px; margin: 0.5rem 0; }
  .tagline { font-size: 0.85rem; color: #555; max-width: 240px; line-height: 1.4; }
  .print-btn { margin-top: 1.5rem; padding: 0.6rem 2rem; cursor: pointer; font-size: 1rem; }
  @media print { .print-btn { display: none; } body { min-height: unset; } }
</style>
</head>
<body>
<div class="card">
  ${logoHtml}
  <div class="bar-name">${barName}</div>
  <div class="table-name">${table.name}</div>
  <img class="qr" src="/qrcodes/${table.id}.png" alt="QR Code ${table.name}">
  <div class="tagline">${tagline}</div>
</div>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir</button>
<script>window.onload = () => window.print();</script>
</body>
</html>`);
});

app.get('/api/qrcode/all/print', (req, res) => {
  const db = readDB();
  if (db.tables.length === 0) return res.status(404).send('Nenhuma mesa cadastrada.');

  const s = db.settings || {};
  const barName = s.barName || 'Meu Bar';
  const tagline = s.tagline || 'Escaneie para chamar o garçom';
  const accent = s.accentColor || '#f5a623';
  const logoHtml = s.logo?.url
    ? `<img src="${s.logo.url}" alt="Logo" style="max-height:60px;max-width:160px;object-fit:contain;">`
    : `<span style="font-size:2rem">🍺</span>`;

  const cards = db.tables.map(t => `
    <div class="qr-card">
      ${logoHtml}
      <div class="bar-name">${barName}</div>
      <div class="table-name" style="color:${accent}">${t.name}</div>
      <img src="/qrcodes/${t.id}.png" alt="QR ${t.name}">
      <div class="caption">${tagline}</div>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>QR Codes — ${barName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #f0f0f0; padding: 1rem; }
  h2 { text-align: center; margin-bottom: 1rem; color: #1a1a2e; font-size: 1.2rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, 220px); gap: 1rem; justify-content: center; }
  .qr-card {
    background: #fff; border: 2px solid #1a1a2e; border-radius: 12px;
    padding: 1rem 0.75rem; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
    break-inside: avoid; page-break-inside: avoid;
  }
  .bar-name { font-size: 0.9rem; font-weight: 700; color: #1a1a2e; }
  .table-name { font-size: 1.5rem; font-weight: 800; }
  .qr-card img { width: 170px; height: 170px; margin: 0.25rem 0; }
  .caption { font-size: 0.72rem; color: #666; }
  .print-btn { display: block; margin: 1rem auto; padding: 0.6rem 2rem; font-size: 1rem; cursor: pointer; background: ${accent}; color: #fff; border: none; border-radius: 8px; }
  @media print { body { background: #fff; padding: 0; } h2, .print-btn { display: none; } .grid { gap: 0.5rem; } }
</style>
</head>
<body>
<h2>QR Codes — ${barName} (${db.tables.length} mesa${db.tables.length > 1 ? 's' : ''})</h2>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir Todos</button>
<div class="grid">${cards}</div>
<script>window.onload = () => window.print();</script>
</body>
</html>`);
});

// ─── API: Histórico de Chamadas ───────────────────────────────────────────────

app.get('/api/historico', adminAuth, (req, res) => {
  const db = readDB();
  const history = db.callHistory || [];

  const { date, table: tableFilter, limit: limitParam } = req.query;
  const limit = Math.min(parseInt(limitParam) || 200, 500);

  let filtered = history;
  if (date) filtered = filtered.filter(h => h.date === date);
  if (tableFilter) filtered = filtered.filter(h => h.tableId === tableFilter || h.tableName?.toLowerCase().includes(tableFilter.toLowerCase()));

  // Estatísticas do conjunto filtrado
  const withDuration = filtered.filter(h => h.attendedAt && h.calledAt);
  const durations = withDuration.map(h => (new Date(h.attendedAt) - new Date(h.calledAt)) / 1000);
  const avgSeconds = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const maxSeconds = durations.length ? Math.round(Math.max(...durations)) : null;

  // Mesa mais chamada
  const countByTable = {};
  filtered.forEach(h => { countByTable[h.tableName] = (countByTable[h.tableName] || 0) + 1; });
  const busiestTable = Object.entries(countByTable).sort((a, b) => b[1] - a[1])[0] || null;

  // Chamadas por hora (para o gráfico)
  const byHour = Array(24).fill(0);
  filtered.forEach(h => {
    const hour = new Date(h.calledAt).getHours();
    byHour[hour]++;
  });

  // Datas disponíveis (para o seletor)
  const dates = [...new Set(history.map(h => h.date))].sort().reverse();

  // Retorna mais recentes primeiro
  const records = filtered.slice().reverse().slice(0, limit).map(h => ({
    ...h,
    durationSeconds: h.attendedAt && h.calledAt
      ? Math.round((new Date(h.attendedAt) - new Date(h.calledAt)) / 1000)
      : null
  }));

  res.json({
    total: filtered.length,
    totalAllTime: history.length,
    avgSeconds,
    maxSeconds,
    busiestTable: busiestTable ? { name: busiestTable[0], count: busiestTable[1] } : null,
    byHour,
    dates,
    records
  });
});

app.delete('/api/historico', adminAuth, (req, res) => {
  const { date } = req.query;
  const db = readDB();
  if (!db.callHistory) { db.callHistory = []; }
  if (date) {
    db.callHistory = db.callHistory.filter(h => h.date !== date);
  } else {
    db.callHistory = [];
  }
  writeDB(db);
  res.json({ ok: true });
});

// ─── API: Cardápio ────────────────────────────────────────────────────────────

app.get('/api/menu', (req, res) => {
  const db = readDB();
  res.json(db.menu);
});

app.post('/api/menu', adminAuth, upload.single('cardapio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const db = readDB();

  // Remove arquivo antigo
  if (db.menu?.storedName) {
    const oldPath = path.join(UPLOADS_DIR, db.menu.storedName);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const ext = path.extname(req.file.originalname) || (req.file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
  const storedName = `cardapio_${Date.now()}${ext}`;
  fs.renameSync(req.file.path, path.join(UPLOADS_DIR, storedName));

  db.menu = {
    originalName: req.file.originalname,
    storedName,
    mimetype: req.file.mimetype,
    url: `/uploads/${storedName}`,
    uploadedAt: new Date().toISOString()
  };
  writeDB(db);

  res.json(db.menu);
});

app.delete('/api/menu', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.menu) return res.status(404).json({ error: 'Nenhum cardápio cadastrado' });

  const oldPath = path.join(UPLOADS_DIR, db.menu.storedName);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

  db.menu = null;
  writeDB(db);
  res.json({ ok: true });
});

// ─── API: Configurações do Bar ────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json(db.settings || {});
});

app.post('/api/settings', adminAuth, (req, res) => {
  const { barName, tagline, welcomeMessage, accentColor } = req.body;
  const db = readDB();
  if (!db.settings) db.settings = {};
  if (barName !== undefined) db.settings.barName = barName.trim().slice(0, 80);
  if (tagline !== undefined) db.settings.tagline = tagline.trim().slice(0, 120);
  if (welcomeMessage !== undefined) db.settings.welcomeMessage = welcomeMessage.trim().slice(0, 240);
  if (accentColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(accentColor)) db.settings.accentColor = accentColor;
  writeDB(db);
  res.json(db.settings);
});

app.post('/api/settings/logo', adminAuth, uploadImage.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });

  const db = readDB();
  if (!db.settings) db.settings = {};

  if (db.settings.logo?.storedName) {
    const oldPath = path.join(UPLOADS_DIR, db.settings.logo.storedName);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const ext = path.extname(req.file.originalname) || '.png';
  const storedName = `logo_${Date.now()}${ext}`;
  fs.renameSync(req.file.path, path.join(UPLOADS_DIR, storedName));

  db.settings.logo = {
    originalName: req.file.originalname,
    storedName,
    url: `/uploads/${storedName}`,
    uploadedAt: new Date().toISOString()
  };
  writeDB(db);
  res.json(db.settings.logo);
});

app.delete('/api/settings/logo', adminAuth, (req, res) => {
  const db = readDB();
  if (!db.settings?.logo) return res.status(404).json({ error: 'Nenhum logotipo cadastrado' });

  const oldPath = path.join(UPLOADS_DIR, db.settings.logo.storedName);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

  db.settings.logo = null;
  writeDB(db);
  res.json({ ok: true });
});

// ─── API: Ocupação das Mesas ──────────────────────────────────────────────────

app.post('/api/mesas/:tableId/status', adminAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['livre', 'ocupada'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido' });

  const db = readDB();
  const table = db.tables.find(t => t.id === req.params.tableId);
  if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });

  if (status === 'livre') {
    table.status = 'livre';
    table.occupiedAt = null;
    db.activeCalls = db.activeCalls.filter(c => c.tableId !== table.id);
  } else {
    table.status = 'ocupada';
    table.occupiedAt = new Date().toISOString();
  }
  writeDB(db);

  io.emit('table:status-changed', { tableId: table.id, status: table.status, occupiedAt: table.occupiedAt });
  res.json({ tableId: table.id, status: table.status });
});

// ─── API: Chamadas ────────────────────────────────────────────────────────────

app.get('/api/chamadas', (req, res) => {
  const db = readDB();
  res.json(db.activeCalls);
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Conectado: ${socket.id}`);

  socket.on('join:balcao', () => {
    socket.join('balcao');
    const db = readDB();
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = (db.callHistory || []).filter(h => h.date === today).length;
    // Envia status de todas as mesas junto com as chamadas pendentes
    const tableStatuses = db.tables.map(t => ({
      tableId: t.id, name: t.name,
      status: t.status || 'livre',
      occupiedAt: t.occupiedAt || null
    }));
    socket.emit('init:balcao', { pendingCalls: db.activeCalls, todayCount, tableStatuses });
    console.log(`[Socket] Balcão conectado: ${socket.id}`);
  });

  socket.on('table:call', ({ tableId }) => {
    const db = readDB();
    const table = db.tables.find(t => t.id === tableId);
    if (!table) { socket.emit('erro', { message: 'Mesa não encontrada' }); return; }

    const existing = db.activeCalls.find(c => c.tableId === tableId);
    if (existing) {
      socket.emit('call:confirmed', { tableId, tableName: table.name, repeated: true });
      return;
    }

    const call = {
      callId: uuidv4(),
      tableId: table.id,
      tableName: table.name,
      calledAt: new Date().toISOString(),
      timestamp: Date.now()
    };

    db.activeCalls.push(call);
    table.status = 'chamando';
    if (!table.occupiedAt) table.occupiedAt = call.calledAt;
    writeDB(db);

    io.to('balcao').emit('table:calling', call);
    io.emit('table:status-changed', { tableId: table.id, status: 'chamando', occupiedAt: table.occupiedAt });
    socket.emit('call:confirmed', { tableId, tableName: table.name });
    console.log(`[Socket] Mesa chamando: ${table.name}`);
  });

  socket.on('call:attend', ({ tableId }) => {
    const db = readDB();
    const callIdx = db.activeCalls.findIndex(c => c.tableId === tableId);
    if (callIdx === -1) return;

    const [call] = db.activeCalls.splice(callIdx, 1);
    if (!db.callHistory) db.callHistory = [];
    db.callHistory.push({
      tableId: call.tableId,
      tableName: call.tableName,
      calledAt: call.calledAt,
      attendedAt: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10)
    });
    if (db.callHistory.length > 500) db.callHistory = db.callHistory.slice(-500);

    // Volta para ocupada após atender
    const table = db.tables.find(t => t.id === tableId);
    if (table) table.status = 'ocupada';
    writeDB(db);

    const today = new Date().toISOString().slice(0, 10);
    io.emit('call:attended', { tableId, callId: call.callId });
    io.emit('table:status-changed', { tableId, status: 'ocupada', occupiedAt: table?.occupiedAt });
    io.to('balcao').emit('stats:update', { todayCount: db.callHistory.filter(h => h.date === today).length });
    console.log(`[Socket] Atendido: mesa ${call.tableName}`);
  });

  socket.on('table:open', ({ tableId }) => {
    const db = readDB();
    const table = db.tables.find(t => t.id === tableId);
    if (!table || table.status === 'chamando') return;
    table.status = 'ocupada';
    table.occupiedAt = new Date().toISOString();
    writeDB(db);
    io.emit('table:status-changed', { tableId, status: 'ocupada', occupiedAt: table.occupiedAt });
    console.log(`[Socket] Mesa aberta: ${table.name}`);
  });

  socket.on('table:close', ({ tableId }) => {
    const db = readDB();
    const table = db.tables.find(t => t.id === tableId);
    if (!table) return;
    table.status = 'livre';
    table.occupiedAt = null;
    db.activeCalls = db.activeCalls.filter(c => c.tableId !== tableId);
    writeDB(db);
    io.emit('table:status-changed', { tableId, status: 'livre', occupiedAt: null });
    io.emit('call:attended', { tableId, callId: null });
    console.log(`[Socket] Mesa liberada: ${table.name}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🍺 Chama o Garçom rodando em http://localhost:${PORT}`);
  console.log(`   Balcão: ${BASE_URL}/balcao`);
  console.log(`   Admin:  ${BASE_URL}/admin\n`);
});
