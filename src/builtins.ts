/**
 * Pure builtins: Math, String.prototype, Number.prototype, global functions,
 * JSON.stringify. Builtins that call back into user code (Array.prototype.map,
 * sort, ...) live in machine.ts because they need to push continuation frames.
 *
 * A builtin result is either a plain value, ['!vw', value, newStore], or a
 * throw marker ['!throw', name, message].
 */
import type { NAbs, NCeil, NCmp, NFloor, NIsInt, NMax, NMin, NPow, NRound, NSign, NSqrt, NToFixed, NTrunc, NHalf, Canon, Digit, TrimZ, NNeg } from './num';
import type {
  AllocArr, CharCode, ClampIdx, FromCharCode, IndexOfStr, IsNegS, LastIndexOfStr, NumV, PadStr, RelIdx, RepeatStr, ReplaceAll,
  SplitStr, StrCmp, Throw, ToInt, ToNum, ToStr, Trim, TrimEnd, TrimStart, Truthy, HGet, Lt, NSubN,
} from './runtime';
import type { At, Chars, InRange, Join, Slice, StrLen } from './util';

export type Arg0<Args> = Args extends [infer A, ...any[]] ? A : undefined;
export type Arg1<Args> = Args extends [any, infer A, ...any[]] ? A : undefined;
export type Arg2<Args> = Args extends [any, any, infer A, ...any[]] ? A : undefined;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

type Fold<Args, W, Acc, Op> = Args extends [infer H, ...infer R]
  ? Fold<R, W, Op extends 'max' ? NMax<Acc, ToNum<H, W>> : NMin<Acc, ToNum<H, W>>, Op>
  : Acc;

export type MathCall<Fn, Args, W> =
  ToNum<Arg0<Args>, W> extends infer X
    ? Fn extends 'floor' ? NumV<NFloor<X>>
      : Fn extends 'ceil' ? NumV<NCeil<X>>
        : Fn extends 'round' ? NumV<NRound<X>>
          : Fn extends 'trunc' ? NumV<NTrunc<X>>
            : Fn extends 'abs' ? NumV<X extends 'NaN' ? 'NaN' : NAbs<X>>
              : Fn extends 'sign' ? NumV<NSign<X>>
                : Fn extends 'sqrt' ? NumV<NSqrt<X>>
                  : Fn extends 'pow' ? NumV<NPow<X, ToNum<Arg1<Args>, W>>>
                    : Fn extends 'max' ? NumV<Fold<Args, W, '-Infinity', 'max'>>
                      : Fn extends 'min' ? NumV<Fold<Args, W, 'Infinity', 'min'>>
                        : Fn extends 'hypot' ? NumV<NSqrt<Fold2<Args, W>>>
                          : Throw<'TypeError', `Math.${Fn & string} is not a function`>
    : never;
type Fold2<Args, W, Acc = '0'> = Args extends [infer H, ...infer R]
  ? ToNum<H, W> extends infer N ? Fold2<R, W, import('./num').NAdd<Acc, import('./num').NMul<N, N>>> : never
  : Acc;

// ---------------------------------------------------------------------------
// Global functions
// ---------------------------------------------------------------------------

type LeadDigits<S, Acc extends string = ''> = S extends `${infer C extends Digit}${infer R}` ? LeadDigits<R, `${Acc}${C}`> : Acc;
type PInt<S> = LeadDigits<S> extends '' ? 'NaN' : TrimZ<LeadDigits<S>>;
export type ParseInt<S> = Trim<S> extends `-${infer R}` ? NNeg<PInt<R>> : Trim<S> extends `+${infer R}` ? PInt<R> : PInt<Trim<S>>;

type LeadFloat<S, Acc extends string = '', Dot = false> =
  S extends `${infer C}${infer R}`
    ? C extends Digit ? LeadFloat<R, `${Acc}${C}`, Dot>
      : C extends '.' ? (Dot extends true ? Acc : LeadFloat<R, `${Acc}.`, true>)
        : Acc
    : Acc;
type PFloat<S> = S extends `Infinity${string}` ? 'Infinity' : LeadFloat<S> extends '' | '.' ? 'NaN' : Canon<LeadFloat<S>>;
export type ParseFloat<S> = Trim<S> extends `-${infer R}` ? NNeg<PFloat<R>> : Trim<S> extends `+${infer R}` ? PFloat<R> : PFloat<Trim<S>>;

// ---------------------------------------------------------------------------
// String.prototype
// ---------------------------------------------------------------------------

type CharAtIdx<S, V, W> = ToNum<V, W> extends infer N ? (V extends undefined ? 0 : NTrunc<N> extends `${infer I extends number}` ? I : -1) : never;

