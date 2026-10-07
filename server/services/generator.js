'use strict';
// Equivalent Question Variant Generator (offline engine).
// One template per SQL concept; every student gets a different *variant*: different theme (table / column names),
// different data, different thresholds and different wording - but the same concept and difficulty.
// Every variant is validated (answerability + difficulty) and ships with visible and hidden test cases.
const { validate } = require('./validator');
const { extractConcepts } = require('./syllabusProcessor');
const config = require('../config');

// ---------------------------------------------------------------- random helpers
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
class RNG {
  constructor(seed) {
    this.f = mulberry32(seed >>> 0);
  }
  int(a, b) {
    return a + Math.floor(this.f() * (b - a + 1));
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const uniq = (a) => [...new Set(a)];

// ---------------------------------------------------------------- themes (same abstract schema, different vocabulary)
const FIRST = ['Asha', 'Bharath', 'Chitra', 'Deepak', 'Esha', 'Farhan', 'Gowri', 'Harsha', 'Isha', 'Jayanth', 'Kavya', 'Lakshmi', 'Manoj', 'Nisha', 'Omar', 'Priya', 'Quincy', 'Rohan', 'Sneha', 'Tarun', 'Uma', 'Vikram', 'Wasim', 'Yamini'];
const LAST = ['Rao', 'Iyer', 'Nair', 'Shah', 'Khan', 'Reddy', 'Menon', 'Gupta', 'Das', 'Pillai', 'Joshi', 'Bose'];
const THEMES = [
  {
    key: 'company',
    P: { table: 'departments', pk: 'dept_id', name: 'dept_name', region: 'location', budget: 'budget', noun: 'department', nouns: 'departments', regionLabel: 'location', budgetLabel: 'budget' },
    C: { table: 'employees', pk: 'emp_id', name: 'emp_name', fk: 'dept_id', amount: 'salary', year: 'hire_year', cat: 'grade', noun: 'employee', nouns: 'employees', amountLabel: 'salary', yearLabel: 'hire year', catLabel: 'grade' },
    regions: ['Bengaluru', 'Mumbai', 'Chennai', 'Delhi', 'Pune'], cats: ['G1', 'G2', 'G3'],
    pNames: ['Engineering', 'Finance', 'Marketing', 'Operations', 'Research', 'Support', 'Legal', 'Design'],
    words: [FIRST, LAST], amount: { lo: 30000, hi: 120000, step: 5000 },
  },
  {
    key: 'university',
    P: { table: 'faculties', pk: 'faculty_id', name: 'faculty_name', region: 'campus', budget: 'funding', noun: 'faculty', nouns: 'faculties', regionLabel: 'campus', budgetLabel: 'funding' },
    C: { table: 'students', pk: 'student_id', name: 'student_name', fk: 'faculty_id', amount: 'scholarship', year: 'admission_year', cat: 'program', noun: 'student', nouns: 'students', amountLabel: 'scholarship amount', yearLabel: 'admission year', catLabel: 'program' },
    regions: ['North Campus', 'South Campus', 'City Campus', 'Lake Campus'], cats: ['BTech', 'MTech', 'PhD'],
    pNames: ['Computing', 'Mechanical', 'Electrical', 'Civil', 'Biotechnology', 'Management', 'Architecture', 'Chemistry'],
    words: [FIRST, LAST], amount: { lo: 5000, hi: 60000, step: 1000 },
  },
  {
    key: 'retail',
    P: { table: 'stores', pk: 'store_id', name: 'store_name', region: 'city', budget: 'monthly_rent', noun: 'store', nouns: 'stores', regionLabel: 'city', budgetLabel: 'monthly rent' },
    C: { table: 'sales', pk: 'sale_id', name: 'product_name', fk: 'store_id', amount: 'revenue', year: 'sale_year', cat: 'product_type', noun: 'sale', nouns: 'sales', amountLabel: 'revenue', yearLabel: 'sale year', catLabel: 'product type' },
    regions: ['Mysuru', 'Hubballi', 'Mangaluru', 'Kochi', 'Coimbatore'], cats: ['grocery', 'apparel', 'electronics', 'toys'],
    pNames: ['Central Mart', 'Metro Bazaar', 'Green Basket', 'City Emporium', 'Value Hub', 'Prime Plaza', 'Daily Needs', 'Star Outlet'],
    words: [['Fresh', 'Urban', 'Classic', 'Smart', 'Royal', 'Eco', 'Mega', 'Daily', 'Silk', 'Turbo'], ['Basket', 'Jacket', 'Speaker', 'Puzzle', 'Cereal', 'Lamp', 'Sneakers', 'Blender', 'Kettle', 'Backpack']],
    amount: { lo: 500, hi: 9000, step: 100 },
  },
  {
    key: 'hospital',
    P: { table: 'wards', pk: 'ward_id', name: 'ward_name', region: 'floor_zone', budget: 'annual_budget', noun: 'ward', nouns: 'wards', regionLabel: 'floor zone', budgetLabel: 'annual budget' },
    C: { table: 'patients', pk: 'patient_id', name: 'patient_name', fk: 'ward_id', amount: 'bill_amount', year: 'admission_year', cat: 'severity', noun: 'patient', nouns: 'patients', amountLabel: 'bill amount', yearLabel: 'admission year', catLabel: 'severity level' },
    regions: ['East Wing', 'West Wing', 'North Block', 'South Block'], cats: ['mild', 'moderate', 'severe'],
    pNames: ['Cardiology', 'Neurology', 'Orthopaedics', 'Paediatrics', 'Oncology', 'Radiology', 'Maternity', 'Emergency'],
    words: [FIRST, LAST], amount: { lo: 2000, hi: 90000, step: 1000 },
  },
  {
    key: 'library',
    P: { table: 'branches', pk: 'branch_id', name: 'branch_name', region: 'district', budget: 'annual_grant', noun: 'branch', nouns: 'branches', regionLabel: 'district', budgetLabel: 'annual grant' },
    C: { table: 'books', pk: 'book_id', name: 'book_title', fk: 'branch_id', amount: 'price', year: 'publish_year', cat: 'genre', noun: 'book', nouns: 'books', amountLabel: 'price', yearLabel: 'publication year', catLabel: 'genre' },
    regions: ['Jayanagar', 'Indiranagar', 'Malleshwaram', 'Whitefield', 'Koramangala'], cats: ['fiction', 'science', 'history', 'poetry'],
    pNames: ['Central Library', 'Lake View', 'Heritage Hall', 'Tech Park', 'Riverside', 'Old Town', 'Garden City', 'Hilltop'],
    words: [['The Silent', 'A Brief', 'Hidden', 'Golden', 'Broken', 'Endless', 'Midnight', 'Crimson', 'Forgotten', 'Distant'], ['Garden', 'History', 'Theorem', 'Voyage', 'Mirror', 'Orchard', 'Machine', 'Harvest', 'Letters', 'Empire']],
    amount: { lo: 150, hi: 1500, step: 10 },
  },
  {
    key: 'logistics',
    P: { table: 'warehouses', pk: 'warehouse_id', name: 'warehouse_name', region: 'zone', budget: 'upkeep_cost', noun: 'warehouse', nouns: 'warehouses', regionLabel: 'zone', budgetLabel: 'upkeep cost' },
    C: { table: 'shipments', pk: 'shipment_id', name: 'shipment_label', fk: 'warehouse_id', amount: 'freight_cost', year: 'ship_year', cat: 'mode', noun: 'shipment', nouns: 'shipments', amountLabel: 'freight cost', yearLabel: 'shipping year', catLabel: 'transport mode' },
    regions: ['Zone-N', 'Zone-S', 'Zone-E', 'Zone-W'], cats: ['road', 'rail', 'air', 'sea'],
    pNames: ['Alpha Depot', 'Bravo Hub', 'Charlie Yard', 'Delta Store', 'Echo Dock', 'Foxtrot Park', 'Golf Base', 'Hotel Point'],
    words: [['Blue', 'Swift', 'Prime', 'Iron', 'Solar', 'Rapid', 'Nova', 'Atlas', 'Polar', 'Cobalt'], ['Cargo', 'Freight', 'Parcel', 'Pallet', 'Load', 'Consignment', 'Crate', 'Container', 'Batch', 'Haul']],
    amount: { lo: 1000, hi: 50000, step: 250 },
  },
];
const themeByKey = (k) => THEMES.find((t) => t.key === k) || THEMES[0];

// ---------------------------------------------------------------- data generation
function genData(t, rng) {
  const nP = rng.int(5, 6);
  const budgets = rng.shuffle([60, 80, 95, 120, 150, 175, 200]).slice(0, nP).map((b) => b * 1000);
  const pNames = rng.shuffle(t.pNames).slice(0, nP);
  const parents = pNames.map((name, i) => ({ id: (i + 1) * 10, name, region: rng.pick(t.regions), budget: budgets[i] }));
  const orphan = rng.int(0, nP - 1); // one parent without children (needed for outer-join questions)
  const eligible = parents.filter((_, i) => i !== orphan);
  const nC = rng.int(15, 20);
  const used = new Set();
  const children = [];
  const { lo, hi, step } = t.amount;
  for (let j = 0; j < nC; j++) {
    let name;
    for (let k = 0; k < 40; k++) {
      name = `${rng.pick(t.words[0])} ${rng.pick(t.words[1])}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    const parent = j < eligible.length * 2 ? eligible[j % eligible.length] : rng.pick(eligible);
    children.push({
      id: j + 1,
      name,
      fk: parent.id,
      amount: rng.int(lo / step, hi / step) * step,
      year: rng.int(2015, 2024),
      cat: rng.pick(t.cats),
    });
  }
  return { parents, children };
}

function schemaSql(t) {
  const { P, C } = t;
  return (
    `CREATE TABLE ${P.table} (${P.pk} INTEGER PRIMARY KEY, ${P.name} TEXT NOT NULL, ${P.region} TEXT, ${P.budget} INTEGER);\n` +
    `CREATE TABLE ${C.table} (${C.pk} INTEGER PRIMARY KEY, ${C.name} TEXT NOT NULL, ${C.fk} INTEGER REFERENCES ${P.table}(${P.pk}), ${C.amount} INTEGER, ${C.year} INTEGER, ${C.cat} TEXT);`
  );
}
function dataSql(t, d) {
  const { P, C } = t;
  const lines = [];
  for (const p of d.parents) lines.push(`INSERT INTO ${P.table} (${P.pk}, ${P.name}, ${P.region}, ${P.budget}) VALUES (${p.id}, ${q(p.name)}, ${q(p.region)}, ${p.budget});`);
  for (const c of d.children)
    lines.push(`INSERT INTO ${C.table} (${C.pk}, ${C.name}, ${C.fk}, ${C.amount}, ${C.year}, ${C.cat}) VALUES (${c.id}, ${q(c.name)}, ${c.fk}, ${c.amount}, ${c.year}, ${q(c.cat)});`);
  return lines.join('\n');
}

// threshold inside the theme's amount range (independent of one particular dataset)
const rangeX = (t, frac) => {
  const { lo, hi, step } = t.amount;
  return Math.round((lo + (hi - lo) * frac) / step) * step;
};

// ---------------------------------------------------------------- templates
// build(t, d, r) -> { text, solution, ordered?, qtype?, check?, concepts }  (null => try another seed)
const TEMPLATES = {
  select_where: {
    difficulty: 'easy', label: 'Selection & filtering',
    build(t, d, r) {
      const { C } = t;
      const cat = r.pick(uniq(d.children.map((c) => c.cat)));
      const x = rangeX(t, r.pick([0.3, 0.4, 0.5]));
      const text = r.pick([
        `List the ${C.nouns} in the ${q(cat)} ${C.catLabel} whose ${C.amountLabel} is greater than ${x}. Return ${C.name} and ${C.amount}.`,
        `Which ${C.nouns} have a ${C.amountLabel} above ${x} and belong to the ${q(cat)} ${C.catLabel}? Show ${C.name} and ${C.amount}.`,
      ]);
      return { concepts: ['SELECT', 'WHERE', 'AND'], text, solution: `SELECT ${C.name}, ${C.amount} FROM ${C.table} WHERE ${C.cat} = ${q(cat)} AND ${C.amount} > ${x}` };
    },
  },
  order_limit: {
    difficulty: 'easy', label: 'Sorting & limiting',
    build(t, d, r) {
      const { C } = t;
      const n = r.int(3, 5);
      if (r.int(0, 1)) {
        const hi = r.int(0, 1) === 0;
        return {
          concepts: ['ORDER BY', 'LIMIT'], ordered: true,
          text: `Show the ${hi ? 'top' : 'bottom'} ${n} ${C.nouns} by ${C.amountLabel} (${hi ? 'highest' : 'lowest'} first). Return ${C.name} and ${C.amount}. Break ties by ${C.pk} in ascending order.`,
          solution: `SELECT ${C.name}, ${C.amount} FROM ${C.table} ORDER BY ${C.amount} ${hi ? 'DESC' : 'ASC'}, ${C.pk} ASC LIMIT ${n}`,
        };
      }
      return {
        concepts: ['ORDER BY', 'LIMIT'], ordered: true,
        text: `Show the ${n} ${C.nouns} with the most recent ${C.yearLabel} (latest first). Return ${C.name} and ${C.year}. Break ties by ${C.pk} in ascending order.`,
        solution: `SELECT ${C.name}, ${C.year} FROM ${C.table} ORDER BY ${C.year} DESC, ${C.pk} ASC LIMIT ${n}`,
      };
    },
  },
  pattern: {
    difficulty: 'easy', label: 'Ranges, IN and LIKE',
    build(t, d, r) {
      const { C } = t;
      if (r.int(0, 1)) {
        const y1 = r.int(2016, 2019);
        const y2 = y1 + r.int(3, 5);
        const cats = r.shuffle(t.cats).slice(0, 2);
        return {
          concepts: ['BETWEEN', 'IN', 'WHERE'],
          text: `Find all ${C.nouns} whose ${C.yearLabel} is between ${y1} and ${y2} (inclusive) and whose ${C.catLabel} is one of ${cats.map(q).join(' or ')}. Return ${C.name}, ${C.year} and ${C.cat}.`,
          solution: `SELECT ${C.name}, ${C.year}, ${C.cat} FROM ${C.table} WHERE ${C.year} BETWEEN ${y1} AND ${y2} AND ${C.cat} IN (${cats.map(q).join(', ')})`,
        };
      }
      const counts = {};
      d.children.forEach((c) => (counts[c.name[0]] = (counts[c.name[0]] || 0) + 1));
      const letters = Object.keys(counts).filter((l) => counts[l] >= 2);
      if (!letters.length) return null;
      const L = r.pick(letters);
      const y = r.int(2015, 2019);
      return {
        concepts: ['LIKE', 'WHERE'],
        text: `List the ${C.nouns} whose ${C.name} starts with the letter '${L}' and whose ${C.yearLabel} is ${y} or later. Return ${C.name} and ${C.year}.`,
        solution: `SELECT ${C.name}, ${C.year} FROM ${C.table} WHERE ${C.name} LIKE '${L}%' AND ${C.year} >= ${y}`,
      };
    },
  },
  aggregate: {
    difficulty: 'easy', label: 'Aggregate functions',
    build(t, d, r) {
      const { C } = t;
      const cat = r.pick(t.cats);
      return {
        concepts: ['COUNT', 'SUM', 'AVG', 'MAX'],
        text: `For ${C.nouns} in the ${q(cat)} ${C.catLabel}, return a single row with: the number of ${C.nouns}, the total ${C.amountLabel}, the average ${C.amountLabel} rounded to 2 decimals, and the maximum ${C.amountLabel} (in this order).`,
        solution: `SELECT COUNT(*), SUM(${C.amount}), ROUND(AVG(${C.amount}), 2), MAX(${C.amount}) FROM ${C.table} WHERE ${C.cat} = ${q(cat)}`,
      };
    },
  },
  group_by_having: {
    difficulty: 'medium', label: 'GROUP BY and HAVING',
    build(t, d, r) {
      const { C, P } = t;
      if (r.int(0, 1)) {
        const k = r.int(3, 4);
        return {
          concepts: ['GROUP BY', 'HAVING', 'COUNT', 'AVG'],
          text: `For each ${C.catLabel}, return the ${C.catLabel}, the number of ${C.nouns} and their average ${C.amountLabel} rounded to 2 decimals - but only for ${C.catLabel} values that have more than ${k} ${C.nouns}.`,
          solution: `SELECT ${C.cat}, COUNT(*), ROUND(AVG(${C.amount}), 2) FROM ${C.table} GROUP BY ${C.cat} HAVING COUNT(*) > ${k}`,
        };
      }
      const sums = {};
      d.children.forEach((c) => (sums[c.fk] = (sums[c.fk] || 0) + c.amount));
      const vals = Object.values(sums).sort((a, b) => a - b);
      const T = Math.round(vals[Math.floor(vals.length / 2)] / 1000) * 1000;
      return {
        concepts: ['GROUP BY', 'HAVING', 'SUM'],
        text: `For each ${P.noun} (by ${C.fk}), return the ${C.fk} and the total ${C.amountLabel} of its ${C.nouns}, keeping only ${P.nouns} whose total is greater than ${T}.`,
        solution: `SELECT ${C.fk}, SUM(${C.amount}) FROM ${C.table} GROUP BY ${C.fk} HAVING SUM(${C.amount}) > ${T}`,
      };
    },
  },
  join_inner: {
    difficulty: 'medium', label: 'Inner joins',
    build(t, d, r) {
      const { C, P } = t;
      if (r.int(0, 1)) {
        const x = rangeX(t, r.pick([0.4, 0.5, 0.6]));
        return {
          concepts: ['INNER JOIN', 'WHERE'],
          text: `List every ${C.noun} whose ${C.amountLabel} is greater than ${x} together with the name and ${P.regionLabel} of its ${P.noun}. Return ${C.name}, ${P.name} and ${P.region}.`,
          solution: `SELECT c.${C.name}, p.${P.name}, p.${P.region} FROM ${C.table} c JOIN ${P.table} p ON c.${C.fk} = p.${P.pk} WHERE c.${C.amount} > ${x}`,
        };
      }
      return {
        concepts: ['INNER JOIN', 'GROUP BY', 'SUM'],
        text: `For each ${P.noun} that has at least one ${C.noun}, return the ${P.name} and the total ${C.amountLabel} of its ${C.nouns}.`,
        solution: `SELECT p.${P.name}, SUM(c.${C.amount}) FROM ${P.table} p JOIN ${C.table} c ON c.${C.fk} = p.${P.pk} GROUP BY p.${P.pk}, p.${P.name}`,
      };
    },
  },
  join_left: {
    difficulty: 'medium', label: 'Outer joins / unmatched rows',
    build(t, d, r) {
      const { C, P } = t;
      if (r.int(0, 1)) {
        return {
          concepts: ['LEFT JOIN', 'GROUP BY', 'COUNT'],
          text: `List every ${P.noun} (including those with none) with the number of ${C.nouns} it has. Return ${P.name} and the count; ${P.nouns} without ${C.nouns} must show 0.`,
          solution: `SELECT p.${P.name}, COUNT(c.${C.pk}) FROM ${P.table} p LEFT JOIN ${C.table} c ON c.${C.fk} = p.${P.pk} GROUP BY p.${P.pk}, p.${P.name}`,
        };
      }
      return {
        concepts: ['LEFT JOIN', 'IS NULL'],
        text: `Find the ${P.nouns} that do not have any ${C.nouns} at all. Return only the ${P.name}.`,
        solution: `SELECT p.${P.name} FROM ${P.table} p LEFT JOIN ${C.table} c ON c.${C.fk} = p.${P.pk} WHERE c.${C.pk} IS NULL`,
      };
    },
  },
  subquery: {
    difficulty: 'medium', label: 'Subqueries',
    build(t, d, r) {
      const { C, P } = t;
      const v = r.int(0, 2);
      if (v === 0)
        return {
          concepts: ['SUBQUERY', 'AVG'],
          text: `Find the ${C.nouns} whose ${C.amountLabel} is above the overall average ${C.amountLabel} of all ${C.nouns}. Return ${C.name} and ${C.amount}.`,
          solution: `SELECT ${C.name}, ${C.amount} FROM ${C.table} WHERE ${C.amount} > (SELECT AVG(${C.amount}) FROM ${C.table})`,
        };
      if (v === 1)
        return {
          concepts: ['SUBQUERY', 'ORDER BY', 'LIMIT'],
          text: `List the ${C.nouns} that belong to the ${P.noun} with the highest ${P.budgetLabel}. Return ${C.name} and ${C.amount}.`,
          solution: `SELECT ${C.name}, ${C.amount} FROM ${C.table} WHERE ${C.fk} = (SELECT ${P.pk} FROM ${P.table} ORDER BY ${P.budget} DESC LIMIT 1)`,
        };
      return {
        concepts: ['SUBQUERY', 'AVG'],
        text: `Which ${P.nouns} have a ${P.budgetLabel} greater than the average ${P.budgetLabel} of all ${P.nouns}? Return ${P.name} and ${P.budget}.`,
        solution: `SELECT ${P.name}, ${P.budget} FROM ${P.table} WHERE ${P.budget} > (SELECT AVG(${P.budget}) FROM ${P.table})`,
      };
    },
  },
  exists_correlated: {
    difficulty: 'hard', label: 'Correlated subqueries / EXISTS',
    build(t, d, r) {
      const { C, P } = t;
      const v = r.int(0, 2);
      if (v === 0)
        return {
          concepts: ['CORRELATED SUBQUERY', 'AVG'],
          text: `Find the ${C.nouns} whose ${C.amountLabel} is greater than the average ${C.amountLabel} of the ${C.nouns} in the same ${P.noun}. Return ${C.name}, ${C.fk} and ${C.amount}.`,
          solution: `SELECT ${C.name}, ${C.fk}, ${C.amount} FROM ${C.table} c WHERE ${C.amount} > (SELECT AVG(${C.amount}) FROM ${C.table} WHERE ${C.fk} = c.${C.fk})`,
        };
      if (v === 1) {
        const x = rangeX(t, r.pick([0.8, 0.85, 0.9]));
        return {
          concepts: ['EXISTS'],
          text: `List the ${P.nouns} that have at least one ${C.noun} with a ${C.amountLabel} greater than ${x}. Return ${P.name}.`,
          solution: `SELECT ${P.name} FROM ${P.table} p WHERE EXISTS (SELECT 1 FROM ${C.table} c WHERE c.${C.fk} = p.${P.pk} AND c.${C.amount} > ${x})`,
        };
      }
      const y = r.int(2022, 2024);
      return {
        concepts: ['NOT EXISTS'],
        text: `List the ${P.nouns} that have ${C.nouns} but none with a ${C.yearLabel} of ${y} or later. Return ${P.name}.`,
        solution: `SELECT ${P.name} FROM ${P.table} p WHERE EXISTS (SELECT 1 FROM ${C.table} c WHERE c.${C.fk} = p.${P.pk}) AND NOT EXISTS (SELECT 1 FROM ${C.table} c WHERE c.${C.fk} = p.${P.pk} AND c.${C.year} >= ${y})`,
      };
    },
  },
  set_ops: {
    difficulty: 'medium', label: 'Set operations',
    build(t, d, r) {
      const { C } = t;
      const x = rangeX(t, r.pick([0.6, 0.7]));
      const y = r.int(2020, 2022);
      const A = `SELECT ${C.cat} FROM ${C.table} WHERE ${C.amount} > ${x}`;
      const B = `SELECT ${C.cat} FROM ${C.table} WHERE ${C.year} >= ${y}`;
      const v = r.int(0, 2);
      const a = `${C.catLabel} values that appear among ${C.nouns} with a ${C.amountLabel} greater than ${x}`;
      const b = `among ${C.nouns} with a ${C.yearLabel} of ${y} or later`;
      if (v === 0) return { concepts: ['INTERSECT'], text: `List each ${a} AND also ${b}. Return each ${C.catLabel} once.`, solution: `${A} INTERSECT ${B}` };
      if (v === 1) return { concepts: ['EXCEPT'], text: `List each ${a} but do NOT appear ${b}. Return each ${C.catLabel} once.`, solution: `${A} EXCEPT ${B}` };
      return { concepts: ['UNION'], text: `List every ${C.catLabel} that appears among ${C.nouns} with a ${C.amountLabel} greater than ${x} OR ${b}. Return each ${C.catLabel} once.`, solution: `${A} UNION ${B}` };
    },
  },
  window: {
    difficulty: 'hard', label: 'Window functions',
    build(t, d, r) {
      const { C, P } = t;
      if (r.int(0, 1))
        return {
          concepts: ['RANK', 'OVER', 'PARTITION BY'],
          text: `Rank the ${C.nouns} within each ${P.noun} by ${C.amountLabel} (highest = rank 1; ties share a rank, use RANK). Return ${C.name}, ${C.fk}, ${C.amount} and the rank.`,
          solution: `SELECT ${C.name}, ${C.fk}, ${C.amount}, RANK() OVER (PARTITION BY ${C.fk} ORDER BY ${C.amount} DESC) FROM ${C.table}`,
        };
      return {
        concepts: ['SUM', 'OVER', 'ORDER BY'],
        text: `For every ${C.noun}, return ${C.pk}, ${C.name}, ${C.year}, ${C.amount} and a running total of ${C.amountLabel} when ${C.nouns} are ordered by ${C.year} and then ${C.pk} (both ascending).`,
        solution: `SELECT ${C.pk}, ${C.name}, ${C.year}, ${C.amount}, SUM(${C.amount}) OVER (ORDER BY ${C.year}, ${C.pk}) FROM ${C.table}`,
      };
    },
  },
  case_expr: {
    difficulty: 'medium', label: 'CASE expressions',
    build(t, d, r) {
      const { C } = t;
      const H = rangeX(t, r.pick([0.6, 0.66, 0.7]));
      const M = rangeX(t, r.pick([0.3, 0.33, 0.4]));
      return {
        concepts: ['CASE'],
        text: `Classify each ${C.noun} by ${C.amountLabel}: 'high' if it is at least ${H}, 'medium' if it is at least ${M} (but below ${H}), otherwise 'low'. Return ${C.name}, ${C.amount} and the class.`,
        solution: `SELECT ${C.name}, ${C.amount}, CASE WHEN ${C.amount} >= ${H} THEN 'high' WHEN ${C.amount} >= ${M} THEN 'medium' ELSE 'low' END FROM ${C.table}`,
      };
    },
  },
  dml: {
    difficulty: 'medium', label: 'INSERT / UPDATE / DELETE',
    build(t, d, r) {
      const { C, P } = t;
      const v = r.int(0, 2);
      if (v === 0) {
        const pc = r.pick([5, 10, 15, 20]);
        const cat = r.pick(t.cats);
        const y = r.int(2018, 2022);
        return {
          qtype: 'script', ordered: true, concepts: ['UPDATE', 'WHERE'],
          text: `Increase the ${C.amountLabel} of every ${C.noun} in the ${q(cat)} ${C.catLabel} with a ${C.yearLabel} before ${y} by ${pc} percent. Use integer arithmetic: ${C.amount} = ${C.amount} + ${C.amount} * ${pc} / 100.`,
          solution: `UPDATE ${C.table} SET ${C.amount} = ${C.amount} + ${C.amount} * ${pc} / 100 WHERE ${C.cat} = ${q(cat)} AND ${C.year} < ${y}`,
          check: `SELECT ${C.pk}, ${C.amount} FROM ${C.table} ORDER BY ${C.pk}`,
        };
      }
      if (v === 1) {
        const x = rangeX(t, r.pick([0.15, 0.2, 0.25]));
        return {
          qtype: 'script', ordered: true, concepts: ['DELETE', 'WHERE'],
          text: `Delete every ${C.noun} whose ${C.amountLabel} is below ${x}.`,
          solution: `DELETE FROM ${C.table} WHERE ${C.amount} < ${x}`,
          check: `SELECT ${C.pk} FROM ${C.table} ORDER BY ${C.pk}`,
        };
      }
      const cat = r.pick(t.cats);
      const A = rangeX(t, r.pick([0.4, 0.5, 0.6]));
      const y = r.int(2020, 2024);
      const nm = `${r.pick(['Zed', 'Nova', 'Orion', 'Terra'])} ${r.pick(['Quinn', 'Vale', 'Marsh', 'Frost'])}`;
      return {
        qtype: 'script', ordered: true, concepts: ['INSERT'],
        text: `Insert one new ${C.noun}: ${C.pk} = 900, ${C.name} = ${q(nm)}, ${C.fk} = 10, ${C.amount} = ${A}, ${C.year} = ${y}, ${C.cat} = ${q(cat)}.`,
        solution: `INSERT INTO ${C.table} (${C.pk}, ${C.name}, ${C.fk}, ${C.amount}, ${C.year}, ${C.cat}) VALUES (900, ${q(nm)}, 10, ${A}, ${y}, ${q(cat)})`,
        check: `SELECT * FROM ${C.table} ORDER BY ${C.pk}`,
      };
    },
  },
  view: {
    difficulty: 'medium', label: 'Views',
    build(t, d, r) {
      const { C, P } = t;
      const x = rangeX(t, r.pick([0.4, 0.5, 0.6]));
      const name = `v_${C.table}_${r.pick(['overview', 'report', 'summary'])}`;
      return {
        qtype: 'script', concepts: ['VIEW', 'JOIN'],
        text: `Create a view named ${name} that lists every ${C.noun} with a ${C.amountLabel} greater than ${x}, showing (in this order) ${C.name}, the ${P.name} of its ${P.noun}, and ${C.amount}.`,
        solution: `CREATE VIEW ${name} AS SELECT c.${C.name}, p.${P.name}, c.${C.amount} FROM ${C.table} c JOIN ${P.table} p ON c.${C.fk} = p.${P.pk} WHERE c.${C.amount} > ${x}`,
        check: `SELECT * FROM ${name}`,
      };
    },
  },
  ddl_create: {
    difficulty: 'medium', label: 'DDL and constraints',
    build(t, d, r) {
      const { C } = t;
      const nn = r.pick([[C.name], [C.name, C.amount], [C.name, C.cat]]);
      const tbl = `${C.table}_archive`;
      const col = (n, type, extra = '') => `${n} ${type}${nn.includes(n) ? ' NOT NULL' : ''}${extra}`;
      return {
        qtype: 'script', ordered: true, concepts: ['CREATE TABLE', 'PRIMARY KEY', 'NOT NULL'],
        text: `Create a table named ${tbl} with exactly these columns in this order: ${C.pk} INTEGER (primary key), ${C.name} TEXT, ${C.amount} INTEGER, ${C.cat} TEXT. The columns ${nn.join(' and ')} must be NOT NULL. Use the data types exactly as written.`,
        solution: `CREATE TABLE ${tbl} (${C.pk} INTEGER PRIMARY KEY, ${col(C.name, 'TEXT')}, ${col(C.amount, 'INTEGER')}, ${col(C.cat, 'TEXT')})`,
        check: `SELECT name, type, "notnull", pk FROM pragma_table_info('${tbl}') ORDER BY cid`,
      };
    },
  },
};

// ---------------------------------------------------------------- syllabus topic -> templates
const LABEL_TO_KEY = [
  [/GROUP BY|HAVING/, 'group_by_having'],
  [/LEFT|RIGHT|FULL|OUTER|NULL/, 'join_left'],
  [/JOIN/, 'join_inner'],
  [/CORRELATED|EXISTS/, 'exists_correlated'],
  [/SUBQUER|NESTED/, 'subquery'],
  [/UNION|INTERSECT|EXCEPT|SET OP|MINUS/, 'set_ops'],
  [/WINDOW|RANK|OVER|PARTITION/, 'window'],
  [/^CASE|CONDITIONAL/, 'case_expr'],
  [/VIEW/, 'view'],
  [/CREATE TABLE|ALTER|PRIMARY KEY|FOREIGN KEY|CONSTRAINT|DDL|INDEX/, 'ddl_create'],
  [/INSERT|UPDATE|DELETE|DML|MODIF/, 'dml'],
  [/COUNT|SUM|AVG|MIN|MAX|AGGREGAT/, 'aggregate'],
  [/ORDER|SORT|LIMIT|TOP/, 'order_limit'],
  [/LIKE|BETWEEN|^IN$|PATTERN|RANGE/, 'pattern'],
  [/SELECT|WHERE|DISTINCT|FILTER|PROJECTION/, 'select_where'],
];
const DEFAULT_BY_DIFFICULTY = {
  easy: ['select_where', 'order_limit', 'pattern', 'aggregate'],
  medium: ['group_by_having', 'join_inner', 'join_left', 'set_ops', 'case_expr', 'dml', 'view'],
  hard: ['subquery', 'exists_correlated', 'window'],
};

function templatesForTopic(topic) {
  const concepts = Array.isArray(topic.concepts) ? topic.concepts : [];
  const labels = uniq([...concepts.map((c) => String(c).toUpperCase()), ...extractConcepts(`${topic.name} ${concepts.join(' ')}`)]);
  const keys = [];
  for (const l of labels) {
    for (const [re, key] of LABEL_TO_KEY) {
      if (re.test(l)) {
        if (!keys.includes(key)) keys.push(key);
        break;
      }
    }
  }
  if (!keys.length) keys.push(...(DEFAULT_BY_DIFFICULTY[topic.difficulty] || DEFAULT_BY_DIFFICULTY.medium).slice(0, 2));
  return keys;
}

// ---------------------------------------------------------------- building one validated variant
// Build one validated question (with visible + hidden datasets). Throws if no valid variant is found.
async function buildVariant({ templateKey, seed, themeKey, hidden = config.hiddenTestCases, visible = config.visibleTestCases }) {
  const tpl = TEMPLATES[templateKey];
  if (!tpl) throw new Error('Unknown template ' + templateKey);
  let lastReason = 'no attempt';
  for (let attempt = 0; attempt < 12; attempt++) {
    const s = seed + attempt * 7919;
    const rng = new RNG(s);
    const t = themeKey && attempt === 0 ? themeByKey(themeKey) : rng.pick(THEMES);
    const schema = schemaSql(t);
    const vis = genData(t, rng);
    const spec = tpl.build(t, vis, rng);
    if (!spec) continue;
    const qtype = spec.qtype || 'query';
    const datasets = [{ id: 'v0', kind: 'visible', sql: dataSql(t, vis) }];
    const base = await validate({ qtype, schema, datasets, solution: spec.solution, check: spec.check, declaredDifficulty: tpl.difficulty });
    if (!base.ok) {
      lastReason = base.reason;
      continue;
    }
    // additional datasets: each is regenerated (different seed) until the reference answer is meaningful on it
    let ok = true;
    const kinds = [...Array(Math.max(0, visible - 1)).fill('visible'), ...Array(hidden).fill('hidden')];
    for (let i = 0; i < kinds.length && ok; i++) {
      let accepted = false;
      for (let k = 0; k < 8 && !accepted; k++) {
        const ds = { id: `d${i + 1}`, kind: kinds[i], sql: dataSql(t, genData(t, new RNG(hashSeed(s, 'extra', i, k)))) };
        const trial = await validate({ qtype, schema, datasets: [...datasets, ds], solution: spec.solution, check: spec.check, declaredDifficulty: tpl.difficulty });
        if (trial.ok) {
          datasets.push(ds);
          accepted = true;
        } else lastReason = trial.reason;
      }
      ok = accepted;
    }
    if (!ok) continue;
    const final = await validate({ qtype, schema, datasets, solution: spec.solution, check: spec.check, declaredDifficulty: tpl.difficulty });
    if (!final.ok) {
      lastReason = final.reason;
      continue;
    }
    return {
      template_key: templateKey, theme: t.key, seed: s, qtype, text: spec.text, schema_sql: schema, solution_sql: spec.solution,
      check_sql: spec.check || null, ordered: spec.ordered ? 1 : 0, difficulty: tpl.difficulty, concepts: spec.concepts,
      datasets: datasets.map((d) => ({ ...d, expected: final.expected[d.id] })), validation: final.validation, source: 'ai-template',
    };
  }
  throw new Error(`Could not generate a valid ${templateKey} variant (${lastReason})`);
}

// One extra dataset (visible/hidden test case) for an existing question, validated against its reference solution.
async function extraDataset({ question, seed, kind }) {
  const t = themeByKey(question.theme);
  for (let k = 0; k < 10; k++) {
    const sql = dataSql(t, genData(t, new RNG(hashSeed(seed, 'x', k))));
    const trial = await validate({
      qtype: question.qtype, schema: question.schema_sql, datasets: [{ id: 'x', kind, sql }], solution: question.solution_sql, check: question.check_sql,
      declaredDifficulty: question.difficulty,
    });
    // single dataset => the "identical on all datasets" check cannot trigger
    if (trial.ok) return { kind, sql, expected: trial.expected.x };
  }
  throw new Error('Could not build a meaningful extra test case');
}

module.exports = { THEMES, TEMPLATES, themeByKey, templatesForTopic, buildVariant, extraDataset, hashSeed, RNG, genData, dataSql, schemaSql };
