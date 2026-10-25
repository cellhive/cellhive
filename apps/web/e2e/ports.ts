/** Fixed ports of the E2E stack (override with E2E_WEB_PORT / E2E_API_PORT). */
export const E2E_WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 5199);
export const E2E_API_PORT = Number(process.env['E2E_API_PORT'] ?? 3199);
export const E2E_WEB_URL = `http://127.0.0.1:${String(E2E_WEB_PORT)}`;

/** Name of the variable through which the global setup hands the stack environment to specs. */
export const E2E_STACK_ENV = 'CELLHIVE_E2E_STACK_ENV';
