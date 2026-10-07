/**
 * Runtime value model, store, environments, coercions and operators.
 *
 * Everything the machine keeps in its state is a *tuple* (never an object
 * type): the checker treats object literal / mapped types as possibly
 * generic and re-instantiates them on every pass, which nests deeper with
 * each update and quickly hits the depth limit. Concrete tuples are skipped.
 *
 * Values
 *   number      ['#', '42']                 (canonical decimal string, see num.ts)
 *   string      'abc'                       boolean / null / undefined as themselves
 *   reference   ['&', '7']                  heap address of an array or object
 *   closure     ['fn', FnNode, Env]
 *   builtin     ['bi', 'Math.floor']        bound builtin method ['bm', 'push', self]
 *
 * Store  W = [Heap, Logs]
 *   Heap is a tuple indexed by address: ['A', elements] | ['O', [key, value][]] | cell value
 *
 * Environment  E = [BoxedNames, [name, ['v', value] | ['c', address]][]]
 *   Variables live *directly* in the immutable environment (['v', x]) unless the
 *   parser found that a nested closure captures them; those get a heap cell
 *   (['c', addr]) so that mutations stay visible through every closure.
 */
import type { Canon, NAdd, NBitNot, NBitOp, NCmp, NDiv, NMod, NMul, NNeg, NPow, NSub, NTrunc, NumLit } from './num';
import type { At, Chars, Drop, ElemOf, InRange, Join, StrLen, Take, U2T } from './util';

// NOTE on construction: a tuple type literal that is the direct body of a
// generic alias, or that has an element referring to another alias, becomes a
// *deferred* type reference. The checker treats those as possibly generic and
// re-walks them on every instantiation pass, which makes long-lived lists blow
// the depth limit. So every persistent tuple below is built in a conditional
// branch from already-resolved (`infer`red) parts. `npm run lint` checks this.

export type Throw<Name extends string, Msg extends string> = [Name, Msg] extends [infer N, infer M] ? ['!throw', N, M] : never;
export type NumV<D> = [D] extends [infer X] ? ['#', X] : never;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type Inc<S> =
  S extends `${infer P}9` ? `${P extends '' ? '1' : Inc<P>}0`
  : S extends `${infer P}0` ? `${P}1` : S extends `${infer P}1` ? `${P}2` : S extends `${infer P}2` ? `${P}3`
  : S extends `${infer P}3` ? `${P}4` : S extends `${infer P}4` ? `${P}5` : S extends `${infer P}5` ? `${P}6`
  : S extends `${infer P}6` ? `${P}7` : S extends `${infer P}7` ? `${P}8` : S extends `${infer P}8` ? `${P}9` : '1';

export type HGet<W, A> = W extends [infer H, any] ? (A extends keyof H ? H[A] : undefined) : undefined;
/** Homomorphic mapped tuple: evaluated eagerly, result is a concrete tuple. */
type MapSet<H, A, V> = { [I in keyof H]: I extends A ? V : H[I] };
export type HSet<W, A, V> = W extends [infer H, infer L] ? (MapSet<H, A, V> extends infer H2 ? [H2, L] : never) : W;
export type Alloc<W, V> = W extends [infer H extends any[], infer L] ? [`${H['length']}`, [[...H, V], L]] : never;
export type AllocArr<W, Es> = Alloc<W, ['A', Es]> extends [infer A, infer W2] ? [['&', A], W2] : never;
/** Heap entries, built from resolved parts. */
export type ArrE<Es> = [Es] extends [infer X] ? ['A', X] : never;
export type ObjE<Es> = [Es] extends [infer X] ? ['O', X] : never;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export type Bindings<E> = E extends [any, infer Bs] ? Bs : [];
export type BoxOf<E> = E extends [infer B, any] ? B : [];
type FindB<Bs, Nm> = Bs extends [[infer K, infer B], ...infer R] ? (K extends Nm ? B : FindB<R, Nm>) : false;
export type HasBinding<E, Nm> = FindB<Bindings<E>, Nm> extends false ? false : true;
/** Replace (in place) or append. */
export type PutEntry<Es, K, V, Acc extends any[] = []> =
  Es extends [[infer K0, infer V0], ...infer R]
    ? K0 extends K ? [...Acc, [K, V], ...R] : PutEntry<R, K, V, [...Acc, [K0, V0]]>
    : [...Acc, [K, V]];
