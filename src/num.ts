/**
 * Arbitrary-precision decimal arithmetic on string literal types.
 *
 * Every number the interpreter touches is a *canonical decimal string*:
 *   "0", "42", "-7", "3.25", "-0.001"   (no leading/trailing zeros, no "-0")
 * plus the three specials "NaN", "Infinity" and "-Infinity".
 *
 * Integers are exact at any size. Division that does not terminate is
 * truncated to 16 significant digits (close to, but not bit-identical with,
 * IEEE-754 doubles).
 *
 * Internally, unsigned integers are processed as little-endian digit tuples
 * (`['3','2','1']` is 123) using precomputed digit tables, so every
 * operation is a tail-recursive walk over digits.
 */

export type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type Digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
type Bit = '0' | '1';

// ---------------------------------------------------------------------------
// Digit tables (computed once by the checker, then cached)
// ---------------------------------------------------------------------------

type DT = {
  '0': []; '1': [0]; '2': [0, 0]; '3': [0, 0, 0]; '4': [0, 0, 0, 0];
  '5': [0, 0, 0, 0, 0]; '6': [0, 0, 0, 0, 0, 0]; '7': [0, 0, 0, 0, 0, 0, 0];
  '8': [0, 0, 0, 0, 0, 0, 0, 0]; '9': [0, 0, 0, 0, 0, 0, 0, 0, 0];
};

/** [units, tens] for every n in 0..99, indexed by n. */
type Row<D extends Digit[], T extends Digit> = { [I in keyof D]: [D[I], T] };
type Split100 = [
  ...Row<Digits, '0'>, ...Row<Digits, '1'>, ...Row<Digits, '2'>, ...Row<Digits, '3'>, ...Row<Digits, '4'>,
  ...Row<Digits, '5'>, ...Row<Digits, '6'>, ...Row<Digits, '7'>, ...Row<Digits, '8'>, ...Row<Digits, '9'>,
];
type At100<N> = N extends keyof Split100 ? Split100[N] : never;
type Times<A extends 0[], D extends Digit, Acc extends 0[] = [], I extends 0[] = []> =
  I extends DT[D] ? Acc : Times<A, D, [...Acc, ...A], [...I, 0]>;

/** AddTbl[carry][a][b] = [digit, carry'] */
type AddTbl = { [C in Bit]: { [A in Digit]: { [B in Digit]: At100<[...DT[A], ...DT[B], ...DT[C]]['length']> } } };
/** MulTbl[a][b] = [digit, carryDigit] */
type MulTbl = { [A in Digit]: { [B in Digit]: At100<LenOf<Times<DT[A], B>>> } };
type LenOf<T> = T extends { length: infer L } ? L : never;
type Flip = { '0': '1'; '1': '0' };
type Nine = { '0': '9'; '1': '8'; '2': '7'; '3': '6'; '4': '5'; '5': '4'; '6': '3'; '7': '2'; '8': '1'; '9': '0' };
/** SubTbl[borrow][a][b] = [digit, borrow'] — derived from AddTbl via nines' complement. */
type SubTbl = {
  [W in Bit]: { [A in Digit]: { [B in Digit]: AddTbl[Flip[W]][A][Nine[B]] extends [infer D, infer C extends Bit] ? [D, Flip[C]] : never } };
};
/** DLT[a][b] = a < b */
type DLT = { [A in Digit]: { [B in Digit]: '0123456789' extends `${string}${A}${string}${B}${string}` ? true : false } };
type Succ = { '0': '1'; '1': '2'; '2': '3'; '3': '4'; '4': '5'; '5': '6'; '6': '7'; '7': '8'; '8': '9'; '9': 'X' };
type HalfQ0 = { '0': '0'; '1': '0'; '2': '1'; '3': '1'; '4': '2'; '5': '2'; '6': '3'; '7': '3'; '8': '4'; '9': '4' };
type HalfQ1 = { '0': '5'; '1': '5'; '2': '6'; '3': '6'; '4': '7'; '5': '7'; '6': '8'; '7': '8'; '8': '9'; '9': '9' };
type Odd = '1' | '3' | '5' | '7' | '9';

// ---------------------------------------------------------------------------
// Unsigned integer primitives
// ---------------------------------------------------------------------------

