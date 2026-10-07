/**
 * Testing type-level code against real JavaScript behaviour.
 *
 * Hand-written expectations for a type like `Split` tend to share the author's
 * blind spots. Here ts-eval runs JavaScript to produce both the inputs (every
 * string over {"a", ","} up to length 3) and the expected outputs
 * (`s.split(",")`), and every case is checked against the type.
 *
 * Limits: the oracle is ts-eval, not V8 (exact decimals, no regex, Map or Set),
 * and the cases must fit the per-declaration budget: a few dozen per declaration.
 */
import type { Eval } from '../src/index';
import type { Expect, Equal } from '../test/helpers';

/** A typical hand-written split. It mishandles empty input and trailing separators. */
type NaiveSplit<S extends string, D extends string> =
  S extends `${infer H}${D}${infer T}` ? [H, ...NaiveSplit<T, D>] : S extends '' ? [] : [S];

/** The fixed version: the last piece is always kept, even when it is empty. */
type Split<S extends string, D extends string> =
  S extends `${infer H}${D}${infer T}` ? [H, ...Split<T, D>] : [S];

/** `[input, what JavaScript returns]` for every string over {"a", ","} up to length 3. */
type Cases = Eval<`function() {
  let all = [""], frontier = [""];
  for (let len = 1; len <= 3; len++) {
    const next = [];
    for (const s of frontier) for (const c of ["a", ","]) next.push(s + c);
    all = all.concat(next);
    frontier = next;
  }
  return all.map(s => [s, s.split(",")]);
}`>;

/**
 * The cases where `Impl` disagrees with JavaScript, or `never`. The mapping is
 * generic because a mapped type only maps a tuple element by element when the
 * tuple is a type parameter.
 */
type Mismatches<C extends readonly unknown[], Impl extends 'naive' | 'fixed'> = {
  [K in keyof C]: C[K] extends [infer I extends string, infer Js]
    ? (Impl extends 'naive' ? NaiveSplit<I, ','> : Split<I, ','>) extends infer Got
      ? Equal<Got, Js> extends true ? never : { input: I; got: Got; js: Js }
      : never
    : never;
}[number];

export type OracleTests = [
  Expect<Equal<Cases['length'], 15>>,
  // 8 of the 15 inputs expose the naive version's two bugs.
  Expect<Equal<Mismatches<Cases, 'naive'>['input'], '' | ',' | 'a,' | ',,' | 'aa,' | 'a,,' | ',a,' | ',,,'>>,
  Expect<Equal<Extract<Mismatches<Cases, 'naive'>, { input: 'a,' }>, { input: 'a,'; got: ['a']; js: ['a', ''] }>>,
  Expect<Equal<Mismatches<Cases, 'fixed'>, never>>,
];