export type DelEntry<Es, K, Acc extends any[] = []> =
  Es extends [[infer K0, infer V0], ...infer R] ? (K0 extends K ? [...Acc, ...R] : DelEntry<R, K, [...Acc, [K0, V0]]>) : Acc;

export type Bind<E, Nm, B> = E extends [infer Box, infer Bs] ? (PutEntry<Bs, Nm, B> extends infer Bs2 ? [Box, Bs2] : never) : never;
/** Environment for a function body: the closure's env with a new boxed-name set. */
export type WithBox<E, Box> = E extends [any, infer Bs] ? [Box, Bs] : never;

type GlobalNames =
  | 'Math' | 'console' | 'Object' | 'Array' | 'String' | 'Number' | 'Boolean' | 'JSON'
  | 'parseInt' | 'parseFloat' | 'isNaN' | 'isFinite' | 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError';
export type ErrorNames = 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError';

export type Global<Nm> =
  Nm extends 'NaN' ? NumV<'NaN'> : Nm extends 'Infinity' ? NumV<'Infinity'> : Nm extends 'this' ? undefined
  : Nm extends GlobalNames ? ['bi', Nm]
  : Throw<'ReferenceError', `${Nm & string} is not defined`>;

export type Lookup<Nm, E, W> =
  FindB<Bindings<E>, Nm> extends infer B ? (B extends ['v', infer V] ? V : B extends ['c', infer A] ? HGet<W, A> : Global<Nm>) : never;

/** Assign an existing binding -> [E, W] or a throw marker. */
export type SetVar<Nm, V, E, W> =
  FindB<Bindings<E>, Nm> extends infer B
    ? B extends ['c', infer A] ? (HSet<W, A, V> extends infer W2 ? [E, W2] : never)
      : B extends ['v', any] ? (Bind<E, Nm, ['v', V]> extends infer E2 ? [E2, W] : never)
        : Throw<'ReferenceError', `${Nm & string} is not defined`>
    : never;

/** Create a binding in the current environment (heap cell if captured). */
export type Declare<Nm, V, E, W> =
  Nm extends ElemOf<BoxOf<E>>
    ? Alloc<W, V> extends [infer A, infer W2] ? (Bind<E, Nm, ['c', A]> extends infer E2 ? [E2, W2] : never) : never
    : Bind<E, Nm, ['v', V]> extends infer E2 ? [E2, W] : never;

export type DeclareMany<Ns, E, W> = Ns extends [infer N, ...infer R] ? (Declare<N, undefined, E, W> extends [infer E2, infer W2] ? DeclareMany<R, E2, W2> : never) : [E, W];

/** The bindings a block is about to shadow. */
export type PickKeys<E, Ns, Acc extends any[] = []> =
  Ns extends [infer N, ...infer R] ? PickKeys<E, R, FindB<Bindings<E>, N> extends infer B ? (B extends false ? Acc : [...Acc, [N, B]]) : never> : Acc;
/** Leave a block: remove its names, restoring whatever they shadowed. */
export type DropScope<E, Ns, Prev> = E extends [infer Box, infer Bs] ? (Restore<DropAll<Bs, Ns>, Prev> extends infer Bs2 ? [Box, Bs2] : never) : never;
type DropAll<Bs, Ns> = Ns extends [infer N, ...infer R] ? DropAll<DelEntry<Bs, N>, R> : Bs;
type Restore<Bs, Prev> = Prev extends [[infer N, infer B], ...infer R] ? Restore<PutEntry<Bs, N, B>, R> : Bs;



// ---------------------------------------------------------------------------
// Type predicates & coercions
// ---------------------------------------------------------------------------

export type IsCallable<V> =
  V extends ['fn', any, any] | ['bm', any, any] ? true
  : V extends ['bi', infer B] ? (B extends 'Math' | 'console' | 'Object' | 'JSON' ? false : true)
  : false;

export type TypeOf<V> =
  V extends string ? 'string' : V extends ['#', any] ? 'number' : V extends boolean ? 'boolean'
  : V extends undefined ? 'undefined' : V extends null ? 'object'
  : IsCallable<V> extends true ? 'function' : 'object';

