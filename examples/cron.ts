/**
 * Validating a string argument where the function is called: a cron schedule
 * API that rejects bad expressions at compile time, with a readable reason.
 *
 * The validator is plain JavaScript. A hand-written type-level parser for the
 * same rules would be far longer and harder to change.
 */
import type { Eval } from '../src/index';
import type { Expect, Equal } from '../test/helpers';

type CheckCron = `function(expr) {
  const fields = expr.split(" ");
  if (fields.length !== 5) return "expected 5 fields, got " + fields.length;
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  const lo = [0, 0, 1, 1, 0], hi = [59, 23, 31, 12, 6];
  for (let i = 0; i < 5; i++) {
    for (const part of fields[i].split(",")) {
      const [range, step] = part.split("/");
      if (step !== undefined && !(Number(step) >= 1)) return names[i] + ": bad step '" + step + "'";
      if (range === "*") continue;
      for (const n of range.split("-")) {
        const v = Number(n);
        if (n === "" || !Number.isInteger(v) || v < lo[i] || v > hi[i])
          return names[i] + ": '" + n + "' is outside " + lo[i] + "-" + hi[i];
      }
    }
  }
  return true;
}`;

/** `true`, or why the expression is invalid. */
export type CronError<S extends string> = Eval<CheckCron, S>;

/**
 * `S` if valid. Otherwise an object type carrying the message, which the
 * argument cannot satisfy, so the message shows up in the error. (Intersecting
 * with a bare string message would collapse to `never` and lose it.)
 * Strings only known at runtime (`string`) pass through to a runtime check.
 */
type ValidCron<S extends string> =
  string extends S ? S
  : CronError<S> extends infer R ? (R extends true ? S : { 'invalid cron': R }) : never;

declare function schedule<const S extends string>(expr: S & ValidCron<S>, job: () => void): void;

schedule('*/5 * * * *', () => {});
schedule('0 9-17 * * 1-5', () => {});
schedule('30 2 1,15 * *', () => {});
declare const fromConfig: string;
schedule(fromConfig, () => {});

// @ts-expect-error hour: '24' is outside 0-23
schedule('0 24 * * *', () => {});
// @ts-expect-error minute: bad step '0'
schedule('*/0 * * * *', () => {});
// @ts-expect-error expected 5 fields, got 4
schedule('0 9 * *', () => {});

export type CronTests = [
  Expect<Equal<CronError<'0 9-17 * * 1-5'>, true>>,
  Expect<Equal<CronError<'0 24 * * *'>, "hour: '24' is outside 0-23">>,
  Expect<Equal<CronError<'*/0 * * * *'>, "minute: bad step '0'">>,
  Expect<Equal<CronError<'0 9 * *'>, 'expected 5 fields, got 4'>>,
  Expect<Equal<CronError<'0 0 * 13 *'>, "month: '13' is outside 1-12">>,
];
