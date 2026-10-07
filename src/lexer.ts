/**
 * Lexer: source string -> token list (cons cells, first token on the outside).
 *
 * Tokens:
 *   - keywords and punctuators are plain strings: 'if', '===', '{'
 *   - ['id', name] | ['num', canonicalDecimal] | ['str', value]
 *
 * Template literals are desugared on the fly into parenthesised string
 * concatenation:  `a${x}b`  ->  ( "a" + ( x ) + "b" )
 * which needs a stack of brace depths so that `}` can end an interpolation.
 */
import type { Canon, Digit } from './num';
import type { Nx } from './util';

type WS = ' ' | '\n' | '\t' | '\r';
type Lower = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type IdStart = Lower | Uppercase<Lower> | '_' | '$';
type IdChar = IdStart | Digit;

export type Keyword =
  | 'var' | 'let' | 'const' | 'function' | 'return' | 'if' | 'else' | 'while' | 'for' | 'do'
  | 'break' | 'continue' | 'true' | 'false' | 'null' | 'undefined' | 'typeof' | 'new' | 'this'
  | 'of' | 'in' | 'switch' | 'case' | 'default' | 'throw' | 'try' | 'catch' | 'finally'
  | 'void' | 'delete' | 'instanceof';

/** Punctuators keyed by first character, longest first ('===' must win over '=='). */
type Puncts = {
  '>': ['>>>=', '>>>', '>>=', '>=', '>>', '>']; '<': ['<<=', '<=', '<<', '<'];
  '=': ['===', '=>', '==', '=']; '!': ['!==', '!=', '!']; '*': ['**=', '*=', '**', '*'];
  '.': ['...', '.']; '&': ['&&=', '&&', '&=', '&']; '|': ['||=', '||', '|=', '|'];
  '?': ['??=', '??', '?.', '?']; '+': ['++', '+=', '+']; '-': ['--', '-=', '-'];
  '/': ['/=', '/']; '%': ['%=', '%']; '^': ['^=', '^'];
  '(': ['(']; ')': [')']; '[': ['[']; ']': [']']; ';': [';']; ',': [',']; ':': [':']; '~': ['~'];
};

export type LexError<M extends string> = ['!err', `SyntaxError: ${M}`];

type SkipLine<S> = S extends `${string}\n${infer R}` ? R : '';
type SkipWS<S> = S extends `${infer C}${infer R}` ? (C extends WS ? SkipWS<R> : S) : S;

type ReadId<S, Acc extends string> = S extends `${infer C}${infer R}` ? (C extends IdChar ? ReadId<R, `${Acc}${C}`> : [Acc, S]) : [Acc, S];

type ReadNum<S, Acc extends string = ''> =
  S extends `${infer C}${infer R}`
    ? C extends Digit | '.' ? ReadNum<R, `${Acc}${C}`>
      : C extends 'e' | 'E'
        ? R extends `${infer Sg extends '+' | '-'}${infer R2}` ? ReadNum<R2, `${Acc}e${Sg}`> : ReadNum<R, `${Acc}e`>
        : C extends '_' ? ReadNum<R, Acc>
          : [Acc, S]
    : [Acc, S];

type Escapes = { n: '\n'; t: '\t'; r: '\r'; '0': '\0'; b: '\b'; f: '\f'; v: '\v' };
type Esc<C> = C extends keyof Escapes ? Escapes[C] : C;

type ReadStr<S, Q extends string, Acc extends string = ''> =
  S extends `${infer Body}${Q}${infer R}`
    ? Body extends `${string}\\${string}` | `${string}\n${string}`
      ? ReadStrSlow<S, Q, Acc>
      : [`${Acc}${Body}`, R]
    : false;
type ReadStrSlow<S, Q extends string, Acc extends string> =
  S extends `${infer C}${infer R}`
    ? C extends Q ? [Acc, R]
      : C extends '\n' ? false
        : C extends '\\' ? (R extends `${infer E}${infer R2}` ? ReadStrSlow<R2, Q, `${Acc}${Esc<E>}`> : false)
          : ReadStrSlow<R, Q, `${Acc}${C}`>
    : false;

