/**
 * Heavier programs, all evaluated by the TypeScript checker.
 * Run with `npm run examples` (no output means every assertion holds).
 */
import type { Eval, EvalWith, Start, Resume, Result, IsDone } from '../src/index';
import type { Expect, Equal } from '../test/helpers';

// --- an interpreter inside the interpreter -----------------------------------
type Brainfuck = `function(code, input) {
  const tape = [0], out = [], jump = {}, stack = [];
  let ptr = 0, ip = 0, inp = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "[") stack.push(i);
    else if (code[i] === "]") { const j = stack.pop(); jump[i] = j; jump[j] = i; }
  }
  while (ip < code.length) {
    switch (code[ip]) {
      case ">": ptr++; if (tape[ptr] === undefined) tape[ptr] = 0; break;
      case "<": ptr--; break;
      case "+": tape[ptr] = (tape[ptr] + 1) % 256; break;
      case "-": tape[ptr] = (tape[ptr] + 255) % 256; break;
      case ".": out.push(String.fromCharCode(tape[ptr])); break;
      case ",": tape[ptr] = inp < input.length ? input.charCodeAt(inp++) : 0; break;
      case "[": if (tape[ptr] === 0) ip = jump[ip]; break;
      case "]": if (tape[ptr] !== 0) ip = jump[ip]; break;
    }
    ip++;
  }
  return out.join("");
}`;

export type BrainfuckTests = [
  Expect<Equal<Eval<Brainfuck, ',[.,]', 'Hi!'>, 'Hi!'>>,
  Expect<Equal<Eval<Brainfuck, '++++++++[>++++++++<-]>+.+.+.', ''>, 'ABC'>>,
];

// --- classic algorithms ---------------------------------------------------------
type QuickSort = `function qs(xs) {
  if (xs.length <= 1) return xs;
  const [pivot, ...rest] = xs;
  return [...qs(rest.filter(x => x < pivot)), pivot, ...qs(rest.filter(x => x >= pivot))];
}`;

type InsertionSort = `function(a) {
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > x) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
  return a;
}`;

type BinarySearch = `function(xs, target) {
  let lo = 0, hi = xs.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] === target) return mid;
    if (xs[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}`;

type NQueens = `function(n) {
  let count = 0;
  const cols = [];
  function safe(row, col) {
    for (let r = 0; r < row; r++) {
      const c = cols[r];
      if (c === col || Math.abs(c - col) === row - r) return false;
    }
    return true;
  }
  function place(row) {
    if (row === n) { count++; return; }
    for (let col = 0; col < n; col++) {
      if (safe(row, col)) { cols[row] = col; place(row + 1); }
    }
  }
  place(0);
  return count;
}`;

type Roman = `function(n) {
  const table = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
                 [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [value, numeral] of table) {
    while (n >= value) { out += numeral; n -= value; }
  }
  return out;
}`;

type MatMul = `(a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, x, k) => sum + x * b[k][j], 0)))`;

type WordFreq = `function(text) {
  const freq = {};
  for (const w of text.toLowerCase().split(" ")) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2);
}`;

type MemoFib = `function(n) {
  const memo = {};
  const fib = k => k < 2 ? k : memo[k] ?? (memo[k] = fib(k - 1) + fib(k - 2));
  return fib(n);
}`;

type Collatz = `function(n) { let steps = 0; while (n !== 1) { n = n % 2 ? 3 * n + 1 : n / 2; steps++; } return steps }`;

type Gcd = `function gcd(a, b) { return b === 0 ? a : gcd(b, a % b) }`;

export type Algorithms = [
  Expect<Equal<Eval<QuickSort, [5, 3, 8, 1, 9, 2, 7]>, [1, 2, 3, 5, 7, 8, 9]>>,
  Expect<Equal<Eval<InsertionSort, [9, 4, 7, 1, 8, 2]>, [1, 2, 4, 7, 8, 9]>>,
  Expect<Equal<EvalWith<BinarySearch, [[1, 3, 5, 7, 9, 11, 13, 15], 11]>, 5>>,
  Expect<Equal<Eval<NQueens, 5>, 10>>,
  Expect<Equal<Eval<Roman, 1994>, 'MCMXCIV'>>,
  Expect<Equal<EvalWith<MatMul, [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]>, [[19, 22], [43, 50]]>>,
  Expect<Equal<Eval<WordFreq, 'the cat and the hat and the bat'>, [['the', 3], ['and', 2]]>>,
  Expect<Equal<Eval<MemoFib, 90>, 2880067194370816120n>>,
  Expect<Equal<Eval<Collatz, 27>, 111>>,
  Expect<Equal<Eval<Gcd, 1071, 462>, 21>>,
];

// --- arbitrary precision -----------------------------------------------------------
export type BigNumbers = [
  Expect<Equal<Eval<'function f(n) { return n <= 1 ? 1 : n * f(n - 1) }', 30>, 265252859812191058636308480000000n>>,
  Expect<Equal<Eval<'2 ** 200 % 1000007'>, 446616>>,
];

// --- beyond the per-declaration budget: resumable evaluation -------------------------
// fib(18) makes 8,361 calls (~140k machine steps): too much for one declaration,
// so it is spread over several, each with a fresh instantiation budget.
type Fib = 'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }';
type F1 = Start<Fib, [18]>;
type F2 = Resume<F1>;
type F3 = Resume<F2>;
type F4 = Resume<F3>;
type F5 = Resume<F4>;
type F6 = Resume<F5>;
type F7 = Resume<F6>;
type F8 = Resume<F7>;
export type Resumable = [
  Expect<Equal<IsDone<F4>, false>>,
  Expect<Equal<IsDone<F8>, true>>,
  Expect<Equal<Result<F8>, 2584>>,
];