type ToLE<S, Acc extends Digit[] = []> = S extends `${infer C extends Digit}${infer R}` ? ToLE<R, [C, ...Acc]> : Acc;
type FromLE<T, Acc extends string = ''> = T extends [infer H extends Digit, ...infer R] ? FromLE<R, `${H}${Acc}`> : Acc;
export type TrimZ<S> = S extends `0${infer R}` ? (R extends '' ? '0' : TrimZ<R>) : S extends '' ? '0' : S;
type H0<T> = T extends [infer H extends Digit, ...any[]] ? H : '0';
type T0<T> = T extends [any, ...infer R] ? R : [];

type AddLE<A, B, C extends Bit = '0', Acc extends Digit[] = []> =
  [A, B] extends [[], []] ? (C extends '1' ? [...Acc, '1'] : Acc)
  : AddTbl[C][H0<A>][H0<B>] extends [infer D extends Digit, infer C2 extends Bit] ? AddLE<T0<A>, T0<B>, C2, [...Acc, D]> : never;

type SubLE<A, B, W extends Bit = '0', Acc extends Digit[] = []> =
  A extends [infer a extends Digit, ...infer AR]
    ? SubTbl[W][a][H0<B>] extends [infer D extends Digit, infer W2 extends Bit] ? SubLE<AR, T0<B>, W2, [...Acc, D]> : never
    : Acc;

type MulD<A, b extends Digit, C extends Digit = '0', Acc extends Digit[] = []> =
  A extends [infer a extends Digit, ...infer AR]
    ? MulTbl[a][b] extends [infer d0 extends Digit, infer c0 extends Digit]
      ? AddTbl['0'][d0][C] extends [infer d extends Digit, infer c1 extends Bit]
        ? MulD<AR, b, AddTbl[c1][c0]['0'] extends [infer c extends Digit, any] ? c : '0', [...Acc, d]>
        : never
      : never
    : C extends '0' ? Acc : [...Acc, C];

type MulLE<A, B, Sh extends Digit[] = [], Acc = []> =
  B extends [infer b extends Digit, ...infer BR]
    ? MulLE<A, BR, ['0', ...Sh], b extends '0' ? Acc : AddLE<Acc, [...Sh, ...MulD<A, b>]>>
    : Acc;

export type AddU<A, B> = FromLE<AddLE<ToLE<A>, ToLE<B>>>;
/** A - B, requires A >= B */
export type SubU<A, B> = TrimZ<FromLE<SubLE<ToLE<A>, ToLE<B>>>>;
export type MulU<A, B> = A extends '0' ? '0' : B extends '0' ? '0' : TrimZ<FromLE<MulLE<ToLE<A>, ToLE<B>>>>;

type LenCmp<A, B> = A extends `${infer _a}${infer AR}`
  ? (B extends `${infer _b}${infer BR}` ? LenCmp<AR, BR> : 1)
  : (B extends '' ? 0 : -1);
type LexCmp<A, B> = A extends `${infer a extends Digit}${infer AR}`
  ? B extends `${infer b extends Digit}${infer BR}`
    ? a extends b ? LexCmp<AR, BR> : DLT[a][b] extends true ? -1 : 1
    : 0
  : 0;
/** Compare canonical unsigned integers: -1 | 0 | 1 */
export type CmpU<A, B> = LenCmp<A, B> extends infer L ? (L extends 0 ? LexCmp<A, B> : L) : never;

type Fit<R, B, Q extends string = '0'> = CmpU<R, B> extends -1 ? [Q, R] : Fit<SubU<R, B>, B, Q extends keyof Succ ? Succ[Q] : 'X'>;
/** [quotient, remainder] of unsigned long division */
export type DivModU<A, B, Q extends string = '', R extends string = '0'> =
  A extends `${infer d extends Digit}${infer AR}`
    ? Fit<R extends '0' ? d : `${R}${d}`, B> extends [infer q extends string, infer R2 extends string] ? DivModU<AR, B, `${Q}${q}`, R2> : never
    : [TrimZ<Q>, R];

