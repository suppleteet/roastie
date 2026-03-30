/**
 * Generic state machine infrastructure.
 * Pure TypeScript types + a tiny transition helper — no runtime deps.
 */

/** For each state, the set of states it can transition to. */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Recorded transition event. */
export interface TransitionEvent<S extends string> {
  from: S;
  to: S;
  trigger: string;
  ts: number;
}

/**
 * Validates and executes a transition.
 * Returns a TransitionEvent if valid, null if the transition is not allowed.
 * Pure function — caller is responsible for storing the result.
 */
export function transition<S extends string>(
  current: S,
  next: S,
  map: TransitionMap<S>,
  trigger: string,
): TransitionEvent<S> | null {
  const allowed = map[current];
  if (!allowed || !allowed.includes(next)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[state] invalid: ${current} → ${next} (${trigger})`);
    }
    return null;
  }
  return { from: current, to: next, trigger, ts: Date.now() };
}
