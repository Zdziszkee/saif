/**
 * Loads `.env` into `process.env` before any test runs.
 *
 * `getTypesafeApiKeyFromEnv()` (and therefore `createJevClassifier()`) reads
 * `process.env`, which Vite/Vitest do not populate from `.env` on their own.
 * This keeps `npm run test:integration` working against a gitignored `.env`.
 *
 * The unit tier is unaffected: it injects the fixed-answer double and never
 * reads the key.
 */
import "dotenv/config";
