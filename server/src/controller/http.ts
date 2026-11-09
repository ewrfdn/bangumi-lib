/**
 * Coerce a dynamic query/param value to a string.
 * Fastify hands these over as `unknown`: single values are strings, repeated keys become arrays.
 */
export const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : ''
