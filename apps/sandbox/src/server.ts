// Uruchamia piaskownicę. Port: SANDBOX_PORT (domyślnie 4100), host: SANDBOX_HOST (domyślnie localhost).

import { buildApp } from './app.ts';

const port = Number(process.env.SANDBOX_PORT ?? 4100);
const app = buildApp();

try {
  await app.listen({ port, host: process.env.SANDBOX_HOST ?? 'localhost' });
  console.log(`Piaskownica OŁCyŚ: http://localhost:${port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
