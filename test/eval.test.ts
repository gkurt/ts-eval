import type { Eval, EvalWith, Logs, EvalError } from '../src/index';
import type { Expect, Equal } from './helpers';

// --- the headline example ---------------------------------------------------
export type Basics = [
  Expect<Equal<Eval<'function(a,b) { return a + b; }', 5, 3>, 8>>,
  Expect<Equal<Eval<'(a, b) => a * b', 6, 7>, 42>>,
  Expect<Equal<Eval<'1 + 2 * 3 - 4 / 2'>, 5>>,
  Expect<Equal<Eval<'2 ** 3 ** 2'>, 512>>,
  Expect<Equal<Eval<'(1 + 2) * 3'>, 9>>,
  Expect<Equal<Eval<'7 % 3 + -7 % 3'>, 0>>,
  Expect<Equal<Eval<'0.1 + 0.2'>, 0.3>>,
  Expect<Equal<Eval<'10 / 4'>, 2.5>>,
  Expect<Equal<Eval<'"a" + 1 + 2'>, 'a12'>>,
  Expect<Equal<Eval<'1 + 2 + "a"'>, '3a'>>,
  Expect<Equal<Eval<'"5" * "2"'>, 10>>,
  Expect<Equal<Eval<'typeof null'>, 'object'>>,
  Expect<Equal<Eval<'typeof (() => 1)'>, 'function'>>,
  Expect<Equal<Eval<'typeof notDefined'>, 'undefined'>>,
  Expect<Equal<Eval<'1 < 2 && 2 < 3 || false'>, true>>,
  Expect<Equal<Eval<'null ?? "default"'>, 'default'>>,
  Expect<Equal<Eval<'0 || "fallback"'>, 'fallback'>>,
  Expect<Equal<Eval<'1 == "1"'>, true>>,
  Expect<Equal<Eval<'1 === "1"'>, false>>,
  Expect<Equal<Eval<'null == undefined'>, true>>,
  Expect<Equal<Eval<'"apple" < "banana"'>, true>>,
  Expect<Equal<Eval<'5 > 3 ? "yes" : "no"'>, 'yes'>>,
  Expect<Equal<Eval<'(12 & 10) | (1 << 4)'>, 24>>,
  Expect<Equal<Eval<'-16 >> 2'>, -4>>,
  Expect<Equal<Eval<'~5'>, -6>>,
];

// --- functions, recursion, closures -----------------------------------------
export type Functions = [
  Expect<Equal<Eval<'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }', 12>, 144>>,
  Expect<Equal<Eval<'function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }', 25>, 15511210043330985984000000n>>,
  Expect<Equal<Eval<`function(n) {
    function isEven(n) { return n === 0 ? true : isOdd(n - 1) }
    function isOdd(n) { return n === 0 ? false : isEven(n - 1) }
    return isEven(n)
  }`, 21>, false>>,
  Expect<Equal<Eval<`function() {
    function counter() { let c = 0; return { inc: () => ++c, get: () => c } }
    const a = counter(), b = counter();
    a.inc(); a.inc(); b.inc();
    return [a.get(), b.get()]
  }`>, [2, 1]>>,
  Expect<Equal<Eval<'function(x, y = x * 2, ...rest) { return [x, y, rest] }', 1>, [1, 2, []]>>,
  Expect<Equal<Eval<'function(...xs) { return xs.length }', 1, 2, 3, 4>, 4>>,
  Expect<Equal<Eval<'(f => f(f))(f => 42)'>, 42>>,
  Expect<Equal<Eval<'function(n) { function down(x) { return x === 0 ? 0 : down(x - 1) + 1 } return down(n) }', 7>, 7>>,
  Expect<Equal<Eval<'function(n) { const add = a => b => a + b; return add(n)(10) }', 5>, 15>>,
  Expect<Equal<Eval<`function() {
    const fns = [];
    for (let i = 0; i < 3; i++) { const j = i; fns.push(() => j * 10) }
    return fns.map(f => f())
  }`>, [0, 10, 20]>>,
  Expect<Equal<Eval<'function() { const fns = []; for (let i = 0; i < 3; i++) fns.push(() => i); return fns.map(f => f()) }'>, [0, 1, 2]>>,
  Expect<Equal<Eval<'function() { const fns = []; for (var i = 0; i < 3; i++) fns.push(() => i); return fns.map(f => f()) }'>, [3, 3, 3]>>,
  Expect<Equal<Eval<`function ack(m, n) {
    return m === 0 ? n + 1 : n === 0 ? ack(m - 1, 1) : ack(m - 1, ack(m, n - 1))
  }`, 2, 3>, 9>>,
  Expect<Equal<Eval<`function() {
    const o = { n: 5, double() { return this.n * 2 } };
    return o.double()
  }`>, 10>>,
  Expect<Equal<Eval<`function() {
    function Point(x, y) { this.x = x; this.y = y }
    const p = new Point(3, 4);
    return Math.sqrt(p.x * p.x + p.y * p.y)
  }`>, 5>>,
];

