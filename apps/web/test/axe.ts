import axe from 'axe-core';

/**
 * Serious and critical axe violations of `container` (FRONTEND §11.2).
 * jsdom does not lay out or paint, so rules that need rendering (contrast)
 * are left to the Playwright checks.
 */
export async function axeViolations(container: Element): Promise<string[]> {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.help}`);
}
