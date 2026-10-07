'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name, username: u.username }, config.jwtSecret, { expiresIn: '12h' });
const hash = (pw) => bcrypt.hashSync(String(pw), 8);
const check = (pw, h) => bcrypt.compareSync(String(pw), h);

// Express middleware: authenticate (Bearer header, or ?token= for file downloads) and optionally restrict by role (RBAC).
function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const p = jwt.verify(token, config.jwtSecret);
      const user = db.get('SELECT id, username, name, role FROM users WHERE id = ?', [p.id]);
      if (!user) return res.status(401).json({ error: 'Unknown user' });
      if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Forbidden for your role' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Session expired, please log in again' });
    }
  };
}

function seed() {
  const ins = db.get("SELECT id FROM users WHERE role = 'instructor' LIMIT 1");
  if (!ins) {
    db.run('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)', [
      config.instructor.username, config.instructor.name, 'instructor', hash(config.instructor.password), db.now(),
    ]);
  }
  if (config.seedDemoStudents && !db.get("SELECT id FROM users WHERE role = 'student' LIMIT 1")) {
    const names = ['Asha Rao', 'Bharath K', 'Chitra S', 'Deepak M', 'Esha P', 'Farhan A', 'Gowri N', 'Harsha V'];
    names.forEach((n, i) =>
      db.run('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)', [
        `student${String(i + 1).padStart(2, '0')}`, n, 'student', hash('student123'), db.now(),
      ])
    );
  }
}

module.exports = { sign, hash, check, auth, seed };