/** floor(A / 2) and A mod 2 in a single pass. */
type Half<S, C extends Bit = '0', Acc extends string = ''> =
  S extends `${infer d extends Digit}${infer R}`
    ? Half<R, d extends Odd ? '1' : '0', `${Acc}${C extends '0' ? HalfQ0[d] : HalfQ1[d]}`>
    : [TrimZ<Acc>, C];

// ---------------------------------------------------------------------------
// Signed decimals: [sign, mantissa, scale]   value = sign * mantissa / 10^|scale|
// ---------------------------------------------------------------------------

type Len0<S, Acc extends 0[] = []> = S extends `${infer _}${infer R}` ? Len0<R, [...Acc, 0]> : Acc;
type Parse<S> = S extends `-${infer U}` ? ParseU<U, '-'> : ParseU<S, ''>;
type ParseU<U, Sg> = U extends `${infer I}.${infer F}` ? [Sg, TrimZ<`${I}${F}`>, Len0<F>] : [Sg, U & string, []];

type FmtLE<L, Sc, Fr extends string = ''> =
  Sc extends [any, ...infer ScR]
    ? FmtLE<T0<L>, ScR, Fr extends '' ? (H0<L> extends '0' ? '' : H0<L>) : `${H0<L>}${Fr}`>
    : [TrimZ<FromLE<L>>, Fr];
type Fmt<Sg, M, Sc> =
  FmtLE<ToLE<M>, Sc> extends [infer I extends string, infer F extends string]
    ? (F extends '' ? I : `${I}.${F}`) extends infer R extends string
      ? R extends '0' ? '0' : `${Sg & string}${R}`
      : never
    : never;

type PadZ<M, D> = M extends '0' ? '0' : D extends [any, ...infer R] ? PadZ<`${M & string}0`, R> : M;
/** Bring two decimals to a common scale: [mantA, mantB, scale] */
type Align<A, B> = A extends [any, infer MA, infer SA extends any[]]
  ? B extends [any, infer MB, infer SB extends any[]]
    ? SA extends [...SB, ...infer D] ? [MA, PadZ<MB, D>, SA]
      : SB extends [...SA, ...infer D] ? [PadZ<MA, D>, MB, SB]
      : never
    : never
  : never;

type AddD<A, B> = A extends [infer SA, any, any] ? B extends [infer SB, any, any]
  ? Align<A, B> extends [infer MA, infer MB, infer Sc]
    ? SA extends SB ? Fmt<SA, AddU<MA, MB>, Sc>
      : CmpU<MA, MB> extends -1 ? Fmt<SB, SubU<MB, MA>, Sc> : Fmt<SA, SubU<MA, MB>, Sc>
    : never
  : never : never;

type XorSign<A, B> = A extends B ? '' : '-';

type Tup16 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
type DivFrac<R, B, F extends string, Sig extends any[], Sc extends any[]> =
  R extends '0' ? [F, Sc]
  : Sig extends [...Tup16, ...any[]] ? [F, Sc]
  : Fit<`${R & string}0`, B> extends [infer q extends string, infer R2]
    ? DivFrac<R2, B, `${F}${q}`, Sig extends [] ? (q extends '0' ? [] : [0]) : [...Sig, 0], [...Sc, 0]>
    : never;

type DivD<A, B> = A extends [infer SA, any, any] ? B extends [infer SB, any, any]
  ? Align<A, B> extends [infer MA, infer MB, any]
    ? DivModU<MA, MB> extends [infer Q extends string, infer R]
      ? DivFrac<R, MB, '', Q extends '0' ? [] : Len0<Q>, []> extends [infer F extends string, infer Sc]
        ? Fmt<XorSign<SA, SB>, TrimZ<`${Q}${F}`>, Sc>
        : never
      : never
    : never
  : never : never;

type ModD<A, B> = A extends [infer SA, any, any]
  ? Align<A, B> extends [infer MA, infer MB, infer Sc] ? Fmt<SA, DivModU<MA, MB>[1], Sc> : never
  : never;

type CmpMag<A, B> = Align<A, B> extends [infer MA, infer MB, any] ? CmpU<MA, MB> : never;
type NegC<C> = C extends 1 ? -1 : C extends -1 ? 1 : 0;
type CmpD<A, B> = A extends ['-', any, any]
  ? (B extends ['-', any, any] ? NegC<CmpMag<A, B>> : -1)
  : (B extends ['-', any, any] ? 1 : CmpMag<A, B>);

