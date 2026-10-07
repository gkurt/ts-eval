/**
 * The evaluator: a CEK-style abstract machine.
 *
 *   State = [Mode, X, Env, Kont, Store]
 *
 *   'ev'  evaluate expression X           'ex'  execute statement X
 *   'ret' hand value X to the top frame   'throw' | 'brk' | 'cont' | 'retfn'  unwind the stack
 *   'done' | 'uncaught' | 'err'  final
 *
 * Kont is a cons-list of frames, so *every* step is a constant-depth type
 * instantiation; the driver loops over steps tail-recursively in fuel-bounded
 * chunks. Nothing here recurses on the structure of the program, which is
 * what lets deep recursion (fib, ackermann, ...) run inside the type checker.
 */
import type { Arg0, Arg1, Arg2, GlobalCall, NumMethod, StrMethod, StrList } from './builtins';
import type { NCmp, NToFixed } from './num';
import type {
  Alloc, AllocArr, BinOp, DelEntry, Declare, DeclareMany, DropScope, Elements, EntriesOf, ErrorNames, FromTS, GetProp, HGet, HSet,
  IdxOf, Inc, IncludesVal, IndexOfVal, IsCallable, KeysOf, Lookup, NumV, PickKeys, PropKey, PutEntry, RelIdx, SetProp, SetVar,
  StrictEq, ToNum, ToStr, ToTS, ToTSList, Truthy, UnOp, ValuesOf, JoinVals, IsNegS, ToInt, HasKey, Bind, WithBox, HasBinding,
} from './runtime';
import type { At, Concat, Drop, Minus, Nx, Push, Reverse, Slice, Take } from './util';
import type { NAdd, NSub } from './num';

type IsThrow<R> = R extends ['!throw', any, any] ? true : false;

/** Turn a builtin/helper result into a machine state. */
type Fin<R, E, K, W> =
  R extends ['!throw', infer N, infer M] ? ThrowErr<N, M, E, K, W>
  : R extends ['!vw', infer V, infer W2] ? ['ret', V, E, K, W2]
  : ['ret', R, E, K, W];

type ThrowErr<N, M, E, K, W> = Alloc<W, ['O', [['name', N], ['message', M]]]> extends [infer A, infer W2] ? ['throw', ['&', A], E, K, W2] : never;

/** Continue with an [E, W] pair from SetVar/Declare (or a throw marker). */
type WithEW<R, V, K, Then = 'ret'> = R extends [infer E2, infer W2] ? ['ret', V, E2, K, W2] : never;

// ---------------------------------------------------------------------------
// Scopes and calls
// ---------------------------------------------------------------------------

type InitFuncs<Fs, E, W> =
  Fs extends [[infer Nm, infer Node], ...infer R]
    ? SetVar<Nm, ['fn', Node, E], E, W> extends [infer E2, infer W2] ? InitFuncs<R, E2, W2> : [E, W]
    : [E, W];

/** Enter a block scope: declare names (hoisted, = undefined), initialise function declarations. */
type EnterScope<Ns, Fs, E, K, W> =
  Ns extends []
    ? [E, K, W]
    : DeclareMany<Ns, E, W> extends [infer E1, infer W1]
      ? InitFuncs<Fs, E1, W1> extends [infer E2, infer W2] ? (PickKeys<E, Ns> extends infer Prev ? [E2, [['Env', Ns, Prev], K], W2] : never) : never
      : never;

type BindParams<Ps, Args, E, W> =
  Ps extends [infer P, ...infer PR]
    ? Args extends [infer A, ...infer AR]
      ? Declare<P, A, E, W> extends [infer E2, infer W2] ? BindParams<PR, AR, E2, W2> : never
      : Declare<P, undefined, E, W> extends [infer E2, infer W2] ? BindParams<PR, [], E2, W2> : never
    : [E, W, Args];

type BindRest<Rest, Args, E, W> =
  Rest extends string ? (AllocArr<W, Args> extends [infer R, infer W2] ? Declare<Rest, R, E, W2> : never) : [E, W];

type CallClosure<Fn, CE, This, Args, E, K, W> =
  Fn extends ['Fn', any, infer Ps, infer Rest, infer Body, infer Hoist, infer Funcs, infer Box, infer Arrow]
    ? (Arrow extends true ? WithBox<CE, Box> : Bind<WithBox<CE, Box>, 'this', ['v', This]>) extends infer E0
      ? BindParams<Ps, Args, E0, W> extends [infer E1, infer W1, infer RestArgs]
        ? BindRest<Rest, RestArgs, E1, W1> extends [infer E2, infer W2]
          ? DeclareMany<Minus<Hoist, Concat<Ps, [Rest]>>, E2, W2> extends [infer E3, infer W3]
            ? InitFuncs<Funcs, E3, W3> extends [infer E4, infer W4]
              ? ['ret', undefined, E4, [['Seq', Body], [['CallRet', E], K]], W4]
              : never
            : never
          : never
        : never
      : never
    : never;

type Describe<F, W> = F extends string ? `"${F}"` : ToStr<F, W>;

type Apply<F, This, Args, E, K, W> =
  F extends ['fn', infer Fn, infer CE] ? CallClosure<Fn, CE, This, Args, E, K, W>
  : F extends ['bm', infer M, infer S] ? CallMethod<M, S, Args, E, K, W>
  : F extends ['bi', infer B] ? CallBuiltin<B, Args, E, K, W>
  : ThrowErr<'TypeError', `${Describe<F, W>} is not a function`, E, K, W>;

type MkError<N, Msg, W> = (Msg extends undefined ? '' : ToStr<Msg, W>) extends infer M
  ? Alloc<W, ['O', [['name', N], ['message', M]]]> extends [infer A, infer W2] ? ['!vw', ['&', A], W2] : never
  : never;

type ArrayCtor<Args, W> =
  Args extends [['#', infer N]]
    ? IdxOf<N> extends infer L extends number ? AllocVW<FillN<undefined, L>, W> : ['!throw', 'RangeError', 'Invalid array length']
    : AllocVW<Args, W>;