export type Truthy<V> = V extends false | null | undefined | '' | ['#', '0'] | ['#', 'NaN'] ? false : true;

type WS = ' ' | '\n' | '\t' | '\r';
type TrimL<S> = S extends `${infer C}${infer R}` ? (C extends WS ? TrimL<R> : S) : S;
type TrimR<S> = S extends `${infer R} ` ? TrimR<R> : S extends `${infer R}\n` ? TrimR<R> : S extends `${infer R}\t` ? TrimR<R> : S extends `${infer R}\r` ? TrimR<R> : S;
export type Trim<S> = TrimR<TrimL<S>>;
export type TrimStart<S> = TrimL<S>;
export type TrimEnd<S> = TrimR<S>;

export type StrToNum<S> = Trim<S> extends infer T ? (T extends '' ? '0' : Canon<T>) : never;

type Entry<Es, Key> = Es extends [[infer K, infer V], ...infer R] ? (K extends Key ? [V] : Entry<R, Key>) : false;
export type HasKey<Es, Key> = Entry<Es, Key> extends false ? false : true;

export type ToStr<V, W, D extends 0[] = []> =
  V extends string ? V
  : V extends ['#', infer N extends string] ? N
  : V extends true ? 'true' : V extends false ? 'false' : V extends null ? 'null' : V extends undefined ? 'undefined'
  : V extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es] ? (D['length'] extends 6 ? '' : JoinVals<Es, ',', W, [...D, 0]>)
      : HGet<W, A> extends ['O', infer Es]
        ? Entry<Es, 'message'> extends [infer M] ? (Entry<Es, 'name'> extends [infer Nm] ? `${ToStr<Nm, W>}: ${ToStr<M, W>}` : '[object Object]') : '[object Object]'
        : ''
    : IsCallable<V> extends true ? 'function () { [native code] }' : '';

export type JoinVals<Es, Sep extends string, W, D extends 0[] = [], Acc extends string = '', First = true> =
  Es extends [infer H, ...infer R]
    ? JoinVals<R, Sep, W, D, `${First extends true ? '' : `${Acc}${Sep}`}${H extends null | undefined ? '' : ToStr<H, W, D>}`, false>
    : Acc;

export type ToNum<V, W> =
  V extends ['#', infer N] ? N
  : V extends string ? StrToNum<V>
  : V extends true ? '1' : V extends false | null ? '0' : V extends undefined ? 'NaN'
  : V extends ['&', any] ? StrToNum<ToStr<V, W>>
  : 'NaN';

type ToPrim<V, W> = V extends ['&', any] | ['fn', any, any] | ['bi', any] | ['bm', any, any] ? ToStr<V, W> : V;

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

type Ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
type AsciiT = Chars<Ascii>;
type BuildCodes<T, N extends 0[], Acc> = T extends [infer C extends string, ...infer R] ? BuildCodes<R, [...N, 0], Acc & { [K in C]: N['length'] }> : Acc;
type Tup32 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
type Codes = BuildCodes<AsciiT, Tup32, { '\t': 9; '\n': 10; '\r': 13 }>;
type CodeTbl = { [K in keyof Codes]: Codes[K] };
export type CharCode<C> = C extends keyof CodeTbl ? CodeTbl[C] : 65533;
export type FromCharCode<N> = N extends 9 ? '\t' : N extends 10 ? '\n' : N extends 13 ? '\r'
  : { [K in keyof CodeTbl]: CodeTbl[K] extends N ? K : never }[keyof CodeTbl] extends infer C
    ? [C] extends [never] ? '�' : C
    : never;