// --- control flow ------------------------------------------------------------
export type Control = [
  Expect<Equal<Eval<'function(n) { let s = 0; for (let i = 1; i <= n; i++) { if (i % 2) continue; s += i } return s }', 10>, 30>>,
  Expect<Equal<Eval<'function() { let i = 0; while (true) { if (++i > 5) break } return i }'>, 6>>,
  Expect<Equal<Eval<'function() { let i = 0; do { i += 3 } while (i < 10); return i }'>, 12>>,
  Expect<Equal<Eval<`function(x) {
    switch (x) { case "a": return 1; case "b": case "c": return 2; default: return 3 }
  }`, 'c'>, 2>>,
  Expect<Equal<Eval<'function() { let out = []; for (const k in { a: 1, b: 2 }) out.push(k); return out }'>, ['a', 'b']>>,
  Expect<Equal<Eval<'function() { let s = ""; for (const ch of "abc") s = ch + s; return s }'>, 'cba'>>,
  Expect<Equal<Eval<`function() {
    let r = [];
    outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j > i) break; r.push(i * 10 + j) } }
    return r
  }`>, EvalError<"SyntaxError: Unexpected token :">>>,
  Expect<Equal<Eval<`function() {
    var x = 1;
    { var x = 2 }
    return x
  }`>, 2>>,
  Expect<Equal<Eval<`function() {
    let x = 1;
    { let x = 2 }
    return x
  }`>, 1>>,
  Expect<Equal<Eval<'function() { for (var i = 0; i < 4; i++) {} return i }'>, 4>>,
];

// --- exceptions --------------------------------------------------------------
export type Exceptions = [
  Expect<Equal<Eval<'function() { try { throw new Error("boom") } catch (e) { return e.message } }'>, 'boom'>>,
  Expect<Equal<Eval<'function() { let log = []; try { log.push(1); throw 2 } catch (e) { log.push(e) } finally { log.push(3) } return log }'>, [1, 2, 3]>>,
  Expect<Equal<Eval<'function() { undefinedFn() }'>, EvalError<'Uncaught ReferenceError: undefinedFn is not defined'>>>,
  Expect<Equal<Eval<'function() { const x = 5; x() }'>, EvalError<'Uncaught TypeError: 5 is not a function'>>>,
  Expect<Equal<Eval<'function() { throw new RangeError("bad") }'>, EvalError<'Uncaught RangeError: bad'>>>,
  Expect<Equal<Eval<`function() {
    function f() { throw "inner" }
    try { f() } catch (e) { return "caught " + e }
  }`>, 'caught inner'>>,
  Expect<Equal<Eval<'function(a b) { return 1 }'>, EvalError<'SyntaxError: Unexpected token a in parameter list'>>>,
  Expect<Equal<Eval<'function() { return 1 +; }'>, EvalError<'SyntaxError: Unexpected token ;'>>>,
];

