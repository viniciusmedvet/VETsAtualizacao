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

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>QR Code - ${table.name}</title>
<style>
  body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fff; }
  h1 { font-size: 2.5rem; margin: 0.5rem 0; color: #1a1a2e; }
  img { width: 300px; height: 300px; }
  p { color: #555; font-size: 0.9rem; margin: 0.5rem 0; }
  @media print { button { display: none; } }
</style>
</head>
<body>
<h1>${table.name}</h1>
<img src="/qrcodes/${table.id}.png" alt="QR Code ${table.name}">
<p>Escaneie para chamar o garçom</p>
<button onclick="window.print()" style="margin-top:1rem;padding:0.6rem 1.5rem;cursor:pointer;">Imprimir</button>
<script>window.onload = () => window.print();</script>
</body>
</html>`);
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
    socket.emit('init:balcao', { pendingCalls: db.activeCalls });
    console.log(`[Socket] Balcão conectado: ${socket.id}`);
  });

  socket.on('table:call', ({ tableId }) => {
    const db = readDB();
    const table = db.tables.find(t => t.id === tableId);
    if (!table) {
      socket.emit('erro', { message: 'Mesa não encontrada' });
      return;
    }

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
    writeDB(db);

    io.to('balcao').emit('table:calling', call);
    socket.emit('call:confirmed', { tableId, tableName: table.name });
    console.log(`[Socket] Mesa chamando: ${table.name}`);
  });

  socket.on('call:attend', ({ tableId }) => {
    const db = readDB();
    const callIdx = db.activeCalls.findIndex(c => c.tableId === tableId);
    if (callIdx === -1) return;

    const [call] = db.activeCalls.splice(callIdx, 1);
    writeDB(db);

    io.emit('call:attended', { tableId, callId: call.callId });
    console.log(`[Socket] Atendido: mesa ${call.tableName}`);
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
