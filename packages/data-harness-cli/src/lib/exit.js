export class ExitError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, silent?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "ExitError";
    this.code = options.code ?? 1;
    this.silent = Boolean(options.silent);
  }
}

/**
 * @param {unknown} err
 * @returns {err is ExitError}
 */
export function isExitError(err) {
  return err instanceof ExitError;
}
