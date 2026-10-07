'use strict';
// AI Module (LLM / Generative AI). Works with any OpenAI-compatible chat-completions endpoint:
//   OpenAI                -> AI_PROVIDER=openai AI_API_KEY=sk-...  AI_MODEL=gpt-4o-mini
//   Local LLM via Ollama  -> AI_PROVIDER=openai AI_BASE_URL=http://localhost:11434/v1 AI_API_KEY=ollama AI_MODEL=llama3.1
//   LM Studio / vLLM etc. -> same pattern with their /v1 URL.
// With AI_PROVIDER=none (default) the built-in offline template engine (generator.js) is used - everything still works.
// Every LLM answer passes through the same validator as template questions, and falls back to the template engine on failure.
const config = require('../config');

const enabled = () => config.ai.provider === 'openai' && (config.ai.apiKey || /localhost|127\.0\.0\.1/.test(config.ai.baseUrl));

async function chat(messages, { json = false, maxTokens = 1800 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.ai.timeoutMs);
  try {
    const body = { model: config.ai.model, messages, temperature: 0.8, max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    const res = await fetch(config.ai.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey || 'none'}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const j = await res.json();
    return j.choices[0].message.content;
  } finally {
    clearTimeout(timer);
  }
}

const extractJson = (s) => {
  const m = String(s).match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : s);
};

// Ask the LLM for a brand-new question variant. Returns a raw proposal (not yet validated) or throws.
async function proposeQuestion({ topic, conceptHint, difficulty, avoidTexts = [], hidden, visible, qtypeHint }) {
  const sys = 'You are an expert DBMS lab instructor creating SQL assessment questions. Reply with JSON only.';
  const user = `Create ONE SQL question for the topic "${topic.name}" (concepts: ${(topic.concepts || []).join(', ') || conceptHint}).
Difficulty: ${difficulty}. Dialect: SQLite. Learning objective: ${topic.objectives || 'apply the concepts correctly'}.
Invent your OWN small schema (2 tables, realistic names; avoid these themes already used: ${avoidTexts.slice(0, 6).map((t) => t.slice(0, 40)).join(' | ') || 'none'}).
The question text must state exactly which columns to return and any ordering (with a deterministic tie-break).
Produce datasets: ${visible} visible and ${hidden} hidden, each ONLY INSERT statements for the same schema (12-20 rows total per dataset), with different data each.
JSON shape:
{"theme":"short word","question":"...","schema_sql":"CREATE TABLE ...;CREATE TABLE ...;","solution_sql":"single SQL statement (or script for DML/DDL)",
 "type":"query" | "script","check_sql":"only for type script: a SELECT that shows the resulting state","ordered":true|false,
 "concepts":["..."],"datasets":["INSERT ...;","INSERT ...;"]}
${qtypeHint || ''}`;
  const out = extractJson(await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true }));
  if (!out.question || !out.schema_sql || !out.solution_sql || !Array.isArray(out.datasets) || out.datasets.length < 2) throw new Error('LLM answer incomplete');
  return out;
}

// Concept-focused feedback. Must never reveal hidden data or the full solution.
async function feedbackText({ question, sqlText, outcome }) {
  const prompt = `A student answered a SQL question. Give 2-3 short sentences of concept-focused feedback.
RULES: never reveal the solution query, never reveal hidden test data, no code blocks. Point at the concept to revisit.
Question: ${question.text}
Concepts: ${(question.concepts || []).join(', ')}
Student SQL: ${sqlText.slice(0, 1200)}
Automatic test outcome: ${outcome}`;
  return (await chat([{ role: 'user', content: prompt }], { maxTokens: 220 })).trim();
}

module.exports = { enabled, proposeQuestion, feedbackText };