export type StrCmp<A, B> =
  A extends `${infer a}${infer AR}`
    ? B extends `${infer b}${infer BR}`
      ? a extends b ? StrCmp<AR, BR> : NCmp<`${CharCode<a>}`, `${CharCode<b>}`>
      : 1
    : B extends '' ? 0 : -1;

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type StrictEq<A, B> =
  A extends ['#', infer X] ? (B extends ['#', infer Y] ? (X extends 'NaN' ? false : [X] extends [Y] ? true : false) : false)
  : [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Prim = string | boolean | ['#', any];
export type LooseEq<A, B, W> =
  A extends null | undefined ? (B extends null | undefined ? true : false)
  : B extends null | undefined ? false
  : [A, B] extends [string, string] ? StrictEq<A, B>
  : [A, B] extends [Prim, Prim] ? NCmp<ToNum<A, W>, ToNum<B, W>> extends 0 ? true : false
  : A extends ['&', any] ? (B extends ['&', any] ? StrictEq<A, B> : LooseEq<ToStr<A, W>, B, W>)
  : B extends ['&', any] ? LooseEq<A, ToStr<B, W>, W>
  : StrictEq<A, B>;

type Plus<A, B, W> = ToPrim<A, W> extends infer PA
  ? ToPrim<B, W> extends infer PB
    ? PA extends string ? `${PA}${ToStr<PB, W>}`
      : PB extends string ? `${ToStr<PA, W>}${PB}`
        : NumV<NAdd<ToNum<PA, W>, ToNum<PB, W>>>
    : never
  : never;

type Rel<Op, A, B, W> = ToPrim<A, W> extends infer PA
  ? ToPrim<B, W> extends infer PB
    ? ([PA, PB] extends [string, string] ? StrCmp<PA, PB> : NCmp<ToNum<PA, W>, ToNum<PB, W>>) extends infer C
      ? C extends 'nan' ? false
        : Op extends '<' ? (C extends -1 ? true : false)
          : Op extends '>' ? (C extends 1 ? true : false)
            : Op extends '<=' ? (C extends 1 ? false : true)
              : C extends -1 ? false : true
      : never
    : never
  : never;

type Not<B> = B extends true ? false : true;

type InOp<K, O, W> = O extends ['&', infer A]
  ? HGet<W, A> extends ['A', infer Es extends any[]]
    ? (PropKey<K, W> extends infer P ? P extends 'length' ? true : InRange<Es, IdxOf<P>> : never)
    : HGet<W, A> extends ['O', infer Es] ? HasKey<Es, PropKey<K, W>> : false
  : Throw<'TypeError', `Cannot use 'in' operator to search for '${ToStr<K, W>}' in ${ToStr<O, W>}`>;

type InstOf<V, C, W> =
  C extends ['bi', 'Array'] ? (V extends ['&', infer A] ? (HGet<W, A> extends ['A', any] ? true : false) : false)
  : C extends ['bi', 'Object'] ? (V extends ['&', any] | ['fn', any, any] ? true : false)
  : C extends ['bi', infer N extends ErrorNames]
    ? V extends ['&', infer A] ? (HGet<W, A> extends ['O', infer Es] ? (Entry<Es, 'name'> extends [infer En] ? (N extends 'Error' ? true : En extends N ? true : false) : false) : false) : false
  : false;

type Bitwise = '&' | '|' | '^' | '<<' | '>>' | '>>>';

export type BinOp<Op, A, B, W> =
  Op extends '+' ? Plus<A, B, W>
  : Op extends '-' ? NumV<NSub<ToNum<A, W>, ToNum<B, W>>>
  : Op extends '*' ? NumV<NMul<ToNum<A, W>, ToNum<B, W>>>
  : Op extends '/' ? NumV<NDiv<ToNum<A, W>, ToNum<B, W>>>
  : Op extends '%' ? NumV<NMod<ToNum<A, W>, ToNum<B, W>>>
  : Op extends '**' ? NumV<NPow<ToNum<A, W>, ToNum<B, W>>>
  : Op extends '===' ? StrictEq<A, B>
  : Op extends '!==' ? Not<StrictEq<A, B>>
  : Op extends '==' ? LooseEq<A, B, W>
  : Op extends '!=' ? Not<LooseEq<A, B, W>>
  : Op extends '<' | '>' | '<=' | '>=' ? Rel<Op, A, B, W>
  : Op extends Bitwise ? NumV<NBitOp<Op, ToNum<A, W>, ToNum<B, W>>>
  : Op extends 'in' ? InOp<A, B, W>
  : Op extends 'instanceof' ? InstOf<A, B, W>
  : Throw<'SyntaxError', `Unsupported operator ${Op & string}`>;

export type UnOp<Op, V, W> =
  Op extends '!' ? Not<Truthy<V>>
  : Op extends '-' ? NumV<NNeg<ToNum<V, W>>>
  : Op extends '+' ? NumV<ToNum<V, W>>
  : Op extends 'typeof' ? TypeOf<V>
  : Op extends '~' ? NumV<NBitNot<ToNum<V, W>>>
  : Op extends 'void' ? undefined
  : Throw<'SyntaxError', `Unsupported operator ${Op & string}`>;

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

/** Canonical array index (as a number) or false. */
export type IdxOf<P> = P extends `${infer N extends number}` ? (`${N}` extends P ? (P extends `${string}${'.' | '-' | 'e'}${string}` ? false : N) : false) : false;
export type PropKey<V, W> = V extends string ? V : ToStr<V, W>;

type StrMethods = 'charAt' | 'charCodeAt' | 'at' | 'indexOf' | 'lastIndexOf' | 'includes' | 'startsWith' | 'endsWith' | 'slice' | 'substring'
  | 'toUpperCase' | 'toLowerCase' | 'trim' | 'trimStart' | 'trimEnd' | 'split' | 'repeat' | 'concat' | 'replace' | 'replaceAll'
  | 'padStart' | 'padEnd' | 'toString';
type ArrMethods = 'push' | 'pop' | 'shift' | 'unshift' | 'indexOf' | 'lastIndexOf' | 'includes' | 'join' | 'slice' | 'concat' | 'reverse' | 'at' | 'fill'
  | 'splice' | 'flat' | 'map' | 'filter' | 'forEach' | 'reduce' | 'some' | 'every' | 'find' | 'findIndex' | 'flatMap' | 'sort' | 'toString';
type NumMethods = 'toFixed' | 'toString';
type Namespaces = 'Math' | 'Number' | 'Object' | 'Array' | 'String' | 'JSON' | 'console';
type Statics = {
  'Math.PI': NumV<'3.141592653589793'>; 'Math.E': NumV<'2.718281828459045'>;
  'Number.MAX_SAFE_INTEGER': NumV<'9007199254740991'>; 'Number.MIN_SAFE_INTEGER': NumV<'-9007199254740991'>;
  'Number.POSITIVE_INFINITY': NumV<'Infinity'>; 'Number.NEGATIVE_INFINITY': NumV<'-Infinity'>; 'Number.NaN': NumV<'NaN'>;
  'Number.EPSILON': NumV<'0.0000000000000002220446049250313'>;
};

export type GetProp<O, P, W> =
  O extends string
    ? P extends 'length' ? NumV<`${StrLen<O>}`>
      : IdxOf<P> extends infer I extends number ? At<Chars<O>, I>
        : P extends StrMethods ? ['bm', P, O] : undefined
  : O extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es extends any[]]
      ? P extends 'length' ? NumV<`${Es['length']}`>
        : IdxOf<P> extends infer I extends number ? At<Es, I>
          : P extends ArrMethods ? ['bm', P, O] : undefined
      : HGet<W, A> extends ['O', infer Es]
        ? Entry<Es, P> extends [infer V] ? V : P extends 'hasOwnProperty' ? ['bm', P, O] : undefined
        : undefined
  : O extends ['#', any] ? (P extends NumMethods ? ['bm', P, O] : undefined)
  : O extends ['bi', infer B extends string]
    ? `${B}.${P & string}` extends infer Q ? (Q extends keyof Statics ? Statics[Q] : B extends Namespaces ? ['bi', Q] : undefined) : never
  : O extends null | undefined ? Throw<'TypeError', `Cannot read properties of ${O extends null ? 'null' : 'undefined'} (reading '${P & string}')`>
  : undefined;

