export const LOCKED_EXPRESSIONS = ['squint', 'blink', 'arch', 'sleepz', 'guard', 'tight', 'visor', 'bubble'] as const;
export const UNLOCKED_EXPRESSIONS = ['awake', 'star', 'cheer', 'curious'] as const;
export type LockedExpression = (typeof LOCKED_EXPRESSIONS)[number];
export type UnlockedExpression = (typeof UNLOCKED_EXPRESSIONS)[number];

/** What every logo on screen shows: whether a vault is open, and the face picked for each state. */
export interface LogoFace {
  readonly unlocked: boolean;
  readonly locked: LockedExpression;
  /** Null until the first unlock. */
  readonly unlockedFace: UnlockedExpression | null;
}

/** At launch, before any lock or unlock: the app icon's face. */
export const DEFAULT_LOGO_FACE: LogoFace = { unlocked: false, locked: 'arch', unlockedFace: null };

/** A random expression other than `previous`; `random` returns a number in [0, 1). */
export function pickExpression<T extends string>(choices: readonly T[], previous: T | null, random: () => number): T {
  const others = choices.filter((choice) => choice !== previous);
  return (others[Math.floor(random() * others.length)] ?? choices[0]) as T;
}

/** The face after a vault is opened (`unlocked`) or closed; unchanged when the state stays. */
export function nextLogoFace(face: LogoFace, unlocked: boolean, random: () => number): LogoFace {
  if (face.unlocked === unlocked) return face;
  return unlocked
    ? { ...face, unlocked, unlockedFace: pickExpression(UNLOCKED_EXPRESSIONS, face.unlockedFace, random) }
    : { ...face, unlocked, locked: pickExpression(LOCKED_EXPRESSIONS, face.locked, random) };
}