type FillN<X, N, Acc extends any[] = []> = Acc['length'] extends N ? Acc : FillN<X, N, [...Acc, X]>;
type AllocVW<Es, W> = AllocArr<W, Es> extends [infer R, infer W2] ? ['!vw', R, W2] : never;

type AllocPairs<Es, W, Acc extends any[] = []> =
  Es extends [[infer K, infer V], ...infer R]
    ? AllocArr<W, [K, V]> extends [infer P, infer W2] ? AllocPairs<R, W2, [...Acc, P]> : never
    : AllocArr<W, Acc>;

type PairsToEntries<Ps, W, Acc extends any[] = []> =
  Ps extends [infer P, ...infer R]
    ? Elements<P, W> extends [infer K, infer V, ...any[]] ? PairsToEntries<R, W, PutEntry<Acc, PropKey<K, W>, V>> : PairsToEntries<R, W, Acc>
    : Acc;

type OmitKeys<Es, Ks extends any[], Acc extends any[] = []> = Es extends [[infer K, infer V], ...infer R] ? OmitKeys<R, Ks, K extends Ks[number] ? Acc : [...Acc, [K, V]]> : Acc;
type MergeInto<Es, Srcs, W> = Srcs extends [infer S, ...infer R] ? MergeInto<MergeEntries<Es, EntriesOf<S, W>>, R, W> : Es;
type MergeEntries<Es, New> = New extends [[infer K, infer V], ...infer R] ? MergeEntries<PutEntry<Es, K, V>, R> : Es;

type CallBuiltin<B, Args, E, K, W> =
  B extends 'console.log'
    ? W extends [infer H, infer L extends any[]] ? ['ret', undefined, E, K, [H, [...L, ToTSList<Args, W>]]] : never
  : B extends 'Array' | 'Array.of' ? Fin<B extends 'Array' ? ArrayCtor<Args, W> : AllocVW<Args, W>, E, K, W>
  : B extends 'Array.from' ? ArrayFrom<Arg0<Args>, Arg1<Args>, E, K, W>
  : B extends ErrorNames ? Fin<MkError<B, Arg0<Args>, W>, E, K, W>
  : B extends 'Object.keys' ? Fin<AllocVW<KeysOf<Arg0<Args>, W>, W>, E, K, W>
  : B extends 'Object.values' ? Fin<AllocVW<ValuesOf<Arg0<Args>, W>, W>, E, K, W>
  : B extends 'Object.entries' ? (AllocPairs<EntriesOf<Arg0<Args>, W>, W> extends [infer R, infer W2] ? ['ret', R, E, K, W2] : never)
  : B extends 'Object.fromEntries'
    ? Elements<Arg0<Args>, W> extends infer Ps ? (IsThrow<Ps> extends true ? Fin<Ps, E, K, W> : (PairsToEntries<Ps, W> extends infer Es ? Alloc<W, ['O', Es]> : never) extends [infer A, infer W2] ? ['ret', ['&', A], E, K, W2] : never) : never
  : B extends '%omit'
    ? (OmitKeys<EntriesOf<Arg0<Args>, W>, Drop<Args, 1>> extends infer Es ? Alloc<W, ['O', Es]> : never) extends [infer A, infer W2] ? ['ret', ['&', A], E, K, W2] : never
  : B extends 'Object.assign'
    ? Arg0<Args> extends ['&', infer A]
      ? HGet<W, A> extends ['O', infer Es] ? (MergeInto<Es, Drop<Args, 1>, W> extends infer Es2 ? ['ret', Arg0<Args>, E, K, HSet<W, A, ['O', Es2]>] : never) : ['ret', Arg0<Args>, E, K, W]
      : ThrowErr<'TypeError', 'Cannot convert undefined or null to object', E, K, W>
  : Fin<GlobalCall<B, Args, W>, E, K, W>;

type ArrayFrom<Src, Fn, E, K, W> =
  (Src extends ['&', infer A] ? (HGet<W, A> extends ['A', infer Es] ? Es : HGet<W, A> extends ['O', infer Es] ? (GetProp<Src, 'length', W> extends ['#', infer N] ? FillN<undefined, IdxOf<N>> : []) : []) : Src extends string ? Elements<Src, W> : []) extends infer Items
    ? Fn extends undefined ? Fin<AllocVW<Items, W>, E, K, W> : ItNext<'map', Fn, Items, '0', [], undefined, E, K, W>
    : never;

type Construct<F, Args, E, K, W> =
  F extends ['bi', 'Array'] ? Fin<ArrayCtor<Args, W>, E, K, W>
  : F extends ['bi', infer B extends ErrorNames] ? Fin<MkError<B, Arg0<Args>, W>, E, K, W>
  : F extends ['fn', ['Fn', ...infer Rest], any]
    ? Rest extends [...any[], true] ? ThrowErr<'TypeError', 'arrow function is not a constructor', E, K, W>
      : Alloc<W, ['O', []]> extends [infer A, infer W2] ? Apply<F, ['&', A], Args, E, [['NewRet', ['&', A]], K], W2> : never
  : ThrowErr<'TypeError', `${Describe<F, W>} is not a constructor`, E, K, W>;

// ---------------------------------------------------------------------------
// Methods on primitives / arrays / objects
// ---------------------------------------------------------------------------

type CallMethod<M, S, Args, E, K, W> =
  S extends string ? Fin<StrMethod<M, S, Args, W>, E, K, W>
  : S extends ['#', infer N] ? Fin<NumMethod<M, N, Args, W>, E, K, W>
  : S extends ['&', infer A]
    ? HGet<W, A> extends ['A', infer Es extends any[]] ? ArrMethod<M, S, A, Es, Args, E, K, W>
      : HGet<W, A> extends ['O', infer Es] ? (M extends 'hasOwnProperty' ? ['ret', HasKey<Es, PropKey<Arg0<Args>, W>>, E, K, W] : ThrowErr<'TypeError', `obj.${M & string} is not a function`, E, K, W>)
        : never
    : never;

type Ret<V, E, K, W> = ['ret', V, E, K, W];
type Store<W, A, Es> = HSet<W, A, ['A', Es]>;
type Callback = 'map' | 'filter' | 'forEach' | 'some' | 'every' | 'find' | 'findIndex' | 'flatMap';