type SetIdx<Es extends any[], I extends number, V> =
  `${I}` extends keyof Es ? { [K in keyof Es]: K extends `${I}` ? V : Es[K] }
  : Es['length'] extends I ? [...Es, V]
  : SetIdx<[...Es, undefined], I, V>;

/** Returns the new store, or a throw marker. */
export type SetProp<O, P, V, W> =
  O extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es extends any[]]
      ? P extends 'length'
        ? (IdxOf<ToNum<V, W>> extends infer N extends number ? HSet<W, A, ArrE<Resize<Es, N>>> : Throw<'RangeError', 'Invalid array length'>)
        : IdxOf<P> extends infer I extends number ? HSet<W, A, ArrE<SetIdx<Es, I, V>>> : W
      : HGet<W, A> extends ['O', infer Es] ? HSet<W, A, ObjE<PutEntry<Es, P, V>>> : W
    : O extends null | undefined ? Throw<'TypeError', `Cannot set properties of ${O extends null ? 'null' : 'undefined'} (setting '${P & string}')`>
    : W;

type Resize<Es extends any[], N extends number> = Es['length'] extends N ? Es : `${N}` extends keyof Es ? Take<Es, N> : Resize<[...Es, undefined], N>;

/** Values produced by for-of / spread. */
export type Elements<V, W> =
  V extends string ? Chars<V>
  : V extends ['&', infer A] ? (HGet<W, A> extends ['A', infer Es] ? Es : Throw<'TypeError', 'object is not iterable'>)
  : Throw<'TypeError', `${ToStr<V, W>} is not iterable`>;

