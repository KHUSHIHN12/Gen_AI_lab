'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { sign, hash, check, auth } = require('../auth');

const router = express.Router();
const clean = (s) => String(s || '').trim();

router.post('/auth/login', (req, res) => {
  const u = db.get('SELECT * FROM users WHERE username = ?', [clean(req.body.username).toLowerCase()]);
  if (!u || !check(req.body.password, u.password_hash)) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: sign(u), user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});

// Students register themselves ONLY from a live session page (scan the QR code / open the session URL).
// The instructor cannot create or edit student accounts; the dashboard only shows how many students exist.
router.post('/auth/register', (req, res) => {
  if (!config.allowStudentRegistration) return res.status(403).json({ error: 'Registration is disabled' });
  const sess = db.get('SELECT * FROM sessions WHERE token = ?', [clean(req.body.session).toLowerCase()]);
  if (!sess) return res.status(400).json({ error: 'Register from the session link: scan the QR code or open the URL shown in the lab.' });
  if (sess.status !== 'live') return res.status(409).json({ error: 'This session is not live. Wait for the instructor to broadcast it.' });
  const username = clean(req.body.username).toLowerCase();
  const name = clean(req.body.name);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Roll number / username: 3-30 letters, digits, . _ -' });
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must have at least 4 characters' });
  if (db.get('SELECT id FROM users WHERE username = ?', [username])) return res.status(409).json({ error: 'That roll number / username is already registered - use "Log in" instead' });
  const id = db.run('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)', [username, name, 'student', hash(password), db.now()]).lastId;
  const u = db.get('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ token: sign(u), user: { id, username, name, role: 'student' } });
});

router.get('/auth/me', auth(), (req, res) => res.json({ user: req.user }));

// Instructor sees only the NUMBER of registered students.
router.get('/students/count', auth('instructor'), (req, res) => {
  res.json({ count: db.get("SELECT COUNT(*) n FROM users WHERE role = 'student'").n });
});

module.exports = router;
