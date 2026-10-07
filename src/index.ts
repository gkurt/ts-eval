/**
 * ts-eval — a JavaScript interpreter that runs entirely inside the TypeScript
 * type checker.
 *
 *   type R = Eval<'function(a, b) { return a + b; }', 5, 3>;   // 8
 *
 * Pipeline:  source --Lex--> tokens --Parse--> AST --Execute--> machine state --Outcome--> TS type
 */
import type { Lex } from './lexer';
import type { Boot, EvalError, Execute, Outcome, RunSlice } from './machine';
import type { Parse } from './parser';

export type { EvalError } from './machine';

declare const NoArg: unique symbol;
type NoArg = typeof NoArg;
type Collect<L, Acc extends unknown[] = []> = L extends [infer H, ...infer R] ? ([H] extends [NoArg] ? Acc : Collect<R, [...Acc, H]>) : Acc;

/** Source -> ['!done', ast] | ['!err', message] */
export type Compile<Src extends string> =
  Lex<Src> extends infer T ? (T extends ['!err', infer M] ? ['!err', M] : Parse<T>) : never;

/** Run a program; returns `{ result, logs }` where logs holds every console.log call. */
export type Run<Src extends string, Args extends readonly unknown[] = []> =
  Compile<Src> extends infer C
    ? C extends ['!done', infer Ast] ? Outcome<Execute<Ast, [...Args]>>
      : C extends ['!err', infer M extends string] ? { result: EvalError<M>; logs: [] }
        : never
    : never;

/**
 * Evaluate `Src` (an expression, usually a function). If it evaluates to a
 * function, it is called with the remaining type arguments.
 */
export type Eval<Src extends string, A0 = NoArg, A1 = NoArg, A2 = NoArg, A3 = NoArg, A4 = NoArg, A5 = NoArg, A6 = NoArg, A7 = NoArg> =
  Run<Src, Collect<[A0, A1, A2, A3, A4, A5, A6, A7]>>['result'];

/** Like Eval, but takes the arguments as a tuple. */
export type EvalWith<Src extends string, Args extends readonly unknown[]> = Run<Src, Args>['result'];

/** Everything passed to console.log while evaluating. */
export type Logs<Src extends string, Args extends readonly unknown[] = []> = Run<Src, Args>['logs'];

// ---------------------------------------------------------------------------
// Resumable evaluation
//
// The checker allows ~5M type instantiations per declaration, which caps a
// single Eval at very roughly 50k machine steps. A Start/Resume chain spreads
// one computation over several declarations, each with a fresh budget:
//
//   type S1 = Start<typeof src, [25]>;
//   type S2 = Resume<S1>;
//   type S3 = Resume<S2>;
//   type R  = Result<S3>;   // the value, or EvalError<'Still running...'>
// ---------------------------------------------------------------------------

/** Compile, boot and run the first slice (~30k steps). Returns an opaque machine state. */
export type Start<Src extends string, Args extends readonly unknown[] = []> =
  Compile<Src> extends infer C
    ? C extends ['!done', infer Ast] ? RunSlice<Boot<Ast, [...Args]>>
      : C extends ['!err', infer M] ? ['err', M, [], [], [[], []]]
        : never
    : never;
/** Run another slice of a started program (no-op once it has finished). */
export type Resume<S> = RunSlice<S>;
/** Whether a started program has finished (successfully or not). */
export type IsDone<S> = S extends ['done' | 'uncaught' | 'err', ...any[]] ? true : false;
export type Result<S> = Outcome<S>['result'];
export type ResultLogs<S> = Outcome<S>['logs'];
