import { test, expect } from '@playwright/test';

const PASSWORD = 'correct-horse-battery-staple-9';

test.describe.configure({ mode: 'serial' });

test('first-run setup creates the app password and first profile', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/setup/);

	await page.fill('input[name="password"]', PASSWORD);
	await page.fill('input[name="confirm"]', PASSWORD);
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.fill('input[name="profileName"]', 'Personal');
	await page.getByRole('button', { name: /Create & get started/ }).click();

	// lands in the app shell
	await page.waitForURL((u) => !u.pathname.startsWith('/setup') && !u.pathname.startsWith('/login'));
	await expect(page.locator('body')).toContainText('Personal');
});

test('setup route is disabled after first run', async ({ page }) => {
	await page.goto('/setup');
	await expect(page).not.toHaveURL(/\/setup/);
});

test('login with password works', async ({ page, context }) => {
	await context.clearCookies();
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);

	await page.fill('input[name="password"]', PASSWORD);
	await page.getByRole('button', { name: /sign in|unlock|log in/i }).click();

	await page.waitForURL((u) => !u.pathname.startsWith('/login'));
	await expect(page.locator('body')).toContainText('Personal');
});

test('wrong password is rejected', async ({ page, context }) => {
	await context.clearCookies();
	await page.goto('/login');
	await page.fill('input[name="password"]', 'definitely-wrong-password');
	await page.getByRole('button', { name: /sign in|unlock|log in/i }).click();
	await expect(page).toHaveURL(/\/login/);
	await expect(page.locator('body')).toContainText(/incorrect|invalid|wrong|failed/i);
});

test('can create a second profile in settings', async ({ page }) => {
	await page.goto('/login');
	const pw = page.locator('input[name="password"]');
	if (await pw.isVisible().catch(() => false)) {
		await pw.fill(PASSWORD);
		await page.getByRole('button', { name: /sign in|unlock|log in/i }).click();
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
	}
	await page.goto('/settings/profiles');
	await page.getByRole('button', { name: /New profile/ }).click();
	await page.getByPlaceholder('Work').fill('Work');
	await page.getByRole('button', { name: 'Create profile' }).click();
	await expect(page.locator('body')).toContainText('Work');
});