type ArrMethod<M, S, A, Es extends any[], Args, E, K, W> =
  M extends 'push' ? (Concat<Es, Args> extends infer N extends any[] ? Ret<NumV<`${N['length']}`>, E, K, Store<W, A, N>> : never)
  : M extends 'pop' ? (Es extends [...infer I, infer L] ? Ret<L, E, K, Store<W, A, I>> : Ret<undefined, E, K, W>)
  : M extends 'shift' ? (Es extends [infer F, ...infer R] ? Ret<F, E, K, Store<W, A, R>> : Ret<undefined, E, K, W>)
  : M extends 'unshift' ? (Concat<Args, Es> extends infer N extends any[] ? Ret<NumV<`${N['length']}`>, E, K, Store<W, A, N>> : never)
  : M extends 'indexOf' ? Ret<NumV<`${IndexOfVal<Es, Arg0<Args>>}`>, E, K, W>
  : M extends 'lastIndexOf' ? Ret<NumV<IndexOfVal<Reverse<Es>, Arg0<Args>> extends infer I extends number ? (I extends -1 ? '-1' : NSub<NSub<`${Es['length']}`, '1'>, `${I}`>) : never>, E, K, W>
  : M extends 'includes' ? Ret<IncludesVal<Es, Arg0<Args>>, E, K, W>
  : M extends 'join' | 'toString' ? Ret<JoinVals<Es, M extends 'join' ? (Arg0<Args> extends undefined ? ',' : ToStr<Arg0<Args>, W>) : ',', W>, E, K, W>
  : M extends 'slice' ? Fin<AllocVW<Slice<Es, RelIdx<Arg0<Args>, Es['length'], 0, W>, RelIdx<Arg1<Args>, Es['length'], Es['length'], W>>, W>, E, K, W>
  : M extends 'concat' ? Fin<AllocVW<Concat<Es, Spreadable<Args, W>>, W>, E, K, W>
  : M extends 'reverse' ? Ret<S, E, K, Store<W, A, Reverse<Es>>>
  : M extends 'at' ? Ret<AtVal<Es, Arg0<Args>, W>, E, K, W>
  : M extends 'fill'
    ? RelIdx<Arg1<Args>, Es['length'], 0, W> extends infer St extends number
      ? RelIdx<Arg2<Args>, Es['length'], Es['length'], W> extends infer En extends number
        ? Ret<S, E, K, Store<W, A, [...Take<Es, St>, ...FillN<Arg0<Args>, Max0<En, St>>, ...Drop<Es, En>]>>
        : never
      : never
  : M extends 'splice' ? Splice<S, A, Es, Args, E, K, W>
  : M extends 'flat' ? Fin<AllocVW<Spreadable<Es, W>, W>, E, K, W>
  : M extends Callback ? ItNext<M, Arg0<Args>, Es, '0', [], S, E, K, W>
  : M extends 'reduce'
    ? Args extends [any, infer Init, ...any[]] ? ItNext<'reduce', Arg0<Args>, Es, '0', Init, S, E, K, W>
      : Es extends [infer F, ...infer R] ? ItNext<'reduce', Arg0<Args>, R, '1', F, S, E, K, W>
        : ThrowErr<'TypeError', 'Reduce of empty array with no initial value', E, K, W>
  : M extends 'sort' ? SortStart<Arg0<Args> extends undefined ? ['bi', '%cmp'] : Arg0<Args>, Es, S, A, E, K, W>
  : ThrowErr<'TypeError', `arr.${M & string} is not a function`, E, K, W>;

type Max0<En extends number, St extends number> = NCmp<`${En}`, `${St}`> extends 1 ? ToInt<NSub<`${En}`, `${St}`>> : 0;
type AtVal<Es extends any[], V, W> = NTrunc0<ToNum<V, W>> extends infer T
  ? (IsNegS<T> extends true ? NAdd<T, `${Es['length']}`> : T) extends `${infer I extends number}` ? At<Es, I> : undefined
  : never;
type NTrunc0<N> = import('./num').NTrunc<N> extends 'NaN' ? '0' : import('./num').NTrunc<N>;
/** concat/flat semantics: arrays are spread one level, everything else appended. */
type Spreadable<L, W, Acc extends any[] = []> =
  L extends [infer H, ...infer R]
    ? H extends ['&', infer A] ? (HGet<W, A> extends ['A', infer Es extends any[]] ? Spreadable<R, W, [...Acc, ...Es]> : Spreadable<R, W, [...Acc, H]>) : Spreadable<R, W, [...Acc, H]>
    : Acc;

type Splice<S, A, Es extends any[], Args, E, K, W> =
  RelIdx<Arg0<Args>, Es['length'], 0, W> extends infer St extends number
    ? (Args extends [any] ? Es['length'] : Args extends [] ? 0 : ToInt<NAdd<`${St}`, `${MaxN0<ToInt<import('./num').NTrunc<ToNum<Arg1<Args>, W>>>>}`>>) extends infer EndRaw extends number
      ? (NCmp<`${EndRaw}`, `${Es['length']}`> extends 1 ? Es['length'] : EndRaw) extends infer En extends number
        ? AllocArr<W, Slice<Es, St, En>> extends [infer Removed, infer W2]
          ? Ret<Removed, E, K, Store<W2, A, [...Take<Es, St>, ...Drop<Args, 2>, ...Drop<Es, En>]>>
          : never
        : never
      : never
    : never;
type MaxN0<N extends number> = `${N}` extends `-${string}` ? 0 : N;

// --- iteration with callbacks (map / filter / reduce / ...) ---

type ItNext<Kind, Fn, Items, Idx extends string, Acc, Self, E, K, W> =
  Items extends [infer X, ...infer R]
    ? NumV<Idx> extends infer IV ? Apply<Fn, undefined, Kind extends 'reduce' ? [Acc, X, IV, Self] : [X, IV, Self], E, [['It', Kind, Fn, R, Idx, Acc, X, Self], K], W> : never
    : Kind extends 'map' | 'filter' | 'flatMap' ? Fin<AllocVW<Acc, W>, E, K, W>
    : Kind extends 'reduce' ? Ret<Acc, E, K, W>
    : Kind extends 'some' | 'find' ? Ret<Kind extends 'some' ? false : undefined, E, K, W>
    : Kind extends 'every' ? Ret<true, E, K, W>
    : Kind extends 'findIndex' ? Ret<NumV<'-1'>, E, K, W>
    : Ret<undefined, E, K, W>;