// ---------------------------------------------------------------------------
// Public API on canonical strings (handles NaN / ±Infinity)
// ---------------------------------------------------------------------------

type Inf = 'Infinity' | '-Infinity';
type NonFinite = 'NaN' | Inf;

export type NNeg<A> = A extends 'NaN' | '0' ? A : A extends `-${infer U}` ? U : `-${A & string}`;
export type NAbs<A> = A extends `-${infer U}` ? U : A;
type IsNeg<A> = A extends `-${string}` ? true : false;

// Integer fast paths. Loop counters and sums are overwhelmingly small
// integers; skipping the decimal Parse/Align/Fmt round trip (and using string
// increment/decrement for +-1) makes them several times cheaper.
type UInt<A> = A extends `-${string}` | `${string}.${string}` | NonFinite ? false : true;
/** Decimal string increment / decrement (non-negative integers). */
export type IncU<S> =
  S extends `${infer P}9` ? `${P extends '' ? '1' : IncU<P>}0`
  : S extends `${infer P}0` ? `${P}1` : S extends `${infer P}1` ? `${P}2` : S extends `${infer P}2` ? `${P}3`
  : S extends `${infer P}3` ? `${P}4` : S extends `${infer P}4` ? `${P}5` : S extends `${infer P}5` ? `${P}6`
  : S extends `${infer P}6` ? `${P}7` : S extends `${infer P}7` ? `${P}8` : S extends `${infer P}8` ? `${P}9` : '1';
type DecU<S> =
  S extends `${infer P}0` ? `${P extends '1' ? '' : DecU<P>}9`
  : S extends `${infer P}1` ? `${P}0` extends '0' ? '0' : `${P}0` : S extends `${infer P}2` ? `${P}1` : S extends `${infer P}3` ? `${P}2`
  : S extends `${infer P}4` ? `${P}3` : S extends `${infer P}5` ? `${P}4` : S extends `${infer P}6` ? `${P}5`
  : S extends `${infer P}7` ? `${P}6` : S extends `${infer P}8` ? `${P}7` : S extends `${infer P}9` ? `${P}8` : never;
/** a - b for non-negative integers, any order */
type SubInt<A, B> = CmpU<A, B> extends -1 ? `-${SubU<B, A>}` : SubU<A, B>;
type AddInt<A, B> =
  B extends '1' ? IncU<A> : A extends '1' ? IncU<B> : AddU<A, B>;

export type NAdd<A, B> =
  A extends 'NaN' ? 'NaN' : B extends 'NaN' ? 'NaN'
  : A extends Inf ? (B extends Inf ? (A extends B ? A : 'NaN') : A)
  : B extends Inf ? B
  : A extends '0' ? B : B extends '0' ? A
  : [UInt<A>, UInt<B>] extends [true, true] ? AddInt<A, B>
  : AddD<Parse<A>, Parse<B>>;

export type NSub<A, B> =
  [UInt<A>, UInt<B>] extends [true, true]
    ? (B extends '0' ? A : B extends '1' ? (A extends '0' ? '-1' : DecU<A>) : A extends B ? '0' : SubInt<A, B>)
    : NAdd<A, NNeg<B>>;

export type NMul<A, B> =
  A extends 'NaN' ? 'NaN' : B extends 'NaN' ? 'NaN'
  : A extends Inf ? (B extends '0' ? 'NaN' : IsNeg<A> extends IsNeg<B> ? 'Infinity' : '-Infinity')
  : B extends Inf ? (A extends '0' ? 'NaN' : IsNeg<A> extends IsNeg<B> ? 'Infinity' : '-Infinity')
  : Parse<A> extends [infer SA, infer MA, infer CA extends any[]]
    ? Parse<B> extends [infer SB, infer MB, infer CB extends any[]] ? Fmt<XorSign<SA, SB>, MulU<MA, MB>, [...CA, ...CB]> : never
    : never;