export type Indices<N, Acc extends string[] = []> = Acc['length'] extends N ? Acc : Indices<N, [...Acc, `${Acc['length']}`]>;
/** Keys produced by for-in / Object.keys. */
export type KeysOf<V, W> =
  V extends string ? Indices<StrLen<V>>
  : V extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es extends any[]] ? Indices<Es['length']>
      : HGet<W, A> extends ['O', infer Es] ? EntryKeys<Es>
        : []
    : [];
type EntryKeys<Es> = { [I in keyof Es]: Es[I] extends [infer K, any] ? K : never };
type EntryVals<Es> = { [I in keyof Es]: Es[I] extends [any, infer X] ? X : never };
export type ValuesOf<V, W> =
  V extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es] ? Es
      : HGet<W, A> extends ['O', infer Es] ? EntryVals<Es>
        : []
    : V extends string ? Chars<V> : [];
export type EntriesOf<V, W> =
  V extends ['&', infer A] ? (HGet<W, A> extends ['O', infer Es] ? Es : HGet<W, A> extends ['A', infer Es extends any[]] ? ZipIdx<Es> : []) : [];
type ZipIdx<Es, Acc extends any[] = []> = Es extends [infer H, ...infer R] ? ZipIdx<R, [...Acc, [`${Acc['length']}`, H]]> : Acc;

// ---------------------------------------------------------------------------
// Helpers used by builtins
// ---------------------------------------------------------------------------

export type IsNegS<D> = D extends `-${string}` ? true : false;
export type ToInt<D> = D extends `${infer X extends number}` ? X : 0;
/** Normalise a relative index argument (slice semantics) into [0, Len]. */
export type RelIdx<V, Len extends number, Def extends number, W> =
  V extends undefined ? Def
  : NTrunc<ToNum<V, W>> extends infer T
    ? T extends 'NaN' ? 0
      : T extends 'Infinity' ? Len : T extends '-Infinity' ? 0
        : IsNegS<T> extends true
          ? NAdd<T, `${Len}`> extends infer S ? (IsNegS<S> extends true ? 0 : ToInt<S>) : never
          : NCmp<T, `${Len}`> extends 1 ? Len : ToInt<T>
    : never;
/** Clamp a (substring-style) argument into [0, Len]. */
export type ClampIdx<V, Len extends number, Def extends number, W> =
  V extends undefined ? Def
  : NTrunc<ToNum<V, W>> extends infer T
    ? T extends 'NaN' | '-Infinity' ? 0 : T extends 'Infinity' ? Len
      : IsNegS<T> extends true ? 0 : NCmp<T, `${Len}`> extends 1 ? Len : ToInt<T>
    : never;
export type Lt<A extends number, B extends number> = NCmp<`${A}`, `${B}`> extends -1 ? true : false;
export type NSubN<A extends number, B extends number> = ToInt<NSub<`${A}`, `${B}`>>;
export type NAddN<A extends number, B extends number> = ToInt<NAdd<`${A}`, `${B}`>>;

export type IndexOfStr<S, X> = X extends '' ? 0 : S extends `${infer Pre}${X & string}${string}` ? StrLen<Pre> : -1;
export type LastIndexOfStr<S, X, Off extends number = 0, Best extends number = -1> =
  S extends `${infer Pre}${X & string}${string}`
    ? NAddN<Off, StrLen<Pre>> extends infer At extends number
      ? Chars<S> extends [any, ...infer Tail] ? LastIndexOfStr<Join<Drop<Tail, StrLen<Pre>>, ''>, X, NAddN<At, 1>, At> : Best
      : never
    : Best;