type ItStep<Kind, Fn, R, Idx extends string, Acc, X, Self, V, E, K, W> =
  Kind extends 'some' ? (Truthy<V> extends true ? Ret<true, E, K, W> : ItNext<Kind, Fn, R, Inc<Idx>, Acc, Self, E, K, W>)
  : Kind extends 'every' ? (Truthy<V> extends true ? ItNext<Kind, Fn, R, Inc<Idx>, Acc, Self, E, K, W> : Ret<false, E, K, W>)
  : Kind extends 'find' ? (Truthy<V> extends true ? Ret<X, E, K, W> : ItNext<Kind, Fn, R, Inc<Idx>, Acc, Self, E, K, W>)
  : Kind extends 'findIndex' ? (Truthy<V> extends true ? Ret<NumV<Idx>, E, K, W> : ItNext<Kind, Fn, R, Inc<Idx>, Acc, Self, E, K, W>)
  : ItNext<Kind, Fn, R, Inc<Idx>,
      Kind extends 'map' ? Push<Acc, V>
      : Kind extends 'filter' ? (Truthy<V> extends true ? Push<Acc, X> : Acc)
      : Kind extends 'reduce' ? V
      : Kind extends 'flatMap' ? Concat<Acc, Spreadable<[V], W>>
      : Acc,
      Self, E, K, W>;

// --- insertion sort driven by a user comparator ---

type SortStart<Cmp, Es, S, A, E, K, W> = Es extends [infer X0, ...infer Rest] ? SortIns<Cmp, [X0], Rest, S, A, E, K, W> : Ret<S, E, K, W>;
type SortIns<Cmp, Sorted, Rest, S, A, E, K, W> =
  Rest extends [infer X, ...infer R] ? SortCmp<Cmp, Sorted, [], X, R, S, A, E, K, W> : Ret<S, E, K, Store<W, A, Sorted>>;
type SortCmp<Cmp, Left, Right extends any[], X, Rest, S, A, E, K, W> =
  Left extends [...any[], infer LL]
    ? Apply<Cmp, undefined, [LL, X], E, [['Sort', Cmp, Left, Right, X, Rest, S, A], K], W>
    : SortIns<Cmp, [X, ...Right], Rest, S, A, E, K, W>;
type SortStep<Cmp, Left, Right extends any[], X, Rest, S, A, V, E, K, W> =
  Left extends [...infer LI, infer LL]
    ? NCmp<ToNum<V, W>, '0'> extends 1
      ? SortCmp<Cmp, LI, [LL, ...Right], X, Rest, S, A, E, K, W>
      : SortIns<Cmp, [...Left, X, ...Right], Rest, S, A, E, K, W>
    : never;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type EvalArgs<Rem, Acc, Then, E, K, W> =
  Rem extends [infer A, ...infer RR]
    ? A extends ['Spread', infer SE] ? ['ev', SE, E, [['ArgsS', RR, Acc, Then], K], W] : ['ev', A, E, [['Args', RR, Acc, Then], K], W]
    : Then extends ['call', infer F, infer This] ? Apply<F, This, Acc, E, K, W>
    : Then extends ['new', infer F] ? Construct<F, Acc, E, K, W>
    : Fin<AllocVW<Acc, W>, E, K, W>;

type ObjNext<Ps, Acc, E, K, W> =
  Ps extends [[infer Key, infer VE], ...infer Rest]
    ? ['ev', VE, E, [['ObjK', Key, Rest, Acc], K], W]
    : Alloc<W, ['O', Acc]> extends [infer A, infer W2] ? ['ret', ['&', A], E, K, W2] : never;

type MkClosure<X, Nm, E, K, W> =
  Nm extends string
    ? Alloc<W, undefined> extends [infer A, infer W2]
      ? Bind<E, Nm, ['c', A]> extends infer CE ? (['fn', X, CE] extends infer C ? ['ret', C, E, K, HSet<W2, A, C>] : never) : never
      : never
    : ['ret', ['fn', X, E], E, K, W];

type BaseOp<Op> = Op extends `${infer B}=` ? B : Op;
type Bump<N, Op> = Op extends '++' ? NAdd<N, '1'> : NSub<N, '1'>;