export type NDiv<A, B> =
  A extends 'NaN' ? 'NaN' : B extends 'NaN' ? 'NaN'
  : A extends Inf ? (B extends Inf ? 'NaN' : IsNeg<A> extends IsNeg<B> ? 'Infinity' : '-Infinity')
  : B extends Inf ? '0'
  : B extends '0' ? (A extends '0' ? 'NaN' : IsNeg<A> extends true ? '-Infinity' : 'Infinity')
  : A extends '0' ? '0'
  : DivD<Parse<A>, Parse<B>>;

/** JavaScript `%` (sign follows the dividend). */
export type NMod<A, B> =
  A extends NonFinite ? 'NaN' : B extends 'NaN' | '0' ? 'NaN' : B extends Inf ? A
  : ModD<Parse<A>, Parse<B>>;

/** -1 | 0 | 1, or 'nan' when either side is NaN. */
export type NCmp<A, B> =
  A extends 'NaN' ? 'nan' : B extends 'NaN' ? 'nan'
  : A extends B ? 0
  : A extends '-Infinity' ? -1 : A extends 'Infinity' ? 1
  : B extends '-Infinity' ? 1 : B extends 'Infinity' ? -1
  : [UInt<A>, UInt<B>] extends [true, true] ? CmpU<A, B>
  : CmpD<Parse<A>, Parse<B>>;

export type NIsInt<A> = A extends NonFinite ? false : A extends `${string}.${string}` ? false : true;
export type NTrunc<A> = A extends NonFinite ? A : A extends `${infer I}.${string}` ? (I extends '-0' ? '0' : I) : A;
export type NFloor<A> = A extends NonFinite ? A : A extends `-${string}.${string}` ? NSub<NTrunc<A>, '1'> : NTrunc<A>;
export type NCeil<A> = A extends NonFinite ? A : A extends `-${string}` ? NTrunc<A> : A extends `${string}.${string}` ? NAdd<NTrunc<A>, '1'> : A;
/** Math.round: half rounds toward +Infinity. */
export type NRound<A> = A extends NonFinite ? A : NIsInt<A> extends true ? A : NFloor<NAdd<A, '0.5'>>;
export type NSign<A> = A extends 'NaN' ? 'NaN' : A extends '0' ? '0' : A extends `-${string}` ? '-1' : '1';

export type NHalf<A> = Half<A>;

type PowLoop<B, E, Acc> =
  E extends '0' ? Acc
  : Half<E> extends [infer H, infer O]
    ? H extends '0'
      ? (O extends '1' ? NMul<Acc, B> : Acc)
      : PowLoop<NMul<B, B>, H, O extends '1' ? NMul<Acc, B> : Acc>
    : never;

export type NPow<A, B> =
  B extends '0' ? '1'
  : A extends 'NaN' ? 'NaN' : B extends 'NaN' ? 'NaN'
  : B extends Inf ? 'NaN'
  : B extends '0.5' ? NSqrt<A>
  : NIsInt<B> extends false ? 'NaN'
  : B extends `-${infer P}` ? NDiv<'1', NPow<A, P>>
  : A extends Inf ? (IsNeg<A> extends true ? (Half<B>[1] extends '1' ? '-Infinity' : 'Infinity') : 'Infinity')
  : PowLoop<A, B, '1'>;

/** Keep at most 16 significant digits (drops only fractional digits). */
type TruncSig<A> = Parse<A> extends [infer S, infer M, infer Sc extends any[]]
  ? Len0<M> extends [...Tup16, ...infer Extra]
    ? DropLow<ToLE<M>, Extra, Sc> extends [infer L, infer Sc2] ? Fmt<S, TrimZ<FromLE<L>>, Sc2> : never
    : A
  : never;
type DropLow<L, Extra, Sc> = Extra extends [any, ...infer ER]
  ? Sc extends [any, ...infer ScR] ? DropLow<T0<L>, ER, ScR> : [L, Sc]
  : [L, Sc];

type ISqrtLoop<N, X> =
  NFloor<NDiv<NAdd<X, NFloor<NDiv<N, X>>>, '2'>> extends infer Y
    ? NCmp<Y, X> extends -1 ? ISqrtLoop<N, Y> : X
    : never;
type Newton<A, X, I extends any[] = []> =
  I['length'] extends 6 ? X
  : TruncSig<NDiv<NAdd<X, NDiv<A, X>>, '2'>> extends infer Y
    ? Y extends X ? X : Newton<A, Y, [...I, 0]>
    : never;