/** Reads template text up to the closing backtick or the next `${`. */
type ReadTpl<S, Acc extends string = ''> =
  S extends `${infer C}${infer R}`
    ? C extends '`' ? [Acc, 'end', R]
      : C extends '$' ? (R extends `{${infer R2}` ? [Acc, 'interp', R2] : ReadTpl<R, `${Acc}$`>)
        : C extends '\\' ? (R extends `${infer E}${infer R2}` ? ReadTpl<R2, `${Acc}${Esc<E>}`> : false)
          : ReadTpl<R, `${Acc}${C}`>
    : false;

/** Plain integer literals are already canonical; anything else goes through Canon. */
type NumTok<N> = N extends `0${string}` | `${string}${'.' | 'e' | 'E'}${string}` ? (N extends '0' ? N : Canon<N>) : N;

type MatchPunct<S, Ps> = Ps extends [infer P extends string, ...infer Rest]
  ? S extends `${P}${infer R}` ? [P, R] : MatchPunct<S, Rest>
  : false;

/** Push several tokens onto the (reversed) accumulator. */
type PushAll<A, Ts> = Ts extends [infer T, ...infer R] ? PushAll<[T, A], R> : A;

type LexStep<S, A, TP> =
  S extends `${infer C}${infer R}`
    ? C extends WS ? [SkipWS<R>, A, TP]
      : S extends `//${infer R2}` ? [SkipLine<R2>, A, TP]
        : S extends `/*${infer R2}` ? (R2 extends `${string}*/${infer R3}` ? [R3, A, TP] : LexError<'Unterminated comment'>)
          : C extends Digit
            ? ReadNum<S> extends [infer N, infer R2] ? (NumTok<N> extends infer CN ? (CN extends 'NaN' ? LexError<`Invalid number ${N & string}`> : [R2, [['num', CN], A], TP]) : never) : never
            : C extends IdStart
              ? ReadId<R, C> extends [infer W, infer R2] ? ((W extends Keyword ? W : ['id', W]) extends infer Tok ? [R2, [Tok, A], TP] : never) : never
              : C extends '"' | "'"
                ? ReadStr<R, C> extends [infer V, infer R2] ? [R2, [['str', V], A], TP] : LexError<'Unterminated string literal'>
                : C extends '`' ? TplPart<R, A, ['('], TP>
                  : C extends '{' ? [R, ['{', A], TP extends [infer D extends any[], ...infer TR] ? [[...D, 0], ...TR] : TP]
                    : C extends '}'
                      ? TP extends [infer D, ...infer TR]
                        ? D extends [any, ...infer D2] ? [R, ['}', A], [D2, ...TR]] : TplPart<R, A, [')', '+'], TR>
                        : [R, ['}', A], TP]
                      : (C extends keyof Puncts ? MatchPunct<S, Puncts[C]> : false) extends [infer P, infer R2] ? [R2, [P, A], TP]
                        : LexError<`Unexpected character '${C}'`>
    : ['!done', A];

/** Emit a template text chunk; either close the template or open an interpolation. */
type TplPart<S, A, Prefix extends any[], TP> =
  ReadTpl<S> extends [infer P, infer Kind, infer R]
    ? Kind extends 'end'
      ? [R, PushAll<A, [...Prefix, ['str', P], ')']>, TP]
      : [R, PushAll<A, [...Prefix, ['str', P], '+', '(']>, TP extends any[] ? [[], ...TP] : [[]]]
    : LexError<'Unterminated template literal'>;

type LexRun<St, F extends number = 0> =
  St extends ['!done', any] | ['!err', any] ? St
  : F extends 250 ? St
  : St extends [infer S, infer A, infer TP] ? LexRun<LexStep<S, A, TP>, Nx[F]> : St;

type RevRun<L, Acc, F extends number = 0> =
  F extends 400 ? ['!more', L, Acc]
  : L extends [infer H, infer T] ? RevRun<T, [H, Acc], Nx[F]> : ['!rev', Acc];
type RevDrive<St> = St extends ['!more', infer L, infer Acc] ? RevDrive<RevRun<L, Acc>> : St extends ['!rev', infer R] ? R : never;

type LexDrive<St> =
  LexRun<St> extends infer St2
    ? St2 extends ['!done', infer A] ? RevDrive<RevRun<A, []>>
      : St2 extends ['!err', any] ? St2
        : LexDrive<St2>
    : never;

/** Tokenize a source string; returns a cons list of tokens or ['!err', message]. */
export type Lex<S extends string> = LexDrive<[S, [], []]>;