type Ev<X, E, K, W> =
  X extends ['Lit', infer V] ? ['ret', V, E, K, W]
  : X extends ['Id', infer Nm] ? Fin<Lookup<Nm, E, W>, E, K, W>
  : X extends ['Bin', infer Op, infer A, infer B] ? ['ev', A, E, [['BinR', Op, B], K], W]
  : X extends ['Call', infer C, infer As]
    ? C extends ['Mem', infer O, infer P] ? ['ev', O, E, [['CallM', P, As], K], W]
      : C extends ['Idx', infer O, infer I] ? ['ev', O, E, [['CallI', I, As], K], W]
        : ['ev', C, E, [['CallF', As], K], W]
  : X extends ['Mem', infer O, infer P] ? ['ev', O, E, [['GetP', P], K], W]
  : X extends ['Idx', infer O, infer I] ? ['ev', O, E, [['GetI', I], K], W]
  : X extends ['Asg', infer Op, infer T, infer V]
    ? T extends ['Id', infer Nm]
      ? Op extends '=' ? ['ev', V, E, [['SetV', Nm], K], W]
        : Lookup<Nm, E, W> extends infer Old ? (IsThrow<Old> extends true ? Fin<Old, E, K, W> : BaseOp<Op> extends infer BO ? ['ev', V, E, [['OpSetV', Nm, BO, Old], K], W] : never) : never
      : T extends ['Mem', infer O, infer P] ? ['ev', O, E, [['AsgO', P, Op, V], K], W]
        : T extends ['Idx', infer O, infer I] ? ['ev', O, E, [['AsgI', I, Op, V], K], W]
          : never
  : X extends ['Upd', infer Op, infer Pre, infer T]
    ? T extends ['Id', infer Nm]
      ? Lookup<Nm, E, W> extends infer Old
        ? IsThrow<Old> extends true ? Fin<Old, E, K, W>
          : ToNum<Old, W> extends infer ON
            ? WithEW<SetVar<Nm, NumV<Bump<ON, Op>>, E, W>, Pre extends true ? NumV<Bump<ON, Op>> : NumV<ON>, K>
            : never
        : never
      : T extends ['Mem', infer O, infer P] ? ['ev', O, E, [['UpdP', Op, Pre, P], K], W]
        : T extends ['Idx', infer O, infer I] ? ['ev', O, E, [['UpdI', Op, Pre, I], K], W]
          : never
  : X extends ['Log', infer Op, infer A, infer B] ? ['ev', A, E, [['LogR', Op, B], K], W]
  : X extends ['Cond', infer C, infer A, infer B] ? ['ev', C, E, [['CondK', A, B], K], W]
  : X extends ['Un', infer Op, infer A]
    ? Op extends 'typeof'
      ? A extends ['Id', infer Nm] ? (Lookup<Nm, E, W> extends infer V ? (IsThrow<V> extends true ? ['ret', 'undefined', E, K, W] : Fin<UnOp<'typeof', V, W>, E, K, W>) : never) : ['ev', A, E, [['UnK', Op], K], W]
      : Op extends 'delete'
        ? A extends ['Mem', infer O, infer P] ? ['ev', O, E, [['DelP', P], K], W]
          : A extends ['Idx', infer O, infer I] ? ['ev', O, E, [['DelI', I], K], W]
            : ['ret', true, E, K, W]
        : ['ev', A, E, [['UnK', Op], K], W]
  : X extends ['Fn', infer Nm, ...any[]] ? MkClosure<X, Nm, E, K, W>
  : X extends ['Arr', infer Els] ? EvalArgs<Els, [], ['arr'], E, K, W>
  : X extends ['Obj', infer Ps] ? ObjNext<Ps, [], E, K, W>
  : X extends ['New', infer F, infer As] ? ['ev', F, E, [['NewF', As], K], W]
  : X extends ['OptMem', infer O, infer P] ? ['ev', O, E, [['GetPOpt', P], K], W]
  : X extends ['SeqE', [infer A, ...infer Rest]] ? (Rest extends [] ? ['ev', A, E, K, W] : ['ev', A, E, [['SeqK', Rest], K], W])
  : ['err', 'SyntaxError: unexpected spread', E, K, W];

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

type DeclStep<Ds, E, K, W> =
  Ds extends [[infer Nm, infer Init], ...infer Rest] ? ['ev', Init, E, [['DeclK', Nm, Rest], K], W] : ['ret', undefined, E, K, W];

type ForTest<Nd, E, K, W> =
  Nd extends ['For', any, infer C, any, infer B, any]
    ? C extends null ? ['ex', B, E, [['LB', 'for', Nd], K], W] : ['ev', C, E, [['ForT', Nd], K], W]
    : never;

type Ex<X, E, K, W> =
  X extends ['Expr', infer Ex] ? ['ev', Ex, E, K, W]
  : X extends ['Decl', infer Ds] ? DeclStep<Ds, E, K, W>
  : X extends ['Ret', infer R] ? (R extends null ? ['retfn', undefined, E, K, W] : ['ev', R, E, [['DoRet'], K], W])
  : X extends ['If', infer C, infer A, infer B] ? ['ev', C, E, [['IfK', A, B], K], W]
  : X extends ['Block', infer Ss, infer Ns, infer Fs] ? (EnterScope<Ns, Fs, E, K, W> extends [infer E2, infer K2, infer W2] ? ['ret', undefined, E2, [['Seq', Ss], K2], W2] : never)
  : X extends ['For', infer I, any, any, any, infer Ns]
    ? EnterScope<Ns, [], E, K, W> extends [infer E2, infer K2, infer W2]
      ? I extends null ? ForTest<X, E2, K2, W2> : ['ex', I, E2, [['ForI', X], K2], W2]
      : never
  : X extends ['While', infer C, infer B] ? ['ev', C, E, [['WhileT', C, B], K], W]
  : X extends ['DoWhile', infer B, infer C] ? ['ex', B, E, [['LB', 'do', B, C], K], W]
  : X extends ['ForOf', infer OI, infer Nm, infer It, infer B, infer Ns]
    ? EnterScope<Ns, [], E, K, W> extends [infer E2, infer K2, infer W2] ? ['ev', It, E2, [['ForOfI', OI, Nm, B], K2], W2] : never
  : X extends ['Break'] ? ['brk', undefined, E, K, W]
  : X extends ['Continue'] ? ['cont', undefined, E, K, W]
  : X extends ['Throw', infer T] ? ['ev', T, E, [['DoThrow'], K], W]
  : X extends ['Try', infer B, infer P, infer C, infer F] ? ['ex', B, E, [['TryK', P, C, F], K], W]
  : X extends ['Switch', infer D, infer Cs, infer Ns]
    ? EnterScope<Ns, [], E, K, W> extends [infer E2, infer K2, infer W2] ? ['ev', D, E2, [['SwD', Cs], K2], W2] : never
  : X extends ['Empty'] ? ['ret', undefined, E, K, W]
  : ['err', 'internal: unknown statement', E, K, W];

type ForOfNext<Nm, Items, B, E, K, W> =
  Items extends [infer I, ...infer R]
    ? SetVar<Nm, I, E, W> extends [infer E2, infer W2] ? ['ex', B, E2, [['LB', 'of', Nm, R, B], K], W2] : Fin<SetVar<Nm, I, E, W>, E, K, W>
    : ['ret', undefined, E, K, W];

type SwFind<D, Rem, I extends any[], All, Def, E, K, W> =
  Rem extends [[infer T, any], ...infer RR]
    ? T extends 'default' ? SwFind<D, RR, [...I, 0], All, I['length'], E, K, W>
      : ['ev', T, E, [['SwT', D, RR, [...I, 0], All, Def, I['length']], K], W]
    : Def extends number ? SwRun<All, Def, E, K, W> : ['ret', undefined, E, K, W];
