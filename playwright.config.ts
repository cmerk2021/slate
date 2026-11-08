import { defineConfig } from '@playwright/test';
import { rmSync } from 'node:fs';

const E2E_DATA = './.e2e-data';

// fresh database for every run
try {
	rmSync(E2E_DATA, { recursive: true, force: true });
} catch {
	/* first run */
}

export default defineConfig({
	testDir: './e2e',
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: 'http://localhost:4173'
	},
	webServer: {
		command: 'npm run build && node build/index.js',
		port: 4173,
		timeout: 180_000,
		reuseExistingServer: false,
		env: {
			DATA_DIR: E2E_DATA,
			PORT: '4173',
			ORIGIN: 'http://localhost:4173',
			APP_ORIGIN: 'http://localhost:4173',
			RP_ID: 'localhost',
			NODE_ENV: 'production'
		}
	}
});
