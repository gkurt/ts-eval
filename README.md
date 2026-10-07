# ts-eval

A JavaScript interpreter written entirely in TypeScript's type system. No runtime code: the type checker lexes, parses and executes the program, and the result is a type.

```ts
import type { Eval } from './src';

type A = Eval<'function(a,b) { return a + b; }', 5, 3>;   // 8

type B = Eval<`function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}`, 14>;                                                    // 377

type C = Eval<`(words) => {
  const freq = {};
  for (const w of words.split(" ")) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
}`, 'the cat and the hat'>;                                 // ["the", 2]
```

`examples/showcase.ts` runs a Brainf\*ck interpreter (written in JavaScript) inside the type checker. There's also an N-Queens solver, quicksort, Roman numerals, matrix multiplication, 30! with exact digits, and a resumable `fib(18)` that makes 8,361 recursive calls.

Everything works with both `tsc` (TypeScript 7) and [`bun check`](https://bun.com/docs/runtime/check), and is tested with both (see [Checkers](#checkers-tsc-and-bun-check)).

## Compile-time validators

The most practical use: write a check in plain JavaScript and run it on literal values where they appear in the code. A hand-written type-level parser for the same rules would be far longer.

[`examples/cron.ts`](examples/cron.ts) validates a string argument where the function is called:

```ts
schedule('0 9-17 * * 1-5', job);   // ok
schedule('0 24 * * *', job);
// error: … not assignable to '"0 24 * * *" & { "invalid cron": "hour: '24' is outside 0-23" }'
```

[`examples/state-machine.ts`](examples/state-machine.ts) checks a config object's structure: every transition target exists, and every state is reachable (a breadth-first search):

```ts
export const broken = machine({
  initial: 'cart',
  states: { cart: { on: { checkout: 'payment' } }, payment: { on: { paid: 'shipped' } }, shipped: {}, refunded: {} },
});
// error: … & "state 'refunded' is unreachable from 'cart'"
```

The pattern is a generic parameter intersected with the check's result:

```ts
type Valid<S extends string> =
  string extends S ? S                                   // only known at runtime: check it then
  : Eval<Check, S> extends infer R ? (R extends true ? S : { 'invalid cron': R }) : never;
declare function schedule<const S extends string>(expr: S & Valid<S>, job: () => void): void;
```

The message is wrapped in an object type because intersecting a string with a different string literal collapses to `never`, which would lose the message. Each check must fit the per-declaration budget (see below), so this suits small inputs: format strings, config tables, route patterns.

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
3. **5M instantiations per declaration.** This is the real ceiling: about 2,000 loop iterations or `fib(15)` per `Eval`. `bun check` stops at about half of that (see [Checkers](#checkers-tsc-and-bun-check)).

Two discoveries mattered most.

- **Object types are never treated as concrete.** The checker re-instantiates object-literal and mapped types on every pass, nesting one level deeper per update. So a mapped-type environment overflowed the depth limit after about 40 assignments. The entire machine state is therefore tuples: values (`['#', '42']`, `['&', addr]`, `['fn', node, env]`), the environment, the heap and the parser registers. Concrete tuples are skipped.
- **Some tuples are secretly lazy.** A tuple type is created as a *deferred type reference* when it is the direct body of a generic alias (`type NumV<D> = ['#', D]`), or when one of its elements refers to another alias (`['fn', X, Bind<…>]`). Deferred references always count as possibly generic. One of them anywhere in a cons-list (token stream, call stack) makes every operation walk the whole list, which capped programs at about 100 tokens. Persistent tuples are therefore always built from `infer`red parts, and `npm run lint` uses the TS 5 compiler API to flag violations.

### Going past the budget

Each type alias declaration gets its own budget. `Start` and `Resume` exploit that by running one slice (~18k machine steps, ~1.5M instantiations) per declaration, so there is no overall limit. Slices are sized to fit both checkers' budgets:

```ts
type S1 = Start<'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }', [18]>;
type S2 = Resume<S1>;
// ... nine more
type S11 = Resume<S10>;
type R = Result<S11>;   // 2584
```

## Checkers: tsc and bun check

Both are supported and tested. `bun check` is Bun's TypeScript checker. It tracks TypeScript 7, reports the same errors and uses the same `tsconfig.json`. It currently ships only in Bun's canary build, which is pinned as a dev dependency, so nothing needs installing globally.

```bash
npm test               # tsc
npm run test:bun       # bun check
npm run test:all       # tests and examples, with both
npm run bench          # benchmark both (writes bench/RESULTS.md)
```

The one difference that matters here: **`bun check` runs out of budget for one declaration at about 2.6M instantiations (as tsc counts them), about half of tsc's 5M.** A single `Eval` fits about 950 loop iterations or `fib(14)` under `bun check`, compared with about 2,000 and `fib(15)` under tsc. Past that it reports error TS2589 ("Type instantiation is excessively deep"), and it does so quickly. Everything in this repo stays under the lower limit, using `Start`/`Resume` where needed. Your editor runs tsc, so code close to the limit can pass in the editor and fail under `bun check`. Keep single evaluations under ~2M instantiations if you use both (`npm run test:stats` prints the count).

## Numbers

From [`bench/RESULTS.md`](bench/RESULTS.md) (i9-12900K, Windows, median of 3 runs, wall time including startup):

| Case | Instantiations | tsc 7.0.2 | bun check |
|---|---|---|---|
| Test suite (~160 assertions) | 7.0M | 2.3 s | 0.9 s |
| Examples (Brainf\*ck, N-Queens, validators, resumable `fib(18)`, …) | 23.8M | 6.4 s | 4.7 s |
| `fib(14)`: 1,219 calls | 2.4M | 0.59 s | 0.42 s |
| `fib(15)`: 1,973 calls | 3.7M | 0.84 s | out of budget |
| `for` loop, 500 iterations | 1.4M | 0.82 s | 0.33 s |
| `for` loop, 2,000 iterations | 5.5M | 3.1 s | out of budget |

`bun check` is 1.4–2.6× faster. A single evaluation is one declaration, so it can't be split across threads; the examples gain least because their resumable chains run one after another.

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
bench/         checkers.cjs: tsc vs bun check (npm run bench)
               micro.cjs: instantiation-count micro benchmarks (npm run bench:micro -- "<type expr using I>")
```

```bash
npm install
npm test            # type-check = run the tests; no output means everything passed
npm run test:bun    # the same with bun check
npm run examples
npm run lint
```

`npm install` runs Bun's install script, which copies in the platform binary. It's approved in `package.json` (`allowScripts`), which npm 12 requires.