type SwRun<All, Idx, E, K, W> = CaseBodies<Drop<All, Idx>> extends infer Ss ? ['ret', undefined, E, [['Seq', Ss], [['SwB'], K]], W] : never;
type CaseBodies<Cs, Acc extends any[] = []> = Cs extends [[any, infer Ss extends any[]], ...infer R] ? CaseBodies<R, [...Acc, ...Ss]> : Acc;

// ---------------------------------------------------------------------------
// Returning a value to the top frame
// ---------------------------------------------------------------------------

type GetThen<R, Then, E, K, W> = IsThrow<R> extends true ? Fin<R, E, K, W> : Then;

type RetF<F, V, E, K, W> =
  F extends ['Seq', infer Ss] ? (Ss extends [infer S1, ...infer SR] ? ['ex', S1, E, [['Seq', SR], K], W] : ['ret', undefined, E, K, W])
  : F extends ['SeqK', [infer A, ...infer Rest]] ? (Rest extends [] ? ['ev', A, E, K, W] : ['ev', A, E, [['SeqK', Rest], K], W])
  : F extends ['BinR', infer Op, infer B] ? ['ev', B, E, [['BinK', Op, V], K], W]
  : F extends ['BinK', infer Op, infer A] ? Fin<BinOp<Op, A, V, W>, E, K, W>
  : F extends ['Args', infer Rem, infer Acc, infer Then] ? EvalArgs<Rem, Push<Acc, V>, Then, E, K, W>
  : F extends ['CallRet', infer E0] ? ['ret', V, E0, K, W]
  : F extends ['IfK', infer A, infer B] ? (Truthy<V> extends true ? ['ex', A, E, K, W] : B extends null ? ['ret', undefined, E, K, W] : ['ex', B, E, K, W])
  : F extends ['DoRet'] ? ['retfn', V, E, K, W]
  : F extends ['GetP', infer P] ? Fin<GetProp<V, P, W>, E, K, W>
  : F extends ['CallF', infer As] ? EvalArgs<As, [], ['call', V, undefined], E, K, W>
  : F extends ['CallM', infer P, infer As] ? (GetProp<V, P, W> extends infer Fn ? GetThen<Fn, EvalArgs<As, [], ['call', Fn, V], E, K, W>, E, K, W> : never)
  : F extends ['SetV', infer Nm] ? (SetVar<Nm, V, E, W> extends infer R ? GetThen<R, WithEW<R, V, K>, E, K, W> : never)
  : F extends ['LB', infer Kind, ...infer D] ? LoopNext<Kind, D, E, K, W>
  : F extends ['WhileT', infer C, infer B] ? (Truthy<V> extends true ? ['ex', B, E, [['LB', 'while', C, B], K], W] : ['ret', undefined, E, K, W])
  : F extends ['ForT', infer Nd] ? (Truthy<V> extends true ? (Nd extends ['For', any, any, any, infer B, any] ? ['ex', B, E, [['LB', 'for', Nd], K], W] : never) : ['ret', undefined, E, K, W])
  : F extends ['ForU', infer Nd] ? ForTest<Nd, E, K, W>
  : F extends ['ForI', infer Nd] ? ForTest<Nd, E, K, W>
  : F extends ['LogR', infer Op, infer B]
    ? Op extends '&&' ? (Truthy<V> extends true ? ['ev', B, E, K, W] : ['ret', V, E, K, W])
      : Op extends '||' ? (Truthy<V> extends true ? ['ret', V, E, K, W] : ['ev', B, E, K, W])
        : V extends null | undefined ? ['ev', B, E, K, W] : ['ret', V, E, K, W]
  : F extends ['CondK', infer A, infer B] ? ['ev', Truthy<V> extends true ? A : B, E, K, W]
  : F extends ['UnK', infer Op] ? Fin<UnOp<Op, V, W>, E, K, W>
  : F extends ['OpSetV', infer Nm, infer Op, infer Old]
    ? BinOp<Op, Old, V, W> extends infer NV ? (IsThrow<NV> extends true ? Fin<NV, E, K, W> : SetVar<Nm, NV, E, W> extends infer R ? GetThen<R, WithEW<R, NV, K>, E, K, W> : never) : never
  : F extends ['DeclK', infer Nm, infer Rest]
    ? (HasBinding<E, Nm> extends true ? SetVar<Nm, V, E, W> : Declare<Nm, V, E, W>) extends [infer E2, infer W2] ? DeclStep<Rest, E2, K, W2> : never
  : F extends ['Env', infer Ns, infer Prev] ? ['ret', V, DropScope<E, Ns, Prev>, K, W]
  : F extends ['GetI', infer I] ? ['ev', I, E, [['GetI2', V], K], W]
  : F extends ['GetI2', infer O] ? Fin<GetProp<O, PropKey<V, W>, W>, E, K, W>
  : F extends ['CallI', infer I, infer As] ? ['ev', I, E, [['CallI2', V, As], K], W]
  : F extends ['CallI2', infer O, infer As] ? (GetProp<O, PropKey<V, W>, W> extends infer Fn ? GetThen<Fn, EvalArgs<As, [], ['call', Fn, O], E, K, W>, E, K, W> : never)
  : F extends ['ArgsS', infer Rem, infer Acc, infer Then]
    ? Elements<V, W> extends infer Els ? (IsThrow<Els> extends true ? Fin<Els, E, K, W> : EvalArgs<Rem, Concat<Acc, Els>, Then, E, K, W>) : never
  : F extends ['It', infer Kind, infer Fn, infer R, infer Idx extends string, infer Acc, infer X, infer Self] ? ItStep<Kind, Fn, R, Idx, Acc, X, Self, V, E, K, W>
  : F extends ['Sort', infer Cmp, infer L, infer R extends any[], infer X, infer Rest, infer S, infer A] ? SortStep<Cmp, L, R, X, Rest, S, A, V, E, K, W>
  // --- member assignment / update ---
  : F extends ['AsgO', infer P, infer Op, infer VE] ? AsgObj<V, P, Op, VE, E, K, W>
  : F extends ['AsgI', infer I, infer Op, infer VE] ? ['ev', I, E, [['AsgI2', V, Op, VE], K], W]
  : F extends ['AsgI2', infer O, infer Op, infer VE] ? AsgObj<O, PropKey<V, W>, Op, VE, E, K, W>
  : F extends ['AsgSet', infer O, infer P] ? (SetProp<O, P, V, W> extends infer W2 ? GetThen<W2, ['ret', V, E, K, W2], E, K, W> : never)
  : F extends ['AsgOpSet', infer O, infer P, infer Op, infer Old]
    ? BinOp<Op, Old, V, W> extends infer NV
      ? IsThrow<NV> extends true ? Fin<NV, E, K, W> : SetProp<O, P, NV, W> extends infer W2 ? GetThen<W2, ['ret', NV, E, K, W2], E, K, W> : never
      : never
  : F extends ['UpdP', infer Op, infer Pre, infer P] ? UpdObj<V, P, Op, Pre, E, K, W>
  : F extends ['UpdI', infer Op, infer Pre, infer I] ? ['ev', I, E, [['UpdI2', Op, Pre, V], K], W]
  : F extends ['UpdI2', infer Op, infer Pre, infer O] ? UpdObj<O, PropKey<V, W>, Op, Pre, E, K, W>
  : F extends ['DelP', infer P] ? DelProp<V, P, E, K, W>
  : F extends ['DelI', infer I] ? ['ev', I, E, [['DelI2', V], K], W]
  : F extends ['DelI2', infer O] ? DelProp<O, PropKey<V, W>, E, K, W>
  : F extends ['GetPOpt', infer P] ? (V extends null | undefined ? ['ret', undefined, E, K, W] : Fin<GetProp<V, P, W>, E, K, W>)
  // --- objects, new ---
  : F extends ['ObjK', infer Key, infer Rest, infer Acc]
    ? ObjNext<Rest, Key extends null ? MergeEntries<Acc, EntriesOf<V, W>> : PutEntry<Acc, Key, V>, E, K, W>
  : F extends ['NewF', infer As] ? EvalArgs<As, [], ['new', V], E, K, W>
  : F extends ['NewRet', infer O] ? ['ret', V extends ['&', any] ? V : O, E, K, W]
  // --- control flow ---
  : F extends ['DoT', infer B, infer C] ? (Truthy<V> extends true ? ['ex', B, E, [['LB', 'do', B, C], K], W] : ['ret', undefined, E, K, W])
  : F extends ['ForOfI', infer OI, infer Nm, infer B]
    ? (OI extends 'of' ? Elements<V, W> : KeysOf<V, W>) extends infer Items
      ? IsThrow<Items> extends true ? Fin<Items, E, K, W> : ForOfNext<Nm, Items, B, E, K, W>
      : never
  : F extends ['DoThrow'] ? ['throw', V, E, K, W]
  : F extends ['TryK', any, any, infer Fin] ? (Fin extends null ? ['ret', undefined, E, K, W] : ['ex', Fin, E, K, W])
  : F extends ['FinK', infer Fin] ? ['ex', Fin, E, K, W]
  : F extends ['ReThrow', infer V0] ? ['throw', V0, E, K, W]
  : F extends ['SwD', infer Cs] ? SwFind<V, Cs, [], Cs, null, E, K, W>
  : F extends ['SwT', infer D, infer RR, infer I extends any[], infer All, infer Def, infer Idx]
    ? StrictEq<D, V> extends true ? SwRun<All, Idx, E, K, W> : SwFind<D, RR, I, All, Def, E, K, W>
  : F extends ['SwB'] ? ['ret', undefined, E, K, W]
  : F extends ['Main', infer Args] ? (IsCallable<V> extends true ? Apply<V, undefined, Args, E, K, W> : ['ret', V, E, K, W])
  : ['err', 'internal: unknown frame', E, K, W];

