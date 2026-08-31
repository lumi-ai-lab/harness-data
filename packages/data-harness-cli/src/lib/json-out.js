/**
 * @param {unknown} value
 * @param {{ compact?: boolean }} [options]
 */
export function encodeJSON(value, options = {}) {
  if (options.compact) {
    return `${JSON.stringify(value)}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @param {NodeJS.WritableStream} [stream]
 */
export function printJSON(value, stream = process.stdout) {
  stream.write(encodeJSON(value));
}

/**
 * @param {unknown} value
 * @param {NodeJS.WritableStream} [stream]
 */
export function printCompactJSON(value, stream = process.stdout) {
  stream.write(encodeJSON(value, { compact: true }));
}
