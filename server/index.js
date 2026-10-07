'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { seed } = require('./auth');
const S = require('./services/sessions');

async function createApp() {
  await db.init();
  seed();
  S.startTicker();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const pub = path.join(config.root, 'public');
  const nm = path.join(config.root, 'node_modules');
  app.use('/vendor/react', express.static(path.join(nm, 'react/umd')));
  app.use('/vendor/react-dom', express.static(path.join(nm, 'react-dom/umd')));
  app.use('/vendor/htm', express.static(path.join(nm, 'htm/dist')));
  app.use('/vendor/codemirror', express.static(path.join(nm, 'codemirror')));
  app.use(express.static(pub, { index: false, extensions: ['html'] }));

  app.get('/health', (req, res) => res.json({ ok: true, ai: config.ai.provider }));
  app.use('/api', require('./routes/auth'));
  app.use('/api', require('./routes/play'));
  app.use('/api', require('./routes/instructor'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // pages
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.get('/instructor', (req, res) => res.sendFile(path.join(pub, 'instructor.html')));
  app.get('/s/:token', (req, res) => res.sendFile(path.join(pub, 'student.html')));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  });
  return app;
}

async function start(port = config.port) {
  const app = await createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => resolve(server));
  });
}

module.exports = { createApp, start };

if (require.main === module) {
  start().then((server) => {
    const port = server.address().port;
    console.log('\n  AI-Enabled Virtual DBMS Laboratory');
    console.log(`  Instructor dashboard : http://localhost:${port}/instructor`);
    const ips = require('os').networkInterfaces();
    Object.values(ips).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).forEach((i) => console.log(`  LAN address          : http://${i.address}:${port}/   (students in the lab use this)`));
    console.log(`  Default instructor   : ${config.instructor.username} / ${config.instructor.password}`);
    console.log(`  AI module            : ${config.ai.provider === 'openai' ? 'LLM (' + config.ai.model + ') with template fallback' : 'built-in template engine (offline)'}`);
    console.log(`  Lockdown strict mode : ${config.lockdownStrict ? 'ON (assessments need the lockdown browser)' : 'off (browser lockdown works in any browser)'}\n`);
  });
  const stop = () => {
    db.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