export type StrMethod<M, S extends string, Args, W> =
  StrLen<S> extends infer Len extends number
    ? M extends 'charAt' ? (Chars<S> extends infer Cs extends any[] ? At<Cs, CharAtIdx<S, Arg0<Args>, W>, ''> : never)
      : M extends 'charCodeAt' ? (Chars<S> extends infer Cs extends any[] ? (InRange<Cs, CharAtIdx<S, Arg0<Args>, W>> extends true ? NumV<`${CharCode<At<Cs, CharAtIdx<S, Arg0<Args>, W>>>}`> : NumV<'NaN'>) : never)
        : M extends 'at' ? (Chars<S> extends infer Cs extends any[] ? At<Cs, AtIdx<Arg0<Args>, Len, W>> : never)
          : M extends 'indexOf' ? NumV<`${IndexOfStr<S, ToStr<Arg0<Args>, W>>}`>
            : M extends 'lastIndexOf' ? NumV<`${LastIndexOfStr<S, ToStr<Arg0<Args>, W>>}`>
              : M extends 'includes' ? (S extends `${string}${ToStr<Arg0<Args>, W>}${string}` ? true : false)
                : M extends 'startsWith' ? (S extends `${ToStr<Arg0<Args>, W>}${string}` ? true : false)
                  : M extends 'endsWith' ? (S extends `${string}${ToStr<Arg0<Args>, W>}` ? true : false)
                    : M extends 'slice' ? Join<Slice<Chars<S>, RelIdx<Arg0<Args>, Len, 0, W>, RelIdx<Arg1<Args>, Len, Len, W>>, ''>
                      : M extends 'substring' ? Substring<S, ClampIdx<Arg0<Args>, Len, 0, W>, ClampIdx<Arg1<Args>, Len, Len, W>>
                        : M extends 'toUpperCase' ? Uppercase<S>
                          : M extends 'toLowerCase' ? Lowercase<S>
                            : M extends 'trim' ? Trim<S>
                              : M extends 'trimStart' ? TrimStart<S>
                                : M extends 'trimEnd' ? TrimEnd<S>
                                  : M extends 'split' ? (Arg0<Args> extends undefined ? AllocVW<[S], W> : AllocVW<SplitStr<S, ToStr<Arg0<Args>, W>>, W>)
                                    : M extends 'repeat' ? RepeatStr<S, ToInt<NTrunc<ToNum<Arg0<Args>, W>>>>
                                      : M extends 'concat' ? `${S}${Join<StrList<Args, W>, ''>}`
                                        : M extends 'replace' ? (S extends `${infer P}${ToStr<Arg0<Args>, W>}${infer R}` ? `${P}${ToStr<Arg1<Args>, W>}${R}` : S)
                                          : M extends 'replaceAll' ? ReplaceAll<S, ToStr<Arg0<Args>, W>, ToStr<Arg1<Args>, W>>
                                            : M extends 'padStart' | 'padEnd'
                                              ? PadStr<S, ToInt<NTrunc<ToNum<Arg0<Args>, W>>>, Arg1<Args> extends undefined ? ' ' : ToStr<Arg1<Args>, W>, M extends 'padEnd' ? true : false>
                                              : M extends 'toString' ? S
                                                : Throw<'TypeError', `str.${M & string} is not a function`>
    : never;

type Substring<S, A extends number, B extends number> = Lt<B, A> extends true ? Join<Slice<Chars<S>, B, A>, ''> : Join<Slice<Chars<S>, A, B>, ''>;
type AtIdx<V, Len extends number, W> = NTrunc<ToNum<V, W>> extends infer T
  ? T extends 'NaN' ? 0 : IsNegS<T> extends true ? ToInt<import('./num').NAdd<T, `${Len}`>> : ToInt<T>
  : never;
export type StrList<L, W> = { [I in keyof L]: ToStr<L[I], W> };
type AllocVW<Es, W> = AllocArr<W, Es> extends [infer R, infer W2] ? ['!vw', R, W2] : never;

// ---------------------------------------------------------------------------
// Number.prototype
// ---------------------------------------------------------------------------

type ToBinary<N, Acc extends string = ''> = N extends '0' ? (Acc extends '' ? '0' : Acc) : NHalf<N> extends [infer H, infer B extends string] ? ToBinary<H, `${B}${Acc}`> : never;

export type NumMethod<M, N, Args, W> =
  M extends 'toFixed' ? NToFixed<N, ToInt<NTrunc<ToNum<Arg0<Args>, W>>>>
  : M extends 'toString'
    ? ToNum<Arg0<Args>, W> extends '2' ? (NIsInt<N> extends true ? (IsNegS<N> extends true ? `-${ToBinary<NAbs<N>>}` : ToBinary<N>) : N) : N
    : Throw<'TypeError', `num.${M & string} is not a function`>;

