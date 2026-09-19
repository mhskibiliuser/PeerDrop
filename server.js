const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Busboy = require('@fastify/busboy');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const STORAGE_TOKEN = process.env.STORAGE_TOKEN || '';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function auth(req) {
  if (!STORAGE_TOKEN) return true;
  return req.headers.authorization === 'Bearer ' + STORAGE_TOKEN;
}

function safeName(name) {
  const cleaned = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned.slice(0, 240) || 'file';
}

function id() {
  return crypto.randomBytes(12).toString('hex');
}

function fileUrl(req, fileId) {
  return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + '/files/' + fileId : 'http://' + req.headers.host + '/files/' + fileId;
}

async function saveUpload(req, res) {
  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });

  const bb = new Busboy({
    headers: req.headers,
    limits: { files: 1, fields: 8, parts: 9, fileSize: 20 * 1024 * 1024 * 1024 }
  });

  let saved = null;
  let writePromise = null;

  bb.on('file', (fieldname, file, info) => {
    const originalName = safeName(info.filename);
    const fileId = id();
    const storedName = fileId + path.extname(originalName);
    const target = path.join(UPLOAD_DIR, storedName);
    const temp = target + '.part';

    let size = 0;
    const out = fs.createWriteStream(temp);

    file.on('data', chunk => { size += chunk.length; });
    file.on('limit', () => file.destroy(new Error('file too large')));
    file.on('error', err => out.destroy(err));

    writePromise = new Promise((resolve, reject) => {
      out.on('finish', async () => {
        try {
          await fsp.rename(temp, target);
          const meta = {
            id: fileId,
            name: originalName,
            size,
            type: info.mimeType || 'application/octet-stream',
            storedName,
            created: new Date().toISOString()
          };
          await fsp.writeFile(path.join(UPLOAD_DIR, fileId + '.json'), JSON.stringify(meta, null, 2));
          saved = meta;
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      out.on('error', reject);
    });

    file.pipe(out);
  });

  bb.on('error', err => {
    if (writePromise) writePromise.catch(() => {});
    json(res, 400, { error: err.message || 'upload failed' });
  });

  bb.on('finish', async () => {
    try {
      if (writePromise) await writePromise;
      if (!saved) return json(res, 400, { error: 'no file supplied' });
      json(res, 201, {
        id: saved.id,
        name: saved.name,
        size: saved.size,
        type: saved.type,
        url: fileUrl(req, saved.id)
      });
    } catch (e) {
      json(res, 500, { error: 'could not save file' });
    }
  });

  req.pipe(bb);
}

async function serveFile(req, res, fileId) {
  if (!/^[a-f0-9]{24}$/.test(fileId)) return json(res, 404, { error: 'not found' });

  try {
    const meta = JSON.parse(await fsp.readFile(path.join(UPLOAD_DIR, fileId + '.json'), 'utf8'));
    const filePath = path.join(UPLOAD_DIR, meta.storedName);
    const stat = await fsp.stat(filePath);

    res.writeHead(200, {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="' + meta.name.replace(/"/g, '') + '"',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://' + req.headers.host);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'PeerDrop server storage' });
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    return saveUpload(req, res);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    return serveFile(req, res, url.pathname.slice('/files/'.length));
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, {
      service: 'PeerDrop server storage',
      upload: 'POST /upload',
      file: 'GET /files/:id'
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log('PeerDrop storage server listening on ' + HOST + ':' + PORT);
  console.log('Upload directory: ' + UPLOAD_DIR);
});
