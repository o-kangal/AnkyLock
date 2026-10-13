declare const brand: unique symbol;

/** Nominal typing for primitives: a `Brand<string, 'NoteId'>` is not assignable from a plain string. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