// ---------------------------------------------------------------------------
// JSON.stringify
// ---------------------------------------------------------------------------

type JsonEsc<S, Acc extends string = ''> =
  S extends `${infer C}${infer R}`
    ? JsonEsc<R, `${Acc}${C extends '"' ? '\\"' : C extends '\\' ? '\\\\' : C extends '\n' ? '\\n' : C extends '\t' ? '\\t' : C}`>
    : Acc;
type IsFn<V> = V extends ['fn', any, any] | ['bi', any] | ['bm', any, any] ? true : false;

export type Json<V, W, D extends 0[] = []> =
  V extends string ? `"${JsonEsc<V>}"`
  : V extends ['#', infer N extends string] ? (N extends 'NaN' | 'Infinity' | '-Infinity' ? 'null' : N)
  : V extends true ? 'true' : V extends false ? 'false' : V extends null ? 'null'
  : D['length'] extends 20 ? 'null'
  : V extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es] ? `[${Join<JsonArr<Es, W, [...D, 0]>, ','>}]`
      : HGet<W, A> extends ['O', infer Es] ? `{${Join<JsonObj<Es, W, [...D, 0]>, ','>}}`
        : undefined
    : undefined;
type JsonArr<Es, W, D extends 0[]> = { [I in keyof Es]: Es[I] extends undefined ? 'null' : IsFn<Es[I]> extends true ? 'null' : Json<Es[I], W, D> };
type JsonObj<Es, W, D extends 0[], Acc extends string[] = []> =
  Es extends [[infer K, infer V], ...infer R]
    ? V extends undefined ? JsonObj<R, W, D, Acc>
      : IsFn<V> extends true ? JsonObj<R, W, D, Acc>
        : JsonObj<R, W, D, [...Acc, `"${JsonEsc<K>}":${Json<V, W, D> & string}`]>
    : Acc;

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export type DefaultCmp<A, B, W> =
  A extends undefined ? (B extends undefined ? NumV<'0'> : NumV<'1'>)
  : B extends undefined ? NumV<'-1'>
  : NumV<`${StrCmp<ToStr<A, W>, ToStr<B, W>>}`>;

export type FromCodes<Args, W> = Join<{ [I in keyof Args]: FromCharCode<ToInt<NTrunc<ToNum<Args[I], W>>>> }, ''>;

export type GlobalCall<B, Args, W> =
  B extends 'String' ? (Args extends [] ? '' : ToStr<Arg0<Args>, W>)
  : B extends 'Number' ? (Args extends [] ? NumV<'0'> : NumV<ToNum<Arg0<Args>, W>>)
  : B extends 'Boolean' ? Truthy<Arg0<Args>>
  : B extends 'parseInt' ? NumV<ParseInt<ToStr<Arg0<Args>, W>>>
  : B extends 'parseFloat' ? NumV<ParseFloat<ToStr<Arg0<Args>, W>>>
  : B extends 'isNaN' ? (ToNum<Arg0<Args>, W> extends 'NaN' ? true : false)
  : B extends 'isFinite' ? (ToNum<Arg0<Args>, W> extends 'NaN' | 'Infinity' | '-Infinity' ? false : true)
  : B extends 'Number.isInteger' | 'Number.isSafeInteger' ? (Arg0<Args> extends ['#', infer N] ? NIsInt<N> : false)
  : B extends 'Number.isFinite' ? (Arg0<Args> extends ['#', infer N] ? (N extends 'NaN' | 'Infinity' | '-Infinity' ? false : true) : false)
  : B extends 'Number.isNaN' ? (Arg0<Args> extends ['#', 'NaN'] ? true : false)
  : B extends 'Number.parseInt' ? NumV<ParseInt<ToStr<Arg0<Args>, W>>>
  : B extends 'Number.parseFloat' ? NumV<ParseFloat<ToStr<Arg0<Args>, W>>>
  : B extends 'String.fromCharCode' ? FromCodes<Args, W>
  : B extends 'JSON.stringify' ? Json<Arg0<Args>, W>
  : B extends 'Array.isArray' ? (Arg0<Args> extends ['&', infer A] ? (HGet<W, A> extends ['A', any] ? true : false) : false)
  : B extends '%cmp' ? DefaultCmp<Arg0<Args>, Arg1<Args>, W>
  : B extends `Math.${infer Fn}` ? MathCall<Fn, Args, W>
  : Throw<'TypeError', `${B & string} is not a function`>;

export type { NCmp, NSubN };
