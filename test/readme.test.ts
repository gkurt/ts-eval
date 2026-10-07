// The examples from README.md.
import type { Eval } from '../src/index';
import type { Expect, Equal } from './helpers';

type A = Eval<'function(a,b) { return a + b; }', 5, 3>;
type B = Eval<`function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}`, 15>;
type C = Eval<`(words) => {
  const freq = {};
  for (const w of words.split(" ")) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
}`, 'the cat and the hat'>;

export type Readme = [
  Expect<Equal<A, 8>>,
  Expect<Equal<B, 610>>,
  Expect<Equal<C, ['the', 2]>>,
];