export type NSqrt<A> =
  A extends 'NaN' | '-Infinity' ? 'NaN' : A extends 'Infinity' | '0' ? A
  : IsNeg<A> extends true ? 'NaN'
  : NFloor<A> extends '0'
    ? Newton<A, '1'>
    : ISqrtLoop<NFloor<A>, SqrtGuess<NFloor<A>>> extends infer R
      ? NMul<R, R> extends A ? R : Newton<A, R>
      : never;
/** 10^ceil(digits/2) — always >= sqrt(N), so integer Newton descends monotonically. */
type SqrtGuess<N> = Len0<N>['length'] extends infer L extends number
  ? Half<AddU<`${L}`, '1'>> extends [infer H, any] ? `1${Repeat0<H>}` : never
  : never;
type Repeat0<N, Acc extends string = '', C extends 0[] = []> =
  `${C['length']}` extends N ? Acc : Repeat0<N, `${Acc}0`, [...C, 0]>;

export type NMax<A, B> = NCmp<A, B> extends 'nan' ? 'NaN' : NCmp<A, B> extends -1 ? B : A;
export type NMin<A, B> = NCmp<A, B> extends 'nan' ? 'NaN' : NCmp<A, B> extends 1 ? B : A;

// ---------------------------------------------------------------------------
// Parsing numbers out of arbitrary text
// ---------------------------------------------------------------------------

type AllDigits<S> = S extends '' ? true : S extends `${Digit}${infer R}` ? AllDigits<R> : false;
type ShiftExp<M extends string, Sc extends any[], X> =
  X extends `-${infer E}` ? [M, [...Sc, ...ZTup<E>]]
  : (X extends `+${infer E}` ? E : X) extends infer E
    ? ZTup<E> extends infer Z extends any[]
      ? Sc extends [...Z, ...infer Rest] ? [M, Rest]
        : Z extends [...Sc, ...infer Extra] ? [PadZ<M, Extra>, []] : never
      : never
    : never;
type ZTup<E, Acc extends 0[] = []> = `${Acc['length']}` extends E ? Acc : Acc['length'] extends 400 ? Acc : ZTup<E, [...Acc, 0]>;

type CanonMantissa<U> =
  U extends `${infer I}.${infer F}`
    ? (AllDigits<I> extends true ? AllDigits<F> extends true ? `${I}${F}` extends '' ? false : [TrimZ<`${I}${F}`>, Len0<F>] : false : false)
    : AllDigits<U> extends true ? (U extends '' ? false : [TrimZ<U>, []]) : false;

type CanonU<U> =
  U extends 'Infinity' ? 'Infinity'
  : (U extends `${infer M}e${infer X}` ? [M, X] : U extends `${infer M}E${infer X}` ? [M, X] : [U, '0']) extends [infer M, infer X]
    ? CanonMantissa<M> extends [infer Mt extends string, infer Sc extends any[]]
      ? X extends '0' ? Fmt<'', Mt, Sc>
        : AllDigits<X extends `-${infer XD}` ? XD : X extends `+${infer XD}` ? XD : X> extends true
          ? ShiftExp<Mt, Sc, X> extends [infer M2, infer S2] ? Fmt<'', TrimZ<M2>, S2> : 'NaN'
          : 'NaN'
      : 'NaN'
    : 'NaN';

/** Canonicalize any JS numeric literal text ("007", "1.50", "1e21", "-2.5E-3"); "NaN" if invalid. */
export type Canon<S> = S extends `-${infer U}` ? NNeg<CanonU<U>> : S extends `+${infer U}` ? CanonU<U> : CanonU<S>;

// ---------------------------------------------------------------------------
// 32-bit integer operations (for bitwise operators)
// ---------------------------------------------------------------------------

type TwoPow32 = '4294967296';
type TwoPow31 = '2147483648';
/** ToUint32 as a canonical non-negative integer string */
export type NToUint32<A> = A extends NonFinite ? '0'
  : NMod<NTrunc<A>, TwoPow32> extends infer R ? (IsNeg<R> extends true ? NAdd<R, TwoPow32> : R) : never;
