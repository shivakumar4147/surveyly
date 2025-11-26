const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8081;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

// Supabase admin client (service role) used for protected operations
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminClient = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`Request for ${req.url}`);
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // Serve public Supabase env (URL and anon key only)
  if (pathname === '/env.json' && req.method === 'GET') {
    const payload = {
      SUPABASE_URL: process.env.SUPABASE_URL || '',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || ''
    };
    return sendJson(res, 200, payload);
  }

  // Admin delete endpoint (protected by password; uses service role)
  if (pathname === '/admin/delete' && req.method === 'POST') {
    if (!adminClient) return sendJson(res, 500, { error: 'Admin client not configured' });
    try {
      const body = await parseBody(req);
      const { entity_type, id, admin_password } = body;
      if (!entity_type || !id) return sendJson(res, 400, { error: 'Missing entity_type or id' });
      if (!admin_password || admin_password !== ADMIN_PASSWORD) return sendJson(res, 403, { error: 'Invalid admin password' });

      const allowedTables = new Set(['survey_questions', 'survey_responses', 'suggestions', 'question_bank', 'version_history']);
      if (!allowedTables.has(entity_type)) return sendJson(res, 400, { error: 'Invalid entity_type' });

      const { error } = await adminClient.from(entity_type).delete().eq('id', id);
      if (error) return sendJson(res, 500, { error: error.message });
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Static file serving fallback
  // Normalize URL to prevent directory traversal
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }

  // Get the file extension
  const extname = path.extname(filePath);
  let contentType = MIME_TYPES[extname] || 'application/octet-stream';

  // Read the file
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Page not found
        fs.readFile('./index.html', (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end('Error loading index.html');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
          }
        });
      } else {
        // Server error
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      // Success
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});