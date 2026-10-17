import { z } from 'zod';

/**
 * Bounds for what a runner sends (C-136, L-04). The socket caps a frame, not a
 * field, and the API stores and projects these strings, so every stored string
 * and array of the runner-to-server contracts carries its own `.max()`.
 */

/** An identifier, a name, a label: a version, a hostname, a model, a login. */
export const TEXT_NAME_MAX = 200;
/** A glob, a branch, a heading, a title, a reason. */
export const TEXT_LINE_MAX = 500;
/** A message or an error text shown to a person. */
export const TEXT_MESSAGE_MAX = 1000;
/** A filesystem path or a URL. */
export const TEXT_PATH_MAX = 4096;
/** The most entries of a list or a record a runner reports in one field. */
export const LIST_MAX = 256;

/** A string of at most `max` characters; empty allowed. */
export const boundedText = (max: number) => z.string().max(max);

/** A string of 1 to `max` characters. */
export const boundedName = (max: number) => z.string().min(1).max(max);
