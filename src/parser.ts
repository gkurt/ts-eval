/**
 * Parser: token list -> AST.
 *
 * A recursive-descent parser would blow through TypeScript's instantiation
 * depth limit almost immediately, so this is a *continuation-passing state
 * machine*: every step is a flat transition
 *
 *     [mode, tokens, frames, registers]  ->  [mode', tokens', frames', registers']
 *
 * where `frames` is an explicit stack of "what to do with the node I'm about
 * to produce". Expressions use precedence climbing (Pratt), statements push
 * frames for each syntactic hole.
 *
 * The registers also perform scope analysis while parsing:
 *   v  var-declared names of the current function (hoisted)
 *   s  let/const/function names of the current block
 *   f  function declarations of the current block (hoisted & initialised)
 *   u  identifiers used in the current function
 *   d  identifiers declared anywhere in the current function
 *   c  identifiers captured by nested closures  -> those get heap cells,
 *      everything else lives directly in the (immutable) environment.
 *
 * AST (tuples):
 *   Expr  ['Lit', v] ['Id', n] ['Bin', op, l, r] ['Log', op, l, r] ['Un', op, e]
 *         ['Upd', op, prefix, target] ['Asg', op, target, e] ['Cond', c, a, b]
 *         ['Call', f, args] ['New', f, args] ['Mem', o, name] ['OptMem', o, name]
 *         ['Idx', o, e] ['Arr', elems] ['Obj', [key|null, e][]] ['Spread', e]
 *         ['Fn', name, params, rest, body, hoisted, funcs, boxed, isArrow]
 *   Stmt  ['Expr', e] ['Decl', [name, e][]] ['Ret', e|null] ['If', c, a, b|null]
 *         ['Block', stmts, names, funcs] ['While', c, b] ['DoWhile', b, c]
 *         ['For', init, test, update, body, names] ['ForOf', 'of'|'in', name, e, body, names]
 *         ['Break'] ['Continue'] ['Throw', e] ['Try', block, param, catch, finally]
 *         ['Switch', e, [test|'default', stmts][], names] ['Empty']
 */
import type { Keyword } from './lexer';
import type { AddSet, Concat, Dedup, Minus, Nx, Push, Union } from './util';

/** Registers as a tuple [v, s, f, u, d, c] (tuples stay concrete; see runtime.ts). */
type G0 = [[], [], [], [], [], []];
type RegIdx = { v: '0'; s: '1'; f: '2'; u: '3'; d: '4'; c: '5' };
export type ParseError<M extends string> = ['!err', `SyntaxError: ${M}`];

type TokStr<T> =
  T extends [infer H, any] ? (H extends ['id', infer N extends string] ? N
    : H extends ['num', infer N extends string] ? N
      : H extends ['str', infer S extends string] ? `"${S}"`
        : H extends string ? H : '?')
  : 'end of input';
type Unexpected<T, Ctx extends string = ''> = ParseError<`Unexpected token ${TokStr<T>}${Ctx}`>;

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

type Reg<G, K extends keyof RegIdx> = RegIdx[K] extends keyof G ? G[RegIdx[K]] : never;
type SetReg<G, K extends keyof RegIdx, V> = { [I in keyof G]: I extends RegIdx[K] ? V : G[I] };
type Use<G, N> = SetReg<G, 'u', AddSet<Reg<G, 'u'>, N>>;
type DeclareName<G, Kind, N> =
  Kind extends 'var'
    ? SetReg<SetReg<G, 'v', AddSet<Reg<G, 'v'>, N>>, 'd', AddSet<Reg<G, 'd'>, N>>
    : SetReg<SetReg<G, 's', AddSet<Reg<G, 's'>, N>>, 'd', AddSet<Reg<G, 'd'>, N>>;
type ResetBlock<G> = SetReg<SetReg<G, 's', []>, 'f', []>;
type RestoreBlock<G, S, F> = SetReg<SetReg<G, 's', S>, 'f', F>;

// ---------------------------------------------------------------------------
// Operator tables
// ---------------------------------------------------------------------------

