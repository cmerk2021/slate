declare global {
	namespace App {
		interface Locals {
			session: { id: string; createdAt: number } | null;
			setupDone: boolean;
		}
	}
}

export {};
