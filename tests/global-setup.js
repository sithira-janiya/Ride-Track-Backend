import './setup-env.js';

import { migrate } from '../scripts/migrate.js';

// Creates the tables in the throwaway test database before any test file runs.
export default async function globalSetup() {
  await migrate();
}