export type SplitStr<S, Sep, Acc extends string[] = []> =
  Sep extends '' ? Chars<S>
  : S extends `${infer A}${Sep & string}${infer B}` ? SplitStr<B, Sep, [...Acc, A]> : [...Acc, S];
export type ReplaceAll<S, A extends string, B extends string, Acc extends string = ''> =
  A extends '' ? S : S extends `${infer P}${A}${infer R}` ? ReplaceAll<R, A, B, `${Acc}${P}${B}`> : `${Acc}${S & string}`;
export type RepeatStr<S extends string, N extends number, Acc extends string = '', C extends 0[] = []> =
  C['length'] extends N ? Acc : RepeatStr<S, N, `${Acc}${S}`, [...C, 0]>;
export type PadStr<S extends string, Len extends number, Fill extends string, End extends boolean> =
  StrLen<S> extends infer L extends number
    ? Lt<L, Len> extends true
      ? Join<Take<Chars<RepeatStr<Fill, NAddN<NSubN<Len, L>, 1>>>, NSubN<Len, L>>, ''> extends infer P extends string
        ? End extends true ? `${S}${P}` : `${P}${S}`
        : never
      : S
    : never;

export type IndexOfVal<Es, X, I extends 0[] = []> = Es extends [infer H, ...infer R] ? (StrictEq<H, X> extends true ? I['length'] : IndexOfVal<R, X, [...I, 0]>) : -1;
export type IncludesVal<Es, X> = X extends ['#', 'NaN'] ? (Es extends any[] ? (['#', 'NaN'] extends Es[number] ? true : false) : false) : IndexOfVal<Es, X> extends -1 ? false : true;

// ---------------------------------------------------------------------------
// TypeScript <-> runtime value conversion
// ---------------------------------------------------------------------------

/** Runtime value -> TypeScript type. */
export type ToTS<V, W, D extends 0[] = []> =
  D['length'] extends 24 ? unknown
  : V extends ['#', infer N] ? NumLit<N>
  : V extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es extends any[]] ? { -readonly [I in keyof Es]: ToTS<Es[I], W, [...D, 0]> }
      : HGet<W, A> extends ['O', infer Es extends any[]] ? { [En in Es[number] as En[0] & string]: ToTS<En[1], W, [...D, 0]> }
        : unknown
    : IsCallable<V> extends true ? (...args: any[]) => unknown
    : V;

export type ToTSList<L, W> = { [I in keyof L]: ToTS<L[I], W> };

/** TypeScript type -> runtime value, allocating arrays/objects. Returns [value, W]. */
export type FromTS<V, W> =
  V extends number ? (number extends V ? Throw<'TypeError', 'Arguments must be literal types (got number)'> : (NumV<Canon<`${V}`>> extends infer N ? [N, W] : never))
  : V extends bigint ? (NumV<`${V}`> extends infer N ? [N, W] : never)
  : V extends string ? (string extends V ? Throw<'TypeError', 'Arguments must be literal types (got string)'> : [V, W])
  : V extends boolean | null | undefined ? [V, W]
  : V extends readonly any[] ? (FromList<V, W> extends [infer Vs, infer W2] ? AllocArr<W2, Vs> : FromList<V, W>)
  : V extends object ? (FromEntries<U2T<keyof V>, V, W> extends [infer Es, infer W2] ? (Alloc<W2, ['O', Es]> extends [infer A, infer W3] ? [['&', A], W3] : never) : FromEntries<U2T<keyof V>, V, W>)
  : [undefined, W];
export type FromList<L, W, Acc extends any[] = []> =
  L extends readonly [infer H, ...infer R]
    ? FromTS<H, W> extends [infer V, infer W2] ? FromList<R, W2, [...Acc, V]> : FromTS<H, W>
    : [Acc, W];
type FromEntries<Ks, O, W, Acc extends any[] = []> =
  Ks extends [infer K extends keyof O & string, ...infer R]
    ? FromTS<O[K], W> extends [infer V, infer W2] ? FromEntries<R, O, W2, [...Acc, [K, V]]> : FromTS<O[K], W>
    : [Acc, W];
