// Global test setup, runs before each test file (vitest.config.ts setupFiles).
// Adds jest-dom matchers (toBeInTheDocument, toHaveValue, ...) to vitest's expect.
// Component unmount/cleanup is handled automatically by the svelteTesting() plugin.
import '@testing-library/jest-dom/vitest';
