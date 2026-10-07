'use strict';
// Syllabus Processing Module: turns an uploaded syllabus (txt / md / csv / pdf / docx or pasted text) into
// topics, learning objectives, SQL concepts and a difficulty level. The syllabus is the single source that drives
// every AI-generated question and test case.
const path = require('path');

// regex -> canonical concept label (specific phrases first)
const CONCEPT_PATTERNS = [
  [/primary key/, 'PRIMARY KEY'], [/foreign key/, 'FOREIGN KEY'], [/create table/, 'CREATE TABLE'], [/alter table/, 'ALTER TABLE'],
  [/group by|grouping/, 'GROUP BY'], [/order by|sorting/, 'ORDER BY'], [/inner join/, 'INNER JOIN'], [/left (outer )?join/, 'LEFT JOIN'],
  [/right (outer )?join/, 'RIGHT JOIN'], [/full (outer )?join/, 'FULL JOIN'], [/outer join/, 'OUTER JOIN'], [/cross join/, 'CROSS JOIN'],
  [/natural join/, 'NATURAL JOIN'], [/self[- ]join/, 'SELF JOIN'], [/set operation/, 'SET OPERATIONS'], [/window function|analytic function/, 'WINDOW FUNCTIONS'],
  [/correlated/, 'CORRELATED SUBQUERY'], [/nested quer|sub-?quer/, 'SUBQUERY'], [/aggregate/, 'AGGREGATE FUNCTIONS'], [/constraint/, 'CONSTRAINTS'],
  [/partition by/, 'PARTITION BY'], [/\bselect\b|projection/, 'SELECT'], [/\bwhere\b|filter/, 'WHERE'], [/\bdistinct\b/, 'DISTINCT'],
  [/\blimit\b/, 'LIMIT'], [/\blike\b/, 'LIKE'], [/\bbetween\b/, 'BETWEEN'], [/\bhaving\b/, 'HAVING'], [/\bcount\b/, 'COUNT'],
  [/\bsum\b/, 'SUM'], [/\bavg\b|average/, 'AVG'], [/\bmin\b/, 'MIN'], [/\bmax\b/, 'MAX'], [/\bjoins?\b/, 'JOIN'],
  [/\bexists\b/, 'EXISTS'], [/\bunion\b/, 'UNION'], [/\bintersect\b/, 'INTERSECT'], [/\bexcept\b|\bminus\b/, 'EXCEPT'],
  [/\brank\b|dense_rank|row_number/, 'RANK'], [/\bover\s*\(/, 'OVER'], [/\bcase\b/, 'CASE'], [/\binsert\b/, 'INSERT'],
  [/\bupdate\b/, 'UPDATE'], [/\bdelete\b/, 'DELETE'], [/\bviews?\b/, 'VIEW'], [/\bindex(es)?\b/, 'INDEX'], [/\bddl\b/, 'DDL'],
  [/\bdml\b/, 'DML'], [/\bnull\b/, 'NULL HANDLING'], [/\bin\s*\(|\bin operator/, 'IN'],
];

function extractConcepts(text) {
  const low = String(text).toLowerCase();
  const found = [];
  for (const [re, label] of CONCEPT_PATTERNS) if (re.test(low) && !found.includes(label)) found.push(label);
  // drop generic labels when a more specific one is present
  const drop = new Set();
  if (found.some((f) => /^(INNER|LEFT|RIGHT|FULL|OUTER|CROSS|NATURAL|SELF) JOIN$/.test(f))) drop.add('JOIN');
  if (found.includes('CORRELATED SUBQUERY')) drop.add('SUBQUERY');
  return found.filter((f) => !drop.has(f));
}

const HARD = /advanced|complex|window|correlated|recursive|analytic|optimi[sz]|rank\b|exists/i;
const EASY = /basic|introduc|simple|fundamental|retriev|beginner|elementary|select\b.*where|filtering/i;

function guessDifficulty(text) {
  const m = text.match(/\[(easy|medium|hard)\]/i);
  if (m) return m[1].toLowerCase();
  if (HARD.test(text)) return 'hard';
  if (EASY.test(text)) return 'easy';
  return 'medium';
}

const normDifficulty = (d) => {
  d = String(d || '').trim().toLowerCase();
  if (/^e/.test(d)) return 'easy';
  if (/^h|^d/.test(d)) return 'hard';
  return 'medium';
};

const cleanName = (s) => s.replace(/^\s*(#+|[-*•●▪]|\d+[.)]|(unit|module|topic|chapter|lab|week)\s*\d*\s*[:.\-–]?)\s*/i, '').replace(/\[(easy|medium|hard)\]/i, '').trim();

function parseStructured(lines) {
  // Topic | concept, concept | difficulty | learning objective
  const topics = [];
  for (const line of lines.filter((l) => !/^\s*(#|\/\/)/.test(l))) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const name = cleanName(parts[0]);
    let concepts = parts[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const extra = extractConcepts(parts[1]);
    concepts = concepts.length ? concepts.map((c) => c.toUpperCase()) : extra;
    topics.push({
      name,
      concepts: [...new Set(concepts)],
      difficulty: parts[2] ? normDifficulty(parts[2]) : guessDifficulty(line),
      objectives: parts[3] || '',
    });
  }
  return topics;
}

function parseFreeText(lines) {
  const isHeading = (l) => /^(#+\s|\d+[.)]\s|(unit|module|topic|chapter|lab|week)\s*\d*\s*[:.\-–])/i.test(l);
  const isBullet = (l) => /^[-*•●▪]\s/.test(l) || /^\s{2,}\S/.test(l);
  const blocks = [];
  let cur = null;
  const anyHeading = lines.some(isHeading);
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (anyHeading ? isHeading(l) : !isBullet(raw)) {
      cur = { head: l, body: [] };
      blocks.push(cur);
    } else if (cur) cur.body.push(l);
  }
  return blocks.map((b) => {
    let name = cleanName(b.head);
    let tail = '';
    const colon = name.indexOf(':');
    if (colon > 0) {
      tail = name.slice(colon + 1);
      name = name.slice(0, colon).trim();
    }
    const body = [tail, ...b.body].join(' ');
    const objLine = b.body.find((x) => /^(lo|objective|learning objective|outcome)s?\s*[:\-]/i.test(x.replace(/^[-*•●▪]\s*/, '')));
    const all = `${name} ${body}`;
    return {
      name,
      concepts: extractConcepts(all),
      difficulty: guessDifficulty(b.head + ' ' + body),
      objectives: objLine ? objLine.replace(/^[-*•●▪]\s*/, '').replace(/^[^:\-]*[:\-]\s*/, '') : '',
    };
  });
}

function parseSyllabus(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const piped = lines.filter((l) => l.includes('|') && l.split('|').length >= 2);
  let topics = piped.length >= 1 && piped.length >= lines.filter((l) => l.trim()).length / 2 ? parseStructured(piped) : parseFreeText(lines);
  // de-duplicate & clean
  const seen = new Set();
  topics = topics
    .filter((t) => t.name && t.name.length > 1 && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
    .slice(0, 40)
    .map((t, i) => ({
      ...t,
      position: i,
      objectives:
        t.objectives ||
        `Students can apply ${t.concepts.length ? t.concepts.slice(0, 4).join(', ') : t.name} correctly in SQL.`,
    }));
  return topics;
}

async function extractText(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.pdf') {
    const pdf = require('pdf-parse');
    return (await pdf(file.buffer)).text;
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  }
  return file.buffer.toString('utf8');
}

module.exports = { parseSyllabus, extractText, extractConcepts, normDifficulty };
