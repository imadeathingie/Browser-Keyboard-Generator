/**
 * Sandboxed evaluator for the Python-syntax arithmetic expressions used in
 * keyboard JSON `*_algo` fields, e.g.
 *
 *   "(x*key_1u+16-x) if (x >= 5 and y == 4) else x*key_1u"
 *
 * Faithful port of keylist_gen.parse_algo(): the same whitelist of names
 * (x, y, z, width, height, key_1u) and functions (abs, min, max, floor,
 * ceil, round), the same operators (+ - * / // % **, comparisons incl.
 * chaining, and/or/not, conditional `a if t else b`), with Python semantics
 * for %, //, truthiness and round() (banker's rounding).
 */

export type PyValue = number | boolean;

type Env = Record<string, number>;

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'kw'; v: 'if' | 'else' | 'and' | 'or' | 'not' }
  | { t: 'end' };

const KEYWORDS = new Set(['if', 'else', 'and', 'or', 'not']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i}`);
      toks.push({ t: 'num', v: parseFloat(m[1]) });
      i += m[1].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const w = m[0];
      if (KEYWORDS.has(w)) toks.push({ t: 'kw', v: w as any });
      else toks.push({ t: 'name', v: w });
      i += w.length;
      continue;
    }
    // multi-char operators first
    const two = src.slice(i, i + 2);
    if (two === '**' || two === '//' || two === '==' || two === '!=' ||
        two === '<=' || two === '>=') {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`Disallowed character '${c}' in expression`);
  }
  toks.push({ t: 'end' });
  return toks;
}

// ------------------------------------------------------------------- parser
// Grammar (Python precedence, low -> high):
//   ternary  := or ('if' or 'else' ternary)?
//   or       := and ('or' and)*
//   and      := not ('and' not)*
//   not      := 'not' not | comparison
//   compare  := arith ((==|!=|<|<=|>|>=) arith)*      (chained)
//   arith    := term (('+'|'-') term)*
//   term     := unary (('*'|'/'|'//'|'%') unary)*
//   unary    := ('+'|'-') unary | power
//   power    := atom ('**' unary)?                    (right-assoc)
//   atom     := NUM | NAME | NAME '(' args ')' | '(' ternary ')'

type Node =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'unary'; op: '+' | '-' | 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'bool'; op: 'and' | 'or'; parts: Node[] }
  | { k: 'cmp'; first: Node; ops: string[]; rest: Node[] }
  | { k: 'cond'; test: Node; body: Node; orelse: Node };

const ALLOWED_FUNCS = new Set(['abs', 'min', 'max', 'floor', 'ceil', 'round']);
const ALLOWED_NAMES = new Set(['x', 'y', 'z', 'width', 'height', 'key_1u']);

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }
  private eatOp(v: string): boolean {
    const t = this.peek();
    if (t.t === 'op' && t.v === v) { this.p++; return true; }
    return false;
  }
  private eatKw(v: string): boolean {
    const t = this.peek();
    if (t.t === 'kw' && t.v === v) { this.p++; return true; }
    return false;
  }

  parse(): Node {
    const node = this.ternary();
    if (this.peek().t !== 'end') throw new Error('Unexpected trailing tokens');
    return node;
  }

  private ternary(): Node {
    const body = this.orExpr();
    if (this.eatKw('if')) {
      const test = this.orExpr();
      if (!this.eatKw('else')) throw new Error("Expected 'else' in conditional expression");
      const orelse = this.ternary();
      return { k: 'cond', test, body, orelse };
    }
    return body;
  }

  private orExpr(): Node {
    const parts = [this.andExpr()];
    while (this.eatKw('or')) parts.push(this.andExpr());
    return parts.length === 1 ? parts[0] : { k: 'bool', op: 'or', parts };
  }

  private andExpr(): Node {
    const parts = [this.notExpr()];
    while (this.eatKw('and')) parts.push(this.notExpr());
    return parts.length === 1 ? parts[0] : { k: 'bool', op: 'and', parts };
  }

  private notExpr(): Node {
    if (this.eatKw('not')) return { k: 'unary', op: 'not', a: this.notExpr() };
    return this.compare();
  }

  private compare(): Node {
    const first = this.arith();
    const ops: string[] = [];
    const rest: Node[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
        this.p++;
        ops.push(t.v);
        rest.push(this.arith());
      } else break;
    }
    return ops.length === 0 ? first : { k: 'cmp', first, ops, rest };
  }

  private arith(): Node {
    let a = this.term();
    for (;;) {
      if (this.eatOp('+')) a = { k: 'bin', op: '+', a, b: this.term() };
      else if (this.eatOp('-')) a = { k: 'bin', op: '-', a, b: this.term() };
      else return a;
    }
  }

  private term(): Node {
    let a = this.unary();
    for (;;) {
      if (this.eatOp('*')) a = { k: 'bin', op: '*', a, b: this.unary() };
      else if (this.eatOp('/')) a = { k: 'bin', op: '/', a, b: this.unary() };
      else if (this.eatOp('//')) a = { k: 'bin', op: '//', a, b: this.unary() };
      else if (this.eatOp('%')) a = { k: 'bin', op: '%', a, b: this.unary() };
      else return a;
    }
  }

  private unary(): Node {
    if (this.eatOp('+')) return { k: 'unary', op: '+', a: this.unary() };
    if (this.eatOp('-')) return { k: 'unary', op: '-', a: this.unary() };
    return this.power();
  }

  private power(): Node {
    const base = this.atom();
    if (this.eatOp('**')) {
      // Right-associative; exponent may carry a unary sign (2 ** -1).
      return { k: 'bin', op: '**', a: base, b: this.unary() };
    }
    return base;
  }

  private atom(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'name') {
      if (this.eatOp('(')) {
        if (!ALLOWED_FUNCS.has(t.v)) throw new Error(`Disallowed function '${t.v}'`);
        const args: Node[] = [];
        if (!this.eatOp(')')) {
          args.push(this.ternary());
          while (this.eatOp(',')) args.push(this.ternary());
          if (!this.eatOp(')')) throw new Error("Expected ')'");
        }
        return { k: 'call', fn: t.v, args };
      }
      if (!ALLOWED_NAMES.has(t.v)) throw new Error(`Disallowed name '${t.v}'`);
      return { k: 'name', v: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const inner = this.ternary();
      if (!this.eatOp(')')) throw new Error("Expected ')'");
      return inner;
    }
    throw new Error('Unexpected token in expression');
  }
}

// ---------------------------------------------------------------- evaluator

function truthy(v: PyValue): boolean {
  return typeof v === 'boolean' ? v : v !== 0;
}

function asNum(v: PyValue): number {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

/** Python `%`: result has the sign of the divisor. */
function pyMod(a: number, b: number): number {
  if (b === 0) throw new Error('modulo by zero');
  return a - Math.floor(a / b) * b;
}

/** Python `round()` with no ndigits: half-to-even (banker's rounding). */
function pyRound(v: number): number {
  const floor = Math.floor(v);
  const diff = v - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function evalNode(node: Node, env: Env): PyValue {
  switch (node.k) {
    case 'num': return node.v;
    case 'name': return env[node.v];
    case 'call': {
      const args = node.args.map(a => asNum(evalNode(a, env)));
      switch (node.fn) {
        case 'abs': return Math.abs(args[0]);
        case 'min': return Math.min(...args);
        case 'max': return Math.max(...args);
        case 'floor': return Math.floor(args[0]);
        case 'ceil': return Math.ceil(args[0]);
        case 'round': return pyRound(args[0]);
      }
      throw new Error(`Disallowed function '${node.fn}'`);
    }
    case 'unary': {
      if (node.op === 'not') return !truthy(evalNode(node.a, env));
      const v = asNum(evalNode(node.a, env));
      return node.op === '-' ? -v : v;
    }
    case 'bin': {
      const a = asNum(evalNode(node.a, env));
      const b = asNum(evalNode(node.b, env));
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new Error('division by zero');
          return a / b;
        case '//':
          if (b === 0) throw new Error('integer division by zero');
          return Math.floor(a / b);
        case '%': return pyMod(a, b);
        case '**': return Math.pow(a, b);
      }
      throw new Error(`Disallowed operator '${node.op}'`);
    }
    case 'bool': {
      // Python short-circuit semantics: return the deciding operand's value.
      let v: PyValue = evalNode(node.parts[0], env);
      for (let i = 1; i < node.parts.length; i++) {
        if (node.op === 'and') {
          if (!truthy(v)) return v;
        } else {
          if (truthy(v)) return v;
        }
        v = evalNode(node.parts[i], env);
      }
      return v;
    }
    case 'cmp': {
      // Chained comparisons: a < b < c  ==  (a < b) and (b < c)
      let left = asNum(evalNode(node.first, env));
      for (let i = 0; i < node.ops.length; i++) {
        const right = asNum(evalNode(node.rest[i], env));
        let ok: boolean;
        switch (node.ops[i]) {
          case '==': ok = left === right; break;
          case '!=': ok = left !== right; break;
          case '<': ok = left < right; break;
          case '<=': ok = left <= right; break;
          case '>': ok = left > right; break;
          case '>=': ok = left >= right; break;
          default: throw new Error('Disallowed comparison');
        }
        if (!ok) return false;
        left = right;
      }
      return true;
    }
    case 'cond':
      return truthy(evalNode(node.test, env))
        ? evalNode(node.body, env)
        : evalNode(node.orelse, env);
  }
}

const cache = new Map<string, Node>();

/**
 * Evaluate an algo expression with the given variables. Mirrors
 * keylist_gen.parse_algo(expr, x, y, z, w, h, key_1u).
 */
export function parseAlgo(
  expr: string, x: number, y: number, z: number,
  w: number, h: number, key1u = 19.05,
): number {
  let node = cache.get(expr);
  if (!node) {
    node = new Parser(tokenize(expr)).parse();
    cache.set(expr, node);
  }
  const v = evalNode(node, { x, y, z, width: w, height: h, key_1u: key1u });
  return asNum(v);
}
