// Parameter expressions: the same small grammar as scriptcad/params.py, which is what
// the kernel actually evaluates. The UI uses this to validate fields and show values.

const D = Math.PI / 180;
const FUNCS = { sqrt: Math.sqrt, sin: d => Math.sin(d * D), cos: d => Math.cos(d * D), tan: d => Math.tan(d * D),
  abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil };
const CONSTS = { pi: Math.PI };
export const NAME = /^[A-Za-z_]\w*$/;

/** Value of a number or expression string over the names in env; throws Error on bad input. */
export function evaluate(text, env = {}) {
  if (typeof text === 'number') return text;
  const src = String(text ?? '').trim();
  if (!src) throw new Error('empty value');
  const toks = src.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_]\w*|\*\*|\S/gi);
  let i = 0;
  const peek = () => toks[i], eat = t => toks[i] === t && ++i;
  const bad = () => { throw new Error(`cannot read '${src}'`); };
  function expr() {
    let v = term();
    for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; }
  }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) { const d = unary(); if (d === 0) throw new Error(`division by zero in '${src}'`); v /= d; }
      else if (eat('%')) { const d = unary(); v = ((v % d) + d) % d; }     // sign of the divisor, as in Python
      else return v;
    }
  }
  function unary() {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    const b = atom();
    return eat('^') || eat('**') ? b ** unary() : b;
  }
  function atom() {
    const t = peek();
    if (t === undefined) bad();
    i++;
    if (t === '(') { const v = expr(); if (!eat(')')) bad(); return v; }
    if (/^[\d.]/.test(t)) return +t;
    if (!NAME.test(t)) bad();
    if (eat('(')) {
      if (!FUNCS[t]) bad();
      const args = [expr()];
      while (eat(',')) args.push(expr());
      if (!eat(')')) bad();
      return FUNCS[t](...args);
    }
    if (t in env) return env[t];
    if (t in CONSTS) return CONSTS[t];
    throw new Error(`unknown variable '${t}'`);
  }
  const v = expr();
  if (i < toks.length) bad();
  if (!Number.isFinite(v)) throw new Error(`'${src}' is not a finite number`);
  return v;
}

/** {name: value} for a document's variables, each over the ones above it. Throws on the first bad one. */
export function variables(doc) {
  const env = {};
  for (const v of doc.variables || []) {
    const name = String(v.name ?? '').trim();
    if (!NAME.test(name) || name in FUNCS || name in CONSTS) throw new Error(`'${name}' is not a usable variable name`);
    if (name in env) throw new Error(`variable '${name}' is defined twice`);
    try { env[name] = evaluate(v.value, env); } catch (e) { throw new Error(`variable '${name}': ${e.message}`); }
  }
  return env;
}

/** Variables that do evaluate, skipping broken ones (for previews while one is being typed). */
export function variablesLenient(doc) {
  const env = {};
  for (const v of doc.variables || []) {
    const name = String(v.name ?? '').trim();
    if (!NAME.test(name) || name in env) continue;
    try { env[name] = evaluate(v.value, env); } catch {}
  }
  return env;
}