// --- arrays ------------------------------------------------------------------
export type Arrays = [
  Expect<Equal<Eval<'function(a) { return a.map((x, i) => x * i) }', [1, 2, 3]>, [0, 2, 6]>>,
  Expect<Equal<Eval<'function(a) { return a.filter(x => x % 2).length }', [1, 2, 3, 4, 5]>, 3>>,
  Expect<Equal<Eval<'function(a) { return a.reduce((m, x) => x > m ? x : m) }', [3, 9, 2]>, 9>>,
  Expect<Equal<Eval<'function(a) { return a.indexOf(3) + a.includes(9) }', [1, 2, 3]>, 2>>,
  Expect<Equal<Eval<'function(a) { return a.slice(1, -1).join("-") }', [1, 2, 3, 4]>, '2-3'>>,
  Expect<Equal<Eval<'function(a) { return [...a, ...a].length }', [1, 2]>, 4>>,
  Expect<Equal<Eval<'function(a) { const b = a.splice(1, 2, "x"); return [a, b] }', [1, 2, 3, 4]>, [[1, 'x', 4], [2, 3]]>>,
  Expect<Equal<Eval<'function(a) { a.length = 1; return a }', [1, 2, 3]>, [1]>>,
  Expect<Equal<Eval<'function() { return [3, 1, 10, 2].sort() }'>, [1, 10, 2, 3]>>,
  Expect<Equal<Eval<'function() { return ["b", "a", "c"].sort().reverse() }'>, ['c', 'b', 'a']>>,
  Expect<Equal<Eval<'function() { return [[1, 2], [3]].flat().concat([4], 5) }'>, [1, 2, 3, 4, 5]>>,
  Expect<Equal<Eval<'function() { return Array.from({ length: 4 }, (_, i) => i * i) }'>, [0, 1, 4, 9]>>,
  Expect<Equal<Eval<'function() { return new Array(3).fill(0) }'>, [0, 0, 0]>>,
  Expect<Equal<Eval<'function() { return [1, 2, 3].find(x => x > 1) + [1, 2, 3].findIndex(x => x > 5) }'>, 1>>,
  Expect<Equal<Eval<'function() { return [1, 2, 3].some(x => x > 2) && [1, 2, 3].every(x => x > 0) }'>, true>>,
  Expect<Equal<Eval<'function() { const a = [1, 2]; a.unshift(0); a.push(3); return [a.shift(), a.pop(), a] }'>, [0, 3, [1, 2]]>>,
  Expect<Equal<Eval<'function() { return [1, [2, 3]].toString() + "|" + String([]) }'>, '1,2,3|'>>,
];

// --- strings -----------------------------------------------------------------
export type Strings = [
  Expect<Equal<Eval<'function(s) { return s.length }', 'hello world'>, 11>>,
  Expect<Equal<Eval<'function(s) { return s[1] + s.charAt(4) + s.at(-1) }', 'hello'>, 'eoo'>>,
  Expect<Equal<Eval<'function(s) { return s.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ") }', 'the quick brown fox'>, 'The Quick Brown Fox'>>,
  Expect<Equal<Eval<'function(s) { return s.indexOf("o") + "," + s.lastIndexOf("o") }', 'hello world'>, '4,7'>>,
  Expect<Equal<Eval<'"  pad  ".trim().padStart(6, "*").padEnd(8, "-")'>, '***pad--'>>,
  Expect<Equal<Eval<'"a-b-c".replace("-", "+") + "|" + "a-b-c".replaceAll("-", "")'>, 'a+b-c|abc'>>,
  Expect<Equal<Eval<'"abc".repeat(3).substring(2, 5)'>, 'cab'>>,
  Expect<Equal<Eval<'"A".charCodeAt(0) + String.fromCharCode(66, 67)'>, '65BC'>>,
  Expect<Equal<Eval<'"Hello".startsWith("He") && "Hello".endsWith("lo") && "Hello".includes("ell")'>, true>>,
  Expect<Equal<Eval<'`${1 + 1} + ${"two"} = ${[1, 2]}`'>, '2 + two = 1,2'>>,
  Expect<Equal<Eval<'parseInt("42px") + parseFloat("3.5") + Number("0.5")'>, 46>>,
  Expect<Equal<Eval<'(255).toString(2) + "/" + (3.14159).toFixed(2)'>, '11111111/3.14'>>,
  Expect<Equal<Eval<'JSON.stringify({ a: [1, "x", null], b: { c: true } })'>, '{"a":[1,"x",null],"b":{"c":true}}'>>,
];