type BinPrec = {
  ',': 1; '??': 4; '||': 4; '&&': 5; '|': 6; '^': 7; '&': 8;
  '==': 9; '!=': 9; '===': 9; '!==': 9;
  '<': 10; '>': 10; '<=': 10; '>=': 10; 'instanceof': 10; 'in': 10;
  '<<': 11; '>>': 11; '>>>': 11; '+': 12; '-': 12; '*': 13; '/': 13; '%': 13; '**': 14;
};
type PrecTup = [[], [0], [0, 0], [0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
type PT<N> = N extends number ? PrecTup[N] : [];
type Ge<A, B> = PT<A> extends [...PT<B>, ...any[]] ? true : false;
type NextPrec = { 1: 2; 4: 5; 5: 6; 6: 7; 7: 8; 8: 9; 9: 10; 10: 11; 11: 12; 12: 13; 13: 14; 14: 14 };
type RhsPrec<Op extends keyof BinPrec> = Op extends '**' ? 14 : BinPrec[Op] extends keyof NextPrec ? NextPrec[BinPrec[Op]] : 15;

type AsgOps = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '**=' | '<<=' | '>>=' | '>>>=' | '&=' | '|=' | '^=' | '&&=' | '||=' | '??=';
type UnOps = '-' | '+' | '!' | '~' | 'typeof' | 'void' | 'delete';

type MkBin<Op, L, R> =
  Op extends ',' ? (L extends ['SeqE', infer Xs extends any[]] ? ['SeqE', [...Xs, R]] : ['SeqE', [L, R]])
  : Op extends '&&' | '||' | '??' ? ['Log', Op, L, R] : ['Bin', Op, L, R];
type MkAsg<Op, T, V> =
  Op extends `${infer B extends '&&' | '||' | '??'}=` ? ['Log', B, T, ['Asg', '=', T, V]] : ['Asg', Op, T, V];

type PropName<P> = P extends ['id', infer N] ? N : P extends Keyword ? P : false;
type PropKey<P> = P extends ['id', infer N] ? N : P extends ['str', infer S] ? S : P extends ['num', infer N] ? N : P extends Keyword ? P : false;
type SkipSemi<T> = T extends [';', infer R] ? R : T;

/** After '(' : does the matching ')' precede '=>'? */
type IsArrow<T, D extends any[] = []> =
  T extends [infer H, infer R]
    ? H extends '(' ? IsArrow<R, [...D, 0]>
      : H extends ')' ? (D extends [any, ...infer D2] ? IsArrow<R, D2> : R extends ['=>', any] ? true : false)
        : IsArrow<R, D>
    : false;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type PUnary<T, K, G> =
  T extends [infer H, infer R]
    ? H extends UnOps ? [['U'], R, [['Un', H], K], G]
      : H extends '++' | '--' ? [['U'], R, [['PreUpd', H], K], G]
        : H extends 'new' ? [['P'], R, [['NewP'], K], G]
          : [['P'], T, K, G]
    : Unexpected<T>;

type Lit<V, R, K, G> = [['Post', ['Lit', V]], R, K, G];

type PPrimary<T, K, G> =
  T extends [infer H, infer R]
    ? H extends ['num', infer V] ? Lit<['#', V], R, K, G>
      : H extends ['str', infer V] ? Lit<V, R, K, G>
        : H extends ['id', infer N]
          ? R extends ['=>', infer R2] ? StartFn<null, [N], null, [], 'arrow', R2, K, G> : [['Post', ['Id', N]], R, K, Use<G, N>]
          : H extends 'true' ? Lit<true, R, K, G>
            : H extends 'false' ? Lit<false, R, K, G>
              : H extends 'null' ? Lit<null, R, K, G>
                : H extends 'undefined' ? Lit<undefined, R, K, G>
                  : H extends 'this' ? [['Post', ['Id', 'this']], R, K, G]
                    : H extends '('
                      ? IsArrow<R> extends true ? [['Params', null, [], 'arrow', [], null], R, K, G] : [['E', 0], R, [['Paren'], K], G]
                      : H extends '[' ? (R extends [']', infer R2] ? [['Post', ['Arr', []]], R2, K, G] : [['Arg'], R, [['ArrEl', []], K], G])
                        : H extends '{' ? [['Prop', []], R, K, G]
                          : H extends 'function'
                            ? R extends [['id', infer N], ['(', infer R2]] ? [['Params', N, [], 'expr', [], null], R2, K, G]
                              : R extends ['(', infer R2] ? [['Params', null, [], 'expr', [], null], R2, K, G]
                                : Unexpected<R, ' after function'>
                            : Unexpected<T>
    : ParseError<'Unexpected end of input'>;

type PPost<N, T, K, G> =
  K extends [['NewP'], infer KR]
    // `new X.y[z](args)`: member accesses bind tighter than `new`; the first call supplies its arguments
    ? T extends ['(', infer R]
      ? R extends [')', infer R2] ? [['Post', ['New', N, []]], R2, KR, G] : [['Arg'], R, [['CallA', N, [], 'New'], KR], G]
      : T extends ['.' | '[', any] ? PPostMember<N, T, K, G> : [['Post', ['New', N, []]], T, KR, G]
    : T extends ['(', infer R]
      ? R extends [')', infer R2] ? [['Post', ['Call', N, []]], R2, K, G] : [['Arg'], R, [['CallA', N, [], 'Call'], K], G]
      : T extends ['.' | '?.' | '[', any] ? PPostMember<N, T, K, G>
        : T extends [infer Op extends '++' | '--', infer R] ? [['R', ['Upd', Op, false, N]], R, K, G]
          : [['R', N], T, K, G];

type PPostMember<N, T, K, G> =
  T extends ['.', [infer P, infer R]]
    ? PropName<P> extends infer Nm extends string ? [['Post', ['Mem', N, Nm]], R, K, G] : Unexpected<[P, R], ' after .'>
    : T extends ['?.', [infer P, infer R]]
      ? PropName<P> extends infer Nm extends string ? [['Post', ['OptMem', N, Nm]], R, K, G] : Unexpected<[P, R], ' after ?.'>
      : T extends ['[', infer R] ? [['E', 0], R, [['Idx', N], K], G]
        : never;

type BinLoop<N, P, T, K, G> =
  T extends [infer Op, infer R]
    ? Op extends keyof BinPrec
      ? Ge<BinPrec[Op], P> extends true ? [['E', RhsPrec<Op>], R, [['BinR', P, Op, N], K], G] : [['R', N], T, K, G]
      : Op extends '?'
        ? Ge<3, P> extends true ? [['E', 2], R, [['Tern1', P, N], K], G] : [['R', N], T, K, G]
        : Op extends AsgOps
          ? Ge<2, P> extends true
            ? N extends ['Id', any] | ['Mem', any, any] | ['Idx', any, any] ? [['E', 2], R, [['Asg', P, Op, N], K], G]
              : Op extends '=' ? (ExprToPat<N> extends infer Pat ? (Pat extends false ? ParseError<'Invalid assignment target'> : [['E', 2], R, [['AsgPat', P, Pat], K], G]) : never)
                : ParseError<'Invalid assignment target'>
            : [['R', N], T, K, G]
          : [['R', N], T, K, G]
    : [['R', N], T, K, G];

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

type NonNull<L> = L extends [infer H, ...infer R] ? (H extends null ? NonNull<R> : [H, ...NonNull<R>]) : [];

type StartFn<Nm, Ps, Rest, Defs, Kind, T, K, G> =
  [['FnEnd', Nm, Ps, Rest, Defs, Kind, G], K] extends infer K2
    ? (PatNames<Defs> extends infer PN ? (Concat<NonNull<Concat<[Kind extends 'expr' ? Nm : null, Rest], Ps>>, PN> extends infer D ? [PN, [], [], [], D, []] : never) : never) extends infer G2
      ? T extends ['{', infer R] ? [['SL', []], R, K2, G2]
        : Kind extends 'arrow' ? [['E', 2], T, [['ArrowRet'], K2], G2]
          : Unexpected<T, ', expected { to start function body'>
      : never
    : never;

type PParams<Nm, Ps, Kind, Defs, Rest, T, K, G> =
  T extends [')', infer R]
    ? Kind extends 'arrow'
      ? R extends ['=>', infer R2] ? StartFn<Nm, Ps, Rest, Defs, Kind, R2, K, G> : Unexpected<R, ', expected =>'>
      : StartFn<Nm, Ps, Rest, Defs, Kind, R, K, G>
    : T extends [',', infer R] ? [['Params', Nm, Ps, Kind, Defs, Rest], R, K, G]
      : T extends ['[' | '{', any] ? [['Pat'], T, [['ParamPat', Nm, Ps, Kind, Defs, Rest], K], G]
      : T extends ['...', [['id', infer P], infer R]] ? [['Params', Nm, Ps, Kind, Defs, P], R, K, G]
        : T extends [['id', infer P], ['=', infer R]] ? (Push<Ps, P> extends infer Ps2 ? [['E', 2], R, [['ParamDef', Nm, Ps2, Kind, Defs, Rest, P], K], G] : never)
          : T extends [['id', infer P], infer R extends [',' | ')', any]] ? [['Params', Nm, Push<Ps, P>, Kind, Defs, Rest], R, K, G]
            : Unexpected<T, ' in parameter list'>;

/**
 * `function f(a = 1)` becomes `if (a === undefined) a = 1;` at the top of the body,
 * and a destructured parameter becomes a declaration from its temporary.
 */
type DefStmts<Defs> =
  Defs extends [['%pat', infer Ps], ...infer R] ? [['Decl', Ps], ...DefStmts<R>]
  : Defs extends [[infer P, infer D], ...infer R]
    ? [['If', ['Bin', '===', ['Id', P], ['Lit', undefined]], ['Expr', ['Asg', '=', ['Id', P], D]], null], ...DefStmts<R>]
    : [];
type PatNames<Defs, Acc extends any[] = []> =
  Defs extends [infer D, ...infer R] ? PatNames<R, D extends ['%pat', infer Ps] ? Concat<Acc, Targets<Ps>> : Acc> : Acc;

type FnNode<Nm, Ps, Rest, Body, Hoist, Fs, Box, Arrow> =
  [Nm, Body, Hoist, Arrow] extends [infer N, infer B, infer H, infer A] ? ['Fn', N, Ps, Rest, B, H, Fs, Box, A] : never;

type FinishFn<Nm, Ps, Rest, Defs, Kind, Saved, Body, T, K, G> =
  G extends [infer V extends any[], infer S extends any[], infer Fs, infer U, infer D, infer C]
    ? Minus<U, D> extends infer Free
      ? FnNode<Kind extends 'expr' ? Nm : null, Ps, Rest, Concat<DefStmts<Defs>, Body>, Dedup<[...V, ...S]>, Fs, C, Kind extends 'arrow' ? true : false> extends infer Node
        ? SetReg<SetReg<Saved, 'u', Union<Reg<Saved, 'u'>, Free>>, 'c', Union<Reg<Saved, 'c'>, Free>> extends infer G2
          ? Kind extends 'decl'
            ? [['R', ['Empty']], T, K, SetReg<DeclareName<G2, 'let', Nm>, 'f', Push<Reg<G2, 'f'>, [Nm, Node]>>]
            : Kind extends 'expr' ? [['Post', Node], T, K, G2] : [['R', Node], T, K, G2]
          : never
        : never
      : never
    : never;

// ---------------------------------------------------------------------------
// Object literals
// ---------------------------------------------------------------------------

type PProp<Ps, T, K, G> =
  T extends ['}', infer R] ? [['Post', ['Obj', Ps]], R, K, G]
    : T extends ['...', infer R] ? [['E', 2], R, [['ObjV', Ps, null], K], G]
      : T extends [infer KT, infer R]
        ? PropKey<KT> extends infer Key extends string
          ? R extends [':', infer R2] ? [['E', 2], R2, [['ObjV', Ps, Key], K], G]
            : R extends ['(', infer R2] ? [['Params', null, [], 'method', [], null], R2, [['ObjV', Ps, Key], K], G]
              : KT extends ['id', infer Nm]
                ? Push<Ps, [Key, ['Id', Nm]]> extends infer P2
                  ? R extends [',', infer R2] ? [['Prop', P2], R2, K, Use<G, Nm>]
                    : R extends ['}', infer R2] ? [['Post', ['Obj', P2]], R2, K, Use<G, Nm>]
                      : Unexpected<R, ' in object literal'>
                  : never
                : Unexpected<R, ' in object literal'>
          : Unexpected<T, ' in object literal'>
        : ParseError<'Unexpected end of input in object literal'>;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

type PStmt<T, K, G> = G extends [any, infer S0, infer F0, ...any[]] ? PStmtWith<T, K, G, ['RestoreScope', S0, F0]> : never;
type PStmtWith<T, K, G, Restore> =
  T extends [infer H, infer R]
    ? H extends '{' ? [['SL', []], R, [['BlockEnd'], [Restore, K]], ResetBlock<G>]
      : H extends 'var' | 'let' | 'const' ? [['Decl', H, []], R, [['Semi'], K], G]
        : H extends 'if' ? (R extends ['(', infer R2] ? [['E', 0], R2, [['If1'], K], G] : Unexpected<R, ' after if'>)
          : H extends 'while' ? (R extends ['(', infer R2] ? [['E', 0], R2, [['W1'], K], G] : Unexpected<R, ' after while'>)
            : H extends 'do' ? [['S'], R, [['Do1'], K], G]
              : H extends 'for' ? (R extends ['(', infer R2] ? PFor<R2, [Restore, K], ResetBlock<G>> : Unexpected<R, ' after for'>)
                : H extends 'return'
                  ? R extends [';', infer R2] ? [['R', ['Ret', null]], R2, K, G]
                    : R extends ['}', any] | [] ? [['R', ['Ret', null]], R, K, G]
                      : [['E', 0], R, [['RetE'], [['Semi'], K]], G]
                  : H extends 'break' ? [['R', ['Break']], SkipSemi<R>, K, G]
                    : H extends 'continue' ? [['R', ['Continue']], SkipSemi<R>, K, G]
                      : H extends 'throw' ? [['E', 0], R, [['ThrowE'], [['Semi'], K]], G]
                        : H extends 'try' ? (R extends ['{', any] ? [['S'], R, [['Try1'], K], G] : Unexpected<R, ' after try'>)
                          : H extends 'switch'
                            ? R extends ['(', infer R2] ? [['E', 0], R2, [['Sw1'], [Restore, K]], ResetBlock<G>] : Unexpected<R, ' after switch'>
                            : H extends 'function'
                              ? R extends [['id', infer Nm], ['(', infer R2]] ? [['Params', Nm, [], 'decl', [], null], R2, K, G] : Unexpected<R, ' after function'>
                              : H extends ';' ? [['R', ['Empty']], R, K, G]
                                : [['E', 0], T, [['ExprS'], [['Semi'], K]], G]
    : ParseError<'Unexpected end of input'>;

type PDecl<Kind, Ds, T, K, G> =
  T extends ['[' | '{', any] ? [['Pat'], T, [['DeclPat', Kind, Ds], K], G]
  : T extends [['id', infer Nm], infer R]
    ? DeclareName<G, Kind, Nm> extends infer G2
      ? R extends ['=', infer R2] ? [['E', 2], R2, [['DeclI', Kind, Ds, Nm], K], G2]
        : DeclNext<Kind, Kind extends 'var' ? Ds : Push<Ds, [Nm, ['Lit', undefined]]>, R, K, G2>
      : never
    : Unexpected<T, ' in declaration'>;
type DeclNext<Kind, Ds, T, K, G> = T extends [',', infer R] ? [['Decl', Kind, Ds], R, K, G] : [['R', ['Decl', Ds]], T, K, G];

type PFor<T, K, G> =
  T extends [infer Kw extends 'var' | 'let' | 'const', infer R extends ['[' | '{', any]] ? [['Pat'], R, [['ForPat', Kw], K], G] :
  T extends [infer Kw extends 'var' | 'let' | 'const', [['id', infer N], [infer OI extends 'of' | 'in', infer R]]]
    ? [['E', 0], R, [['ForOf1', OI, N], K], DeclareName<G, Kw, N>]
    : T extends [['id', infer N], [infer OI extends 'of' | 'in', infer R]] ? [['E', 0], R, [['ForOf1', OI, N], K], Use<G, N>]
      : T extends [';', any] ? [['R', null], T, [['For1'], K], G]
        : T extends [infer Kw extends 'var' | 'let' | 'const', infer R] ? [['Decl', Kw, []], R, [['For1'], K], G]
          : [['E', 0], T, [['ExprS'], [['For1'], K]], G];

type PCases<D, Cs, T, K, G> =
  T extends ['}', infer R] ? (Reg<G, 's'> extends infer S ? [['R', ['Switch', D, Cs, S]], R, K, G] : never)
    : T extends ['case', infer R] ? [['E', 0], R, [['SwCase', D, Cs], K], G]
      : T extends ['default', [':', infer R]] ? [['CaseBody', D, Cs, 'default', []], R, K, G]
        : Unexpected<T, ' in switch'>;
type PCaseBody<D, Cs, Tst, Ss, T, K, G> =
  T extends ['case' | 'default' | '}', any] ? [['Cases', D, Push<Cs, [Tst, Ss]>], T, K, G]
    : [['S'], T, [['CaseS', D, Cs, Tst, Ss], K], G];

// ---------------------------------------------------------------------------
// Destructuring patterns
// ---------------------------------------------------------------------------
//
//   ['PId', name] | ['PExpr', target] | ['PDef', pat, default] | ['PRest', pat]
//   ['PArr', (pat | null)[]] | ['PObj', ([key, pat] | ['PRest', pat])[]]
//
// Patterns never reach the evaluator: Desugar flattens one into [target, expr]
// pairs, holding intermediate values in temporaries '%0', '%1', ...
//   const [a, { b = 1 }] = f()   ~>   %0 = f(), a = %0[0], %1 = %0[1], b = %1.b === undefined ? 1 : %1.b

type Temp<N extends any[]> = `%${N['length']}`;
type IdxLit<I extends any[]> = `${I['length']}` extends infer S ? ['Lit', ['#', S]] : never;

/** -> [pairs, temp counter] */
type Desugar<P, Init, N extends any[] = []> =
  P extends ['PId', infer Nm] ? [[[Nm, Init]], N]
  : P extends ['PExpr', infer X] ? [[[X, Init]], N]
  : P extends ['PDef', infer Q, infer D] ? Desugar<Q, ['Cond', ['Bin', '===', Init, ['Lit', undefined]], D, Init], N>
  : P extends ['PArr', infer Els] ? (Temp<N> extends infer T ? DesugarEls<Els, T, [...N, 0], [[T, Init]], []> : never)
  : P extends ['PObj', infer Ps] ? (Temp<N> extends infer T ? DesugarProps<Ps, T, [...N, 0], [[T, Init]], []> : never)
  : [[], N];

type DesugarEls<Els, T, N extends any[], Acc extends any[], I extends 0[]> =
  Els extends [infer El, ...infer R]
    ? El extends null ? DesugarEls<R, T, N, Acc, [...I, 0]>
      : (IdxLit<I> extends infer At
          ? El extends ['PRest', infer Q]
            ? Desugar<Q, ['Call', ['Mem', ['Id', T], 'slice'], [At]], N>
            : Desugar<El, ['Idx', ['Id', T], At], N>
          : never) extends [infer Ps extends any[], infer N2 extends any[]]
        ? DesugarEls<R, T, N2, [...Acc, ...Ps], [...I, 0]>
        : never
    : [Acc, N];

type KeyLits<Keys> = { [I in keyof Keys]: ['Lit', Keys[I]] };
type DesugarProps<Ps, T, N extends any[], Acc extends any[], Keys extends any[]> =
  Ps extends [infer Pr, ...infer R]
    ? Pr extends ['PRest', infer Q]
      ? Desugar<Q, ['Call', ['Lit', ['bi', '%omit']], [['Id', T], ...KeyLits<Keys>]], N> extends [infer Ps2 extends any[], infer N2 extends any[]]
        ? DesugarProps<R, T, N2, [...Acc, ...Ps2], Keys>
        : never
      : Pr extends [infer Key, infer Q]
        ? Desugar<Q, ['Mem', ['Id', T], Key], N> extends [infer Ps2 extends any[], infer N2 extends any[]]
          ? DesugarProps<R, T, N2, [...Acc, ...Ps2], [...Keys, Key]>
          : never
        : never
    : [Acc, N];

type Pairs<P, Init> = Desugar<P, Init>[0];
type Targets<Ps> = { [I in keyof Ps]: Ps[I] extends [infer T, any] ? T : never };
type DeclareAll<G, Kind, Ns> = Ns extends [infer N, ...infer R] ? DeclareAll<DeclareName<G, Kind, N>, Kind, R> : G;
type TempsOf<Ns, Acc extends any[] = []> = Ns extends [infer N, ...infer R] ? TempsOf<R, N extends `%${string}` ? [...Acc, N] : Acc> : Acc;

/** An array/object literal on the left of `=` is reinterpreted as a pattern. */
type ExprToPat<X> =
  X extends ['Id', infer N] ? ['PId', N]
  : X extends ['Mem', any, any] | ['Idx', any, any] ? ['PExpr', X]
  : X extends ['Asg', '=', infer T, infer D] ? (ExprToPat<T> extends infer P ? (P extends false ? false : ['PDef', P, D]) : never)
  : X extends ['Arr', infer Els] ? ElsToPat<Els>
  : X extends ['Obj', infer Ps] ? PropsToPat<Ps>
  : false;
type ElsToPat<Els, Acc extends any[] = []> =
  Els extends [infer E, ...infer R]
    ? (E extends ['Spread', infer X] ? (ExprToPat<X> extends infer P ? (P extends false ? false : ['PRest', P]) : never) : ExprToPat<E>) extends infer P
      ? P extends false ? false : ElsToPat<R, [...Acc, P]>
      : never
    : ['PArr', Acc];
type PropsToPat<Ps, Acc extends any[] = []> =
  Ps extends [[infer Key, infer V], ...infer R]
    ? (Key extends null ? (ExprToPat<V> extends infer P ? (P extends false ? false : ['PRest', P]) : never) : (ExprToPat<V> extends infer P ? (P extends false ? false : [Key, P]) : never)) extends infer P
      ? P extends false ? false : PropsToPat<R, [...Acc, P]>
      : never
    : ['PObj', Acc];

/** pairs -> assignment expressions evaluated left to right, yielding the right-hand side. */
type PairsToSeq<Ps, Acc extends any[] = []> =
  Ps extends [[infer T, infer X], ...infer R]
    ? (T extends string ? ['Id', T] : T) extends infer Tgt ? PairsToSeq<R, [...Acc, ['Asg', '=', Tgt, X]]> : never
    : Acc;

type PPat<T, K, G> =
  T extends [['id', infer Nm], infer R] ? [['R', ['PId', Nm]], R, K, G]
  : T extends ['[', infer R] ? [['PArrEl', []], R, K, G]
  : T extends ['{', infer R] ? [['PObjProp', []], R, K, G]
  : Unexpected<T, ' in destructuring pattern'>;

type PArrEl<Els, T, K, G> =
  T extends [']', infer R] ? [['R', ['PArr', Els]], R, K, G]
  : T extends [',', infer R] ? [['PArrEl', Push<Els, null>], R, K, G]
  : T extends ['...', infer R] ? [['Pat'], R, [['PArrRest', Els], K], G]
  : [['Pat'], T, [['PArrE', Els], K], G];
type PArrNext<Els, T, K, G> =
  T extends [',', infer R] ? [['PArrEl', Els], R, K, G]
  : T extends [']', infer R] ? [['R', ['PArr', Els]], R, K, G]
  : Unexpected<T, ' in array pattern'>;

type PObjProp<Ps, T, K, G> =
  T extends ['}', infer R] ? [['R', ['PObj', Ps]], R, K, G]
  : T extends ['...', [['id', infer Nm], infer R]] ? PObjNext<Push<Ps, ['PRest', ['PId', Nm]]>, R, K, G>
  : T extends [infer KT, infer R]
    ? PropKey<KT> extends infer Key extends string
      ? R extends [':', infer R2] ? [['Pat'], R2, [['PObjV', Ps, Key], K], G]
        : KT extends ['id', infer Nm]
          ? R extends ['=', infer R2] ? [['E', 2], R2, [['PObjDef', Ps, Key, ['PId', Nm]], K], G] : PObjNext<Push<Ps, [Key, ['PId', Nm]]>, R, K, G>
          : Unexpected<R, ' in object pattern'>
      : Unexpected<T, ' in object pattern'>
    : ParseError<'Unexpected end of input in object pattern'>;
type PObjNext<Ps, T, K, G> =
  T extends [',', infer R] ? [['PObjProp', Ps], R, K, G]
  : T extends ['}', infer R] ? [['R', ['PObj', Ps]], R, K, G]
  : Unexpected<T, ' in object pattern'>;

/** Frames that receive a parsed pattern (or a default value inside one). */
type PRetPat<F, N, T, K, G> =
  F extends ['PArrE', infer Els] ? (T extends ['=', infer R] ? [['E', 2], R, [['PArrDef', Els, N], K], G] : PArrNext<Push<Els, N>, T, K, G>)
  : F extends ['PArrDef', infer Els, infer P] ? PArrNext<Push<Els, ['PDef', P, N]>, T, K, G>
  : F extends ['PArrRest', infer Els] ? PArrNext<Push<Els, ['PRest', N]>, T, K, G>
  : F extends ['PObjV', infer Ps, infer Key] ? (T extends ['=', infer R] ? [['E', 2], R, [['PObjDef', Ps, Key, N], K], G] : PObjNext<Push<Ps, [Key, N]>, T, K, G>)
  : F extends ['PObjDef', infer Ps, infer Key, infer P] ? PObjNext<Push<Ps, [Key, ['PDef', P, N]]>, T, K, G>
  // const [a, b] = init
  : F extends ['DeclPat', infer Kind, infer Ds] ? (T extends ['=', infer R] ? [['E', 2], R, [['DeclPatI', Kind, Ds, N], K], G] : ParseError<'Missing initializer in destructuring declaration'>)
  : F extends ['DeclPatI', infer Kind, infer Ds, infer P]
    ? Pairs<P, N> extends infer Ps ? DeclNext<Kind, Concat<Ds, Ps>, T, K, DeclareAll<G, Kind, Targets<Ps>>> : never
  // function f({ a, b } = {}) — the parameter becomes a temporary, destructured at the top of the body
  : F extends ['ParamPat', infer Nm, infer Ps extends any[], infer Kind, infer Defs, infer Rest]
    ? `%p${Ps['length']}` extends infer Tmp
      ? T extends ['=', infer R]
        ? (Push<Ps, Tmp> extends infer Ps2 ? [['E', 2], R, [['ParamPatDef', Nm, Ps2, Kind, Defs, Rest, Tmp, N], K], G] : never)
        : [['Params', Nm, Push<Ps, Tmp>, Kind, Push<Defs, ['%pat', Pairs<N, ['Id', Tmp]>]>, Rest], T, K, G]
      : never
  : F extends ['ParamPatDef', infer Nm, infer Ps, infer Kind, infer Defs, infer Rest, infer Tmp, infer P]
    ? [['Params', Nm, Ps, Kind, Concat<Defs, [[Tmp, N], ['%pat', Pairs<P, ['Id', Tmp]>]]>, Rest], T, K, G]
  // for (const [k, v] of xs)
  : F extends ['ForPat', infer Kw]
    ? T extends [infer OI extends 'of' | 'in', infer R]
      ? Pairs<N, ['Id', '%f']> extends infer Ps
        ? [['E', 0], R, [['ForOf1', OI, '%f', Ps], K], SetReg<DeclareName<G, Kw, '%f'>, 'd', Union<Reg<G, 'd'>, Targets<Ps>>>]
        : never
      : Unexpected<T, ', expected of or in'>
  // [a, b] = [b, a]
  : F extends ['AsgPat', infer P, infer Pat]
    ? Pairs<Pat, N> extends [[infer T0, any], ...any[]] & infer Ps
      ? PairsToSeq<Ps> extends infer Xs extends any[]
        ? [['R', ['SeqE', [...Xs, ['Id', T0]]]], T, [['Bin', P], K], DeclareAll<G, 'var', TempsOf<Targets<Ps>>>]
        : never
      : never
  : ParseError<'internal: unknown parser frame'>;

// ---------------------------------------------------------------------------
// Returning a node to the frame on top of the stack
// ---------------------------------------------------------------------------

type Expect<T, Tok, Next, Ctx extends string> = T extends [Tok, infer R] ? (Next extends [infer M, infer K, infer G] ? [M, R, K, G] : never) : Unexpected<T, Ctx>;

type PRet<F, N, T, K, G> =
  F extends ['Bin', infer P] ? BinLoop<N, P, T, K, G>
  : F extends ['BinR', infer P, infer Op, infer L] ? [['R', MkBin<Op, L, N>], T, [['Bin', P], K], G]
  : F extends ['Un', infer Op] ? [['R', ['Un', Op, N]], T, K, G]
  : F extends ['PreUpd', infer Op] ? [['R', ['Upd', Op, true, N]], T, K, G]
  : F extends ['Tern1', infer P, infer C] ? Expect<T, ':', [['E', 2], [['Tern2', P, C, N], K], G], ', expected :'>
  : F extends ['Tern2', infer P, infer C, infer A] ? [['R', ['Cond', C, A, N]], T, [['Bin', P], K], G]
  : F extends ['Asg', infer P, infer Op, infer L] ? [['R', MkAsg<Op, L, N>], T, [['Bin', P], K], G]
  : F extends ['Paren'] ? Expect<T, ')', [['Post', N], K, G], ', expected )'>
  : F extends ['Idx', infer O] ? Expect<T, ']', [['Post', ['Idx', O, N]], K, G], ', expected ]'>
  : F extends ['Spread'] ? [['R', ['Spread', N]], T, K, G]
  : F extends ['CallA', infer C, infer As, infer Kind]
    ? Push<As, N> extends infer A2
      ? T extends [',', infer R]
        ? R extends [')', infer R2] ? [['Post', [Kind, C, A2]], R2, K, G] : [['Arg'], R, [['CallA', C, A2, Kind], K], G]
        : Expect<T, ')', [['Post', [Kind, C, A2]], K, G], ' in argument list'>
      : never
  : F extends ['ArrEl', infer Es]
    ? Push<Es, N> extends infer E2
      ? T extends [',', infer R]
        ? R extends [']', infer R2] ? [['Post', ['Arr', E2]], R2, K, G] : [['Arg'], R, [['ArrEl', E2], K], G]
        : Expect<T, ']', [['Post', ['Arr', E2]], K, G], ' in array literal'>
      : never
  : F extends ['ObjV', infer Ps, infer Key]
    ? Push<Ps, [Key, N]> extends infer P2
      ? T extends [',', infer R] ? [['Prop', P2], R, K, G] : Expect<T, '}', [['Post', ['Obj', P2]], K, G], ' in object literal'>
      : never
  : F extends ['ParamDef', infer Nm, infer Ps, infer Kind, infer Defs, infer Rest, infer P] ? [['Params', Nm, Ps, Kind, Push<Defs, [P, N]>, Rest], T, K, G]
  : F extends ['FnEnd', infer Nm, infer Ps, infer Rest, infer Defs, infer Kind, infer Saved] ? FinishFn<Nm, Ps, Rest, Defs, Kind, Saved, N, T, K, G>
  : F extends ['ArrowRet'] ? [['R', [['Ret', N]]], T, K, G]
  : F extends ['Top'] ? (SkipSemi<T> extends [] ? ['!done', N] : Unexpected<SkipSemi<T>>)
  // --- statements ---
  : F extends ['Semi'] ? [['R', N], SkipSemi<T>, K, G]
  : F extends ['ExprS'] ? [['R', ['Expr', N]], T, K, G]
  : F extends ['SL+', infer L] ? [['SL', N extends ['Empty'] ? L : Push<L, N>], T, K, G]
  : F extends ['BlockEnd'] ? (G extends [any, infer S, infer Fs, ...any[]] ? [['R', ['Block', N, S, Fs]], T, K, G] : never)
  : F extends ['RestoreScope', infer S0, infer F0] ? [['R', N], T, K, RestoreBlock<G, S0, F0>]
  : F extends ['DeclI', infer Kind, infer Ds, infer Nm] ? DeclNext<Kind, Push<Ds, [Nm, N]>, T, K, G>
  : F extends ['RetE'] ? [['R', ['Ret', N]], T, K, G]
  : F extends ['ThrowE'] ? [['R', ['Throw', N]], T, K, G]
  : F extends ['If1'] ? Expect<T, ')', [['S'], [['If2', N], K], G], ' after if condition'>
  : F extends ['If2', infer C] ? (T extends ['else', infer R] ? [['S'], R, [['If3', C, N], K], G] : [['R', ['If', C, N, null]], T, K, G])
  : F extends ['If3', infer C, infer A] ? [['R', ['If', C, A, N]], T, K, G]
  : F extends ['W1'] ? Expect<T, ')', [['S'], [['W2', N], K], G], ' after while condition'>
  : F extends ['W2', infer C] ? [['R', ['While', C, N]], T, K, G]
  : F extends ['Do1'] ? (T extends ['while', ['(', infer R]] ? [['E', 0], R, [['Do2', N], K], G] : Unexpected<T, ', expected while'>)
  : F extends ['Do2', infer B] ? (T extends [')', infer R] ? [['R', ['DoWhile', B, N]], SkipSemi<R>, K, G] : Unexpected<T, ', expected )'>)
  : F extends ['For1']
    ? T extends [';', infer R]
      ? R extends [';', any] ? [['R', null], R, [['For2', N], K], G] : [['E', 0], R, [['For2', N], K], G]
      : Unexpected<T, ' in for, expected ;'>
  : F extends ['For2', infer I]
    ? T extends [';', infer R]
      ? R extends [')', any] ? [['R', null], R, [['For3', I, N], K], G] : [['E', 0], R, [['For3', I, N], K], G]
      : Unexpected<T, ' in for, expected ;'>
  : F extends ['For3', infer I, infer C] ? Expect<T, ')', [['S'], [['For4', I, C, N], K], G], ' in for, expected )'>
  : F extends ['For4', infer I, infer C, infer U] ? (Reg<G, 's'> extends infer S ? [['R', ['For', I, C, U, N, S]], T, K, G] : never)
  : F extends ['ForOf1', infer OI, infer Nm, ...infer Pat] ? Expect<T, ')', [['S'], [['ForOf2', OI, Nm, N, Pat], K], G], ' in for, expected )'>
  : F extends ['ForOf2', infer OI, infer Nm, infer It, infer Pat]
    ? Reg<G, 's'> extends infer S
      ? (Pat extends [infer Ps] ? (Targets<Ps> extends infer Ns ? ['Block', [['Decl', Ps], N], Ns, []] : never) : N) extends infer Body
        ? [['R', ['ForOf', OI, Nm, It, Body, S]], T, K, G]
        : never
      : never
  : F extends ['Try1']
    ? T extends ['catch', ['(', [['id', infer P], [')', infer R]]]]
      ? [['S'], R, [['Try2', N, P], K], SetReg<G, 'd', AddSet<Reg<G, 'd'>, P>>]
      : T extends ['catch', infer R] ? [['S'], R, [['Try2', N, null], K], G]
        : T extends ['finally', infer R] ? [['S'], R, [['Try3', N, null, null], K], G]
          : Unexpected<T, ', expected catch or finally'>
  : F extends ['Try2', infer B, infer P] ? (T extends ['finally', infer R] ? [['S'], R, [['Try3', B, P, N], K], G] : [['R', ['Try', B, P, N, null]], T, K, G])
  : F extends ['Try3', infer B, infer P, infer C] ? [['R', ['Try', B, P, C, N]], T, K, G]
  : F extends ['Sw1'] ? (T extends [')', ['{', infer R]] ? [['Cases', N, []], R, K, G] : Unexpected<T, ' in switch'>)
  : F extends ['SwCase', infer D, infer Cs] ? Expect<T, ':', [['CaseBody', D, Cs, N, []], K, G], ', expected :'>
  : F extends ['CaseS', infer D, infer Cs, infer Tst, infer Ss] ? [['CaseBody', D, Cs, Tst, N extends ['Empty'] ? Ss : Push<Ss, N>], T, K, G]
  : PRetPat<F, N, T, K, G>;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type PStep<M, T, K, G> =
  M extends ['E', infer P] ? [['U'], T, [['Bin', P], K], G]
  : M extends ['R', infer N] ? (K extends [infer F, infer KR] ? PRet<F, N, T, KR, G> : ParseError<'internal: empty stack'>)
  : M extends ['Post', infer N] ? PPost<N, T, K, G>
  : M extends ['U'] ? PUnary<T, K, G>
  : M extends ['P'] ? PPrimary<T, K, G>
  : M extends ['S'] ? PStmt<T, K, G>
  : M extends ['SL', infer L]
    ? T extends ['}', infer R] ? [['R', L], R, K, G]
      : T extends [] ? ParseError<'Unexpected end of input, expected }'>
        : [['S'], T, [['SL+', L], K], G]
  : M extends ['Arg'] ? (T extends ['...', infer R] ? [['E', 2], R, [['Spread'], K], G] : [['E', 2], T, K, G])
  : M extends ['Prop', infer Ps] ? PProp<Ps, T, K, G>
  : M extends ['Params', infer Nm, infer Ps, infer Kind, infer Defs, infer Rest] ? PParams<Nm, Ps, Kind, Defs, Rest, T, K, G>
  : M extends ['Decl', infer Kind, infer Ds] ? PDecl<Kind, Ds, T, K, G>
  : M extends ['Cases', infer D, infer Cs] ? PCases<D, Cs, T, K, G>
  : M extends ['CaseBody', infer D, infer Cs, infer Tst, infer Ss] ? PCaseBody<D, Cs, Tst, Ss, T, K, G>
  : M extends ['Pat'] ? PPat<T, K, G>
  : M extends ['PArrEl', infer Els] ? PArrEl<Els, T, K, G>
  : M extends ['PObjProp', infer Ps] ? PObjProp<Ps, T, K, G>
  : ParseError<'internal: unknown parser mode'>;

type PRun<St, F extends number = 0> =
  St extends ['!done', any] | ['!err', any] ? St
  : F extends 300 ? St
  : St extends [infer M, infer T, infer K, infer G] ? PRun<PStep<M, T, K, G>, Nx[F]> : St;

type PDrive<St> =
  PRun<St> extends infer St2
    ? St2 extends ['!done', any] | ['!err', any] ? St2 : PDrive<St2>
    : never;

/** Parse a token list as a single expression (typically a function). Returns ['!done', ast] or ['!err', msg]. */
export type Parse<Tokens> = PDrive<[['E', 0], Tokens, [['Top'], []], G0]>;
