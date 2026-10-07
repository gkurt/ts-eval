# ts-eval

A JavaScript interpreter written entirely in TypeScript's type system. No runtime code: the type checker lexes, parses and executes the program, and the result is a type.

```ts
import type { Eval } from './src';

type A = Eval<'function(a,b) { return a + b; }', 5, 3>;   // 8

type B = Eval<`function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}`, 15>;                                                    // 610

type C = Eval<`(words) => {
  const freq = {};
  for (const w of words.split(" ")) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
}`, 'the cat and the hat'>;                                 // ["the", 2]
```

`examples/showcase.ts` runs a Brainf\*ck interpreter (written in JavaScript) inside the type checker. There's also an N-Queens solver, quicksort, Roman numerals, matrix multiplication, 30! with exact digits, and a resumable `fib(18)` that makes 8,361 recursive calls.

## API

| Type | Result |
|---|---|
| `Eval<Src, ...args>` | Evaluates `Src`. If it is a function, calls it with up to 8 arguments. |
| `EvalWith<Src, [args]>` | Same, with the arguments given as a tuple. |
| `Logs<Src, [args]>` | Every `console.log` call, as a tuple of argument tuples. |
| `Run<Src, [args]>` | `{ result, logs }` |
| `Start` / `Resume` / `Result` / `IsDone` | Resumable evaluation for long computations (see [below](#going-past-the-budget)). |
| `EvalError<msg>` | What you get for syntax errors and uncaught exceptions, e.g. `EvalError<"Uncaught TypeError: x is not a function">`. |

Arguments are TypeScript literal types: numbers, bigints, strings, booleans, `null`, `undefined`, tuples and object types, nested in any way. Results are converted back the same way. Integers too large for a `number` literal come back as `bigint` literals, because arithmetic is exact.

## Language support

- **Functions**: declarations (hoisted), expressions, arrows, closures with real shared mutable state, recursion, mutual recursion, default and rest parameters, `this` in methods, `new` with constructor functions.
- **Statements**: `var`/`let`/`const` with proper scoping and hoisting, `if`, `for`, `for...of`, `for...in`, `while`, `do...while`, `switch` with fall-through, `break`, `continue`, `return`, `throw`, `try`/`catch`/`finally`. `for (let ...)` creates a fresh binding per iteration, as in JS.
- **Destructuring**: array and object patterns, nested, with defaults and rest, in declarations, parameters, `for...of`, and assignments (`[a, b] = [b, a]`).
- **Operators**: arithmetic, `**`, comparison (strings compare by char code), `==`/`===` with JS coercions, logical operators, `??`, `?.`, ternary, comma, all compound assignments including `&&=`, `||=` and `??=`, `++`/`--`, `typeof`, `delete`, `in`, `instanceof`, and 32-bit bitwise operators.
- **Values**: numbers, strings, template literals with `${}`, booleans, `null`/`undefined`, arrays and objects as mutable heap references (aliasing works), spread in arrays, calls and objects.
- **Builtins**:
  - `Math.*`: floor, ceil, round, trunc, abs, sign, sqrt, pow, max, min, hypot, PI, E
  - `String`, `Number`, `Boolean`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`
  - `Number.isInteger` and friends, `Array.isArray`, `Array.from`, `Array(n)`
  - `Object.keys`/`values`/`entries`/`fromEntries`/`assign`, `JSON.stringify`, `String.fromCharCode`
  - `Error` types, `console.log`
- **Array methods**: push, pop, shift, unshift, slice, splice, concat, join, indexOf, lastIndexOf, includes, reverse, fill, flat, at, map, filter, reduce, forEach, some, every, find, findIndex, flatMap, sort (with or without a comparator).
- **String methods**: length, indexing, charAt, charCodeAt, at, indexOf, lastIndexOf, includes, startsWith, endsWith, slice, substring, toUpperCase, toLowerCase, trim (all three), split, repeat, concat, replace, replaceAll, padStart, padEnd.

**Not supported**: classes, getters/setters, generators/async, regular expressions, labels, `Map`/`Set`/`Date`, `arguments`, `Math.random`.

**Numbers are exact decimals**, not IEEE doubles:
- `0.1 + 0.2` is `0.3`.
- `2 ** 100` is exact.
- Non-terminating division is truncated to 16 significant digits, so `1/3` is `0.3333333333333333`.
- `NaN` and `±Infinity` exist, but print as `number`.

## How it works

```
source ──Lex──▶ tokens ──Parse──▶ AST ──Execute──▶ machine state ──Outcome──▶ TS type
```

- **Lexer** (`src/lexer.ts`): template-literal pattern matching, one token per step. Template literals are desugared on the fly into string concatenation.
- **Parser** (`src/parser.ts`): a continuation-passing state machine, not recursive descent. Each step is a flat transition `[mode, tokens, frames, registers] → …`, with Pratt-style precedence climbing for expressions. While parsing it also does scope analysis: it records which variables nested closures capture, and desugars destructuring into plain declarations.
- **Evaluator** (`src/machine.ts`): a CEK-style abstract machine. State is `[mode, control, env, continuation, store]`. Every step is a constant-depth type instantiation, so nothing recurses on the structure of the program. That's what lets recursion thousands of calls deep run inside the checker.
- **Variables**: stored directly in the immutable environment. Only variables captured by a closure get a heap cell, which keeps closures correct and everything else cheap.
- **Numbers** (`src/num.ts`): arbitrary-precision decimal strings. Add, subtract, multiply, long division, sqrt, pow and 32-bit bitwise ops are all built from 10×10 digit tables. Integers take fast paths.

## Pushing against the checker's limits

The TypeScript checker has three hard limits. Most of the engineering went into working around them, and finding a few non-obvious costs along the way.

1. **Instantiation depth (100).** Non-tail recursion dies quickly. Everything here is tail-recursive state machines instead.
2. **Tail recursion (1000 iterations per conditional type).** Every driver runs in fuel-bounded chunks (300 steps), and an outer loop re-enters it. Fuel is counted with a successor table: `Nx[F]` is `F + 1`. The obvious `[...F, 0]` copies the whole tuple each step, so it costs O(n) per iteration and made the lexer 5× slower.
3. **5M instantiations per declaration.** This is the real ceiling: about 2,000 loop iterations or `fib(15)` per `Eval`.

Two discoveries mattered most.

- **Object types are never treated as concrete.** The checker re-instantiates object-literal and mapped types on every pass, nesting one level deeper per update. So a mapped-type environment overflowed the depth limit after about 40 assignments. The entire machine state is therefore tuples: values (`['#', '42']`, `['&', addr]`, `['fn', node, env]`), the environment, the heap and the parser registers. Concrete tuples are skipped.
- **Some tuples are secretly lazy.** A tuple type is created as a *deferred type reference* when it is the direct body of a generic alias (`type NumV<D> = ['#', D]`), or when one of its elements refers to another alias (`['fn', X, Bind<…>]`). Deferred references always count as possibly generic. One of them anywhere in a cons-list (token stream, call stack) makes every operation walk the whole list, which capped programs at about 100 tokens. Persistent tuples are therefore always built from `infer`red parts, and `npm run lint` uses the TS 5 compiler API to flag violations.

### Going past the budget

Each type alias declaration gets its own 5M budget. `Start` and `Resume` exploit that by running one slice (~30k machine steps) per declaration, so there is no overall limit:

```ts
type S1 = Start<'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }', [18]>;
type S2 = Resume<S1>;
// ... six more
type S8 = Resume<S7>;
type R = Result<S8>;   // 2584
```

## Numbers

Measured on TypeScript 7.0.2 (native), checking times:

| Program | Time |
|---|---|
| test suite (~160 assertions) | ~6 s |
| `fib(15)`: 1,973 calls | 2 s |
| `for` loop summing 2,000 numbers | 7 s |
| `examples/showcase.ts` (Brainf\*ck, N-Queens 5, …, resumable fib(18)) | ~15–25 s |

## Project layout

```
src/
  index.ts     public API
  lexer.ts     tokens
  parser.ts    CPS parser + scope analysis + destructuring desugaring
  machine.ts   abstract machine, calls, array/object builtins, drivers
  runtime.ts   value model, store, environments, coercions, operators, property access
  builtins.ts  Math, String/Number methods, globals, JSON.stringify
  num.ts       arbitrary-precision decimal arithmetic
  util.ts      tuple/string helpers
test/          type-level assertions (npm test)
examples/      heavier programs (npm run examples)
scripts/       find-deferred.cjs: lint for deferred tuple types (npm run lint)
bench/         micro.cjs: instantiation-count micro benchmarks (npm run bench -- "<type expr using I>")
```

```bash
npm install
npm test            # type-check = run the tests; no output means everything passed
npm run examples
npm run lint
```