// --- objects -----------------------------------------------------------------
export type Objects = [
  Expect<Equal<Eval<'function(o) { return o.a + o["b"] }', { a: 1; b: 2 }>, 3>>,
  Expect<Equal<Eval<'function() { const o = { x: 1 }; o.y = 2; delete o.x; return o }'>, { y: 2 }>>,
  Expect<Equal<Eval<'function() { return Object.keys({ a: 1, b: 2 }).concat(Object.values({ c: 3 })) }'>, ['a', 'b', 3]>>,
  Expect<Equal<Eval<'function() { return Object.entries({ a: 1 }) }'>, [['a', 1]]>>,
  Expect<Equal<Eval<'function() { const a = { x: 1, y: 2 }; return { ...a, y: 3, z: 4 } }'>, { x: 1; y: 3; z: 4 }>>,
  Expect<Equal<Eval<'function() { const x = 1, y = 2; return { x, y } }'>, { x: 1; y: 2 }>>,
  Expect<Equal<Eval<'function() { const o = { a: { b: { c: 42 } } }; return o.a.b.c + (o.z?.w ?? 0) }'>, 42>>,
  Expect<Equal<Eval<'function() { return "a" in { a: 1 } && !("b" in { a: 1 }) }'>, true>>,
  Expect<Equal<Eval<'function() { const counts = {}; for (const c of "banana") counts[c] = (counts[c] || 0) + 1; return counts }'>, { b: 1; a: 3; n: 2 }>>,
];

// --- Math & numbers ----------------------------------------------------------
export type Numbers = [
  Expect<Equal<Eval<'Math.max(3, 7, 2) + Math.min(4, -1)'>, 6>>,
  Expect<Equal<Eval<'Math.floor(-2.5) + Math.ceil(2.1) + Math.round(2.5) + Math.trunc(-1.7)'>, 2>>,
  Expect<Equal<Eval<'Math.abs(-3) * Math.sign(-8)'>, -3>>,
  Expect<Equal<Eval<'Math.sqrt(2)'>, 1.414213562373095>>,
  Expect<Equal<Eval<'Math.pow(2, 100)'>, 1267650600228229401496703205376n>>,
  Expect<Equal<Eval<'1 / 0'>, number>>,
  Expect<Equal<Eval<'Number.isInteger(5) && !Number.isInteger(5.5) && isNaN("x")'>, true>>,
  Expect<Equal<Eval<'Math.PI.toFixed(4)'>, '3.1416'>>,
];

// --- destructuring & comma operator ------------------------------------------
export type Destructuring = [
  Expect<Equal<Eval<'function() { const [a, , b = 3, ...c] = [1, 2, undefined, 4, 5]; return [a, b, c] }'>, [1, 3, [4, 5]]>>,
  Expect<Equal<Eval<'function() { const { x, y: z = 5, ...rest } = { x: 1, q: 2, w: 3 }; return [x, z, rest] }'>, [1, 5, { q: 2; w: 3 }]>>,
  Expect<Equal<Eval<'function() { let a = 1, b = 2; [a, b] = [b, a]; return [a, b] }'>, [2, 1]>>,
  Expect<Equal<Eval<'({ a, b = 10 }, [c, ...d]) => [a, b, c, d]', { a: 1 }, [1, 2, 3]>, [1, 10, 1, [2, 3]]>>,
  Expect<Equal<Eval<'function(o) { const out = []; for (const [k, v] of Object.entries(o)) out.push(k + "=" + v); return out.join("&") }', { a: 1, b: 2 }>, 'a=1&b=2'>>,
  Expect<Equal<Eval<'function() { const [[a, b], { c: [d] }] = [[1, 2], { c: [3] }]; return a + b + d }'>, 6>>,
  Expect<Equal<Eval<'function() { let s = 0; for (let i = 0, j = 10; i < j; i++, j--) s += j - i; return s }'>, 30>>,
  Expect<Equal<Eval<'function() { const o = { p: 0 }; [o.p, o.q] = [7, 8]; return o }'>, { p: 7; q: 8 }>>,
];

// --- console.log -------------------------------------------------------------
export type Logging = [
  Expect<Equal<Logs<'function() { console.log("start"); for (let i = 0; i < 3; i++) console.log("i =", i) }'>,
    [['start'], ['i =', 0], ['i =', 1], ['i =', 2]]>>,
  Expect<Equal<Logs<'function(o) { console.log(o, [o.a]) }', [{ a: 1 }]>, [[{ a: 1 }, [1]]]>>,
];

// --- argument passing ---------------------------------------------------------
export type Args = [
  Expect<Equal<EvalWith<'(a, b, c) => [c, b, a]', [1, 'two', true]>, [true, 'two', 1]>>,
  Expect<Equal<Eval<'(xs) => xs.map(x => x.name)', [{ name: 'a' }, { name: 'b' }]>, ['a', 'b']>>,
  Expect<Equal<Eval<'(n) => n * 2', 123456789012345678901234567890n>, 246913578024691357802469135780n>>,
];