type LoopNext<Kind, D, E, K, W> =
  Kind extends 'while' ? (D extends [infer C, infer B] ? ['ev', C, E, [['WhileT', C, B], K], W] : never)
  : Kind extends 'for'
    ? D extends [infer Nd]
      ? Nd extends ['For', any, any, infer U, any, infer Ns]
        ? FreshIteration<Ns, E, W> extends [infer E2, infer W2]
          ? (U extends null ? ForTest<Nd, E2, K, W2> : ['ev', U, E2, [['ForU', Nd], K], W2])
          : never
        : never
      : never
  : Kind extends 'do' ? (D extends [infer B, infer C] ? ['ev', C, E, [['DoT', B, C], K], W] : never)
  : D extends [infer Nm, infer Items, infer B] ? ForOfNext<Nm, Items, B, E, K, W> : never;

/**
 * `for (let i ...)` gets a fresh binding per iteration (closures created in the
 * body keep the value of that iteration): captured loop variables are copied
 * into new heap cells before the update expression runs.
 */
type FreshIteration<Ns, E, W> =
  Ns extends [infer N, ...infer R]
    ? Lookup<N, E, W> extends infer V
      ? (HasBox<E, N> extends true ? Declare<N, V, E, W> : [E, W]) extends [infer E2, infer W2] ? FreshIteration<R, E2, W2> : never
      : never
    : [E, W];
type HasBox<E, N> = E extends [infer Box extends any[], any] ? (N extends Box[number] ? true : false) : false;

type AsgObj<O, P, Op, VE, E, K, W> =
  Op extends '='
    ? ['ev', VE, E, [['AsgSet', O, P], K], W]
    : GetProp<O, P, W> extends infer Old ? (BaseOp<Op> extends infer BO ? GetThen<Old, ['ev', VE, E, [['AsgOpSet', O, P, BO, Old], K], W], E, K, W> : never) : never;

type UpdObj<O, P, Op, Pre, E, K, W> =
  GetProp<O, P, W> extends infer Old
    ? IsThrow<Old> extends true ? Fin<Old, E, K, W>
      : ToNum<Old, W> extends infer ON
        ? SetProp<O, P, NumV<Bump<ON, Op>>, W> extends infer W2
          ? GetThen<W2, ['ret', Pre extends true ? NumV<Bump<ON, Op>> : NumV<ON>, E, K, W2], E, K, W>
          : never
        : never
    : never;

