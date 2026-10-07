/**
 * Checking a config object's structure: a state machine whose transitions must
 * point at defined states, and whose states must all be reachable. That is a
 * graph search, so it is easy in JavaScript and awkward with ordinary types.
 */
import type { Eval } from '../src/index';
import type { Expect, Equal } from '../test/helpers';

type CheckMachine = `function(m) {
  const names = Object.keys(m.states);
  if (!names.includes(m.initial)) return "initial state '" + m.initial + "' is not defined";
  for (const s of names) {
    const on = m.states[s].on ?? {};
    for (const ev of Object.keys(on))
      if (!names.includes(on[ev])) return "'" + s + "' --" + ev + "--> '" + on[ev] + "': no such state";
  }
  const seen = [m.initial], queue = [m.initial];
  while (queue.length) {
    const on = m.states[queue.shift()].on ?? {};
    for (const t of Object.values(on)) if (!seen.includes(t)) { seen.push(t); queue.push(t); }
  }
  for (const s of names) if (!seen.includes(s)) return "state '" + s + "' is unreachable from '" + m.initial + "'";
  return true;
}`;

/** `true`, or what is wrong with the machine. */
export type MachineError<M> = Eval<CheckMachine, M>;

type ValidMachine<M> = MachineError<M> extends infer R ? (R extends true ? M : R) : never;

function machine<const M>(m: M & ValidMachine<M>): M {
  return m;
}

export const checkout = machine({
  initial: 'cart',
  states: {
    cart: { on: { checkout: 'payment' } },
    payment: { on: { paid: 'shipped', fail: 'cart' } },
    shipped: { on: { deliver: 'done' } },
    done: {},
  },
});

// @ts-expect-error state 'refunded' is unreachable from 'cart'
export const unreachable = machine({
  initial: 'cart',
  states: {
    cart: { on: { checkout: 'payment' } },
    payment: { on: { paid: 'shipped', fail: 'cart' } },
    shipped: {},
    refunded: {},
  },
});

type Typo = {
  initial: 'cart';
  states: { cart: { on: { checkout: 'paymnet' } }; payment: {} };
};

export type MachineTests = [
  Expect<Equal<MachineError<typeof checkout>, true>>,
  Expect<Equal<MachineError<Typo>, "'cart' --checkout--> 'paymnet': no such state">>,
  Expect<Equal<MachineError<{ initial: 'idle'; states: { start: {} } }>, "initial state 'idle' is not defined">>,
];