export type NToInt32<A> = NToUint32<A> extends infer U ? (NCmp<U, TwoPow31> extends -1 ? U : NSub<U, TwoPow32>) : never;

type ToBits<U, Acc extends Bit[] = []> = Acc['length'] extends 32 ? Acc : Half<U> extends [infer H, infer B extends Bit] ? ToBits<H, [...Acc, B]> : never;
type FromBits<B, Acc extends string = '0'> = B extends [...infer Rest, infer L extends Bit] ? FromBits<Rest, L extends '1' ? AddU<AddU<Acc, Acc>, '1'> : AddU<Acc, Acc>> : Acc;
type BitTbl = {
  '&': { '0': { '0': '0'; '1': '0' }; '1': { '0': '0'; '1': '1' } };
  '|': { '0': { '0': '0'; '1': '1' }; '1': { '0': '1'; '1': '1' } };
  '^': { '0': { '0': '0'; '1': '1' }; '1': { '0': '1'; '1': '0' } };
};
type ZipBits<Op extends keyof BitTbl, A, B, Acc extends Bit[] = []> =
  A extends [infer a extends Bit, ...infer AR] ? B extends [infer b extends Bit, ...infer BR] ? ZipBits<Op, AR, BR, [...Acc, BitTbl[Op][a][b]]> : Acc : Acc;
type Signed<U> = NCmp<U, TwoPow31> extends -1 ? U : NSub<U, TwoPow32>;
type Take32<T, Acc extends any[] = []> = Acc['length'] extends 32 ? Acc : T extends [infer H, ...infer R] ? Take32<R, [...Acc, H]> : Acc;
type DropN<T, N, C extends 0[] = []> = C['length'] extends N ? T : T extends [any, ...infer R] ? DropN<R, N, [...C, 0]> : [];
type Fill<X, N, Acc extends any[] = []> = Acc['length'] extends N ? Acc : Fill<X, N, [...Acc, X]>;
type ShiftCount<B> = NMod<NToUint32<B>, '32'> extends `${infer N extends number}` ? N : 0;

export type NBitOp<Op, A, B> =
  Op extends keyof BitTbl ? Signed<FromBits<ZipBits<Op, ToBits<NToUint32<A>>, ToBits<NToUint32<B>>>>>
  : Op extends '<<' ? Signed<FromBits<Take32<[...Fill<'0', ShiftCount<B>>, ...ToBits<NToUint32<A>>]>>>
  : Op extends '>>' ? ToBits<NToUint32<A>> extends infer Bs extends Bit[]
    ? Signed<FromBits<[...DropN<Bs, ShiftCount<B>>, ...Fill<Bs[31], ShiftCount<B>>]>> : never
  : Op extends '>>>' ? FromBits<[...DropN<ToBits<NToUint32<A>>, ShiftCount<B>>, ...Fill<'0', ShiftCount<B>>]>
  : 'NaN';
export type NBitNot<A> = NSub<NNeg<NToInt32<A>>, '1'>;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

type Pow10<D extends number, Acc extends string = '1', C extends 0[] = []> = C['length'] extends D ? Acc : Pow10<D, `${Acc}0`, [...C, 0]>;
type FixedLE<L, D, C extends 0[] = [], Fr extends string = ''> =
  C['length'] extends D ? [TrimZ<FromLE<L>>, Fr] : FixedLE<T0<L>, D, [...C, 0], `${H0<L>}${Fr}`>;
/** Number.prototype.toFixed */
export type NToFixed<A, D extends number> =
  A extends NonFinite ? A
  : NRound<NMul<NAbs<A>, Pow10<D>>> extends infer R
    ? FixedLE<ToLE<R>, D> extends [infer I extends string, infer F extends string]
      ? `${IsNeg<A> extends true ? (R extends '0' ? '' : '-') : ''}${I}${F extends '' ? '' : `.${F}`}`
      : never
    : never;

/** Canonical number string -> TypeScript literal type (number, or bigint when not representable). */
export type NumLit<D> =
  D extends NonFinite ? number
  : D extends `${infer N extends number}` ? (number extends N ? (D extends `${infer B extends bigint}` ? B : number) : N)
  : number;