type DelProp<O, P, E, K, W> =
  O extends ['&', infer A]
    ? HGet<W, A> extends ['O', infer Es] ? (DelEntry<Es, P> extends infer Es2 ? ['ret', true, E, K, HSet<W, A, ['O', Es2]>] : never)
      : HGet<W, A> extends ['A', infer Es extends any[]]
        ? IdxOf<P> extends infer I extends number ? ['ret', true, E, K, HSet<W, A, ['A', { [J in keyof Es]: J extends `${I}` ? undefined : Es[J] }]>] : ['ret', true, E, K, W]
        : ['ret', true, E, K, W]
    : ['ret', true, E, K, W];

// ---------------------------------------------------------------------------
// Unwinding (return / break / continue / throw)
// ---------------------------------------------------------------------------

type CatchIt<P, C, Fin, V, E, K, W> =
  C extends null ? ['ex', Fin, E, [['ReThrow', V], K], W]
  : (Fin extends null ? K : [['FinK', Fin], K]) extends infer K1
    ? P extends string
      ? EnterScope<[P], [], E, K1, W> extends [infer E2, infer K2, infer W2]
        ? SetVar<P, V, E2, W2> extends [infer E3, infer W3] ? ['ex', C, E3, K2, W3] : never
        : never
      : ['ex', C, E, K1, W]
    : never;

type Unwind<M, V, E, K, W> =
  K extends [infer F, infer KR]
    ? F extends ['CallRet', infer E0]
      ? M extends 'retfn' ? ['ret', V, E0, KR, W] : M extends 'throw' ? ['throw', V, E0, KR, W] : ['err', `SyntaxError: Illegal ${M extends 'brk' ? 'break' : 'continue'} statement`, E, K, W]
      : F extends ['Env', infer Ns, infer Prev] ? [M, V, DropScope<E, Ns, Prev>, KR, W]
        : F extends ['LB', ...any[]] ? (M extends 'brk' ? ['ret', undefined, E, KR, W] : M extends 'cont' ? ['ret', undefined, E, K, W] : [M, V, E, KR, W])
          : F extends ['SwB'] ? (M extends 'brk' ? ['ret', undefined, E, KR, W] : [M, V, E, KR, W])
            : F extends ['TryK', infer P, infer C, infer Fin] ? (M extends 'throw' ? CatchIt<P, C, Fin, V, E, KR, W> : [M, V, E, KR, W])
              : F extends ['FinK', infer Fin] ? (M extends 'throw' ? ['ex', Fin, E, [['ReThrow', V], KR], W] : [M, V, E, KR, W])
                : [M, V, E, KR, W]
    : M extends 'throw' ? ['uncaught', V, E, K, W] : ['err', 'SyntaxError: Illegal control flow at top level', E, K, W];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type Step<M, X, E, K, W> =
  M extends 'ev' ? Ev<X, E, K, W>
  : M extends 'ret' ? (K extends [infer F, infer KR] ? RetF<F, X, E, KR, W> : ['done', X, E, K, W])
  : M extends 'ex' ? Ex<X, E, K, W>
  : Unwind<M, X, E, K, W>;

type Final = 'done' | 'uncaught' | 'err';

type Run<S, F extends number = 0> =
  S extends [infer M, infer X, infer E, infer K, infer W]
    ? M extends Final ? S
      : F extends 300 ? S
        : Run<Step<M, X, E, K, W>, Nx[F]>
    : S;

/** Up to Rounds x 300 steps; stops early on a final state. */
type Drive<S, Rounds extends number, R extends number = 0> =
  Run<S> extends infer S2
    ? S2 extends [Final, ...any[]] ? S2
      : R extends Rounds ? S2
        : Drive<S2, Rounds, Nx[R]>
    : never;

/** Run to completion (bounded only by the checker's instantiation budget). */
type DriveAll<S> =
  Drive<S, 300> extends infer S2
    ? S2 extends [Final, ...any[]] ? S2 : DriveAll<S2>
    : never;

/**
 * One resumable slice of about 18k steps (~1.5M instantiations). That fits
 * comfortably inside both tsc's per-declaration budget (5M) and bun check's,
 * which runs out at about half of that. Each `type X = Resume<Prev>`
 * declaration gets a fresh budget, so a long computation can be spread across
 * declarations with no overall limit.
 */
export type RunSlice<S> = S extends [Final, ...any[]] ? S : Drive<S, 60>;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export type EvalError<M extends string> = { readonly error: M };

type InitStore = [[], []];

export type Boot<Ast, Args> =
  FromTSArgs<Args, InitStore> extends [infer Vals, infer W]
    ? ['ev', Ast, [[], []], [['Main', Vals], []], W]
    : ['err', FromTSArgs<Args, InitStore> extends ['!throw', any, infer M] ? M : 'bad arguments', {}, [], InitStore];
type FromTSArgs<Args, W, Acc extends any[] = []> =
  Args extends [infer H, ...infer R]
    ? FromTS<H, W> extends [infer V, infer W2] ? FromTSArgs<R, W2, [...Acc, V]> : FromTS<H, W>
    : [Acc, W];

export type Execute<Ast, Args> = DriveAll<Boot<Ast, Args>>;

export type Outcome<S> =
  S extends ['done', infer V, any, any, infer W] ? { result: ToTS<V, W>; logs: W extends [any, infer L] ? L : [] }
  : S extends ['uncaught', infer V, any, any, infer W] ? { result: EvalError<`Uncaught ${ToStr<V, W>}`>; logs: W extends [any, infer L] ? L : [] }
  : S extends ['err', infer M extends string, ...any[]] ? { result: EvalError<M>; logs: [] }
  : { result: EvalError<'Still running: continue with Resume<...>'>; logs: [] };

// --- debugging aid: run exactly N steps ---
type RunN<S, N, F extends number = 0> =
  F extends N ? S
  : S extends [infer M, infer X, infer E, infer K, infer W] ? (M extends Final ? S : RunN<Step<M, X, E, K, W>, N, Nx[F]>) : S;
export type DebugSteps<Ast, Args, N> = RunN<Boot<Ast, Args>, N>;
