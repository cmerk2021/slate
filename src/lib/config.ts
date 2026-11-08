/** Central app configuration. The app name lives here (working name: Slate). */
export const APP_NAME = 'Slate';

export const THEMES = [
	{ id: 'zen-dark', name: 'Zen Dark' },
	{ id: 'paper-light', name: 'Paper Light' },
	{ id: 'moss', name: 'Moss' },
	{ id: 'high-contrast', name: 'High Contrast' },
	{ id: 'system', name: 'Follow system' }
] as const;

export const ACCENT_SWATCHES = [
	{ name: 'Coral', h: 18 },
	{ name: 'Peach', h: 32 },
	{ name: 'Gold', h: 45 },
	{ name: 'Moss', h: 150 },
	{ name: 'Teal', h: 180 },
	{ name: 'Sky', h: 210 },
	{ name: 'Iris', h: 255 },
	{ name: 'Orchid', h: 300 },
	{ name: 'Rose', h: 340 }
] as const;

export const PROFILE_ICONS = ['🏠', '💼', '✦', '🌿', '🌊', '🔥', '🎓', '✈️', '🎨', '⚡'];
