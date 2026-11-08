/** Global keyboard shortcut registry (Svelte 5 runes).
 * The app layout installs the single keydown listener; pages/components
 * register handlers for keys. Sequences like "g i" are supported.
 */
import { browser } from '$app/environment';

export type ShortcutHandler = (e: KeyboardEvent) => boolean | void;

interface Registration {
	key: string; // e.g. "j", "mod+k", "g i", "shift+i", "?"
	handler: ShortcutHandler;
	allowInInput?: boolean;
}

function isTyping(e: KeyboardEvent): boolean {
	const t = e.target as HTMLElement | null;
	if (!t) return false;
	const tag = t.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function comboFor(e: KeyboardEvent): string {
	const parts: string[] = [];
	if (e.metaKey || e.ctrlKey) parts.push('mod');
	if (e.altKey) parts.push('alt');
	// shift is encoded in the key itself for printable chars (e.g. "?", "#", "!")
	let key = e.key;
	if (key.length > 1) key = key.toLowerCase();
	if (e.shiftKey && key.length === 1 && /[a-z]/i.test(key)) {
		parts.push('shift');
		key = key.toLowerCase();
	}
	parts.push(key);
	return parts.join('+');
}

class ShortcutRegistry {
	enabled = $state(true);
	private registrations: Registration[] = [];
	private pendingPrefix: string | null = null;
	private prefixTimer: ReturnType<typeof setTimeout> | null = null;

	register(key: string, handler: ShortcutHandler, opts?: { allowInInput?: boolean }): () => void {
		const reg: Registration = { key, handler, allowInInput: opts?.allowInInput };
		this.registrations.unshift(reg); // most recent registration wins
		return () => {
			const i = this.registrations.indexOf(reg);
			if (i >= 0) this.registrations.splice(i, 1);
		};
	}

	handleKeydown = (e: KeyboardEvent) => {
		if (!browser) return;
		const typing = isTyping(e);
		const combo = comboFor(e);

		// sequence handling: a pending "g" prefix
		if (this.pendingPrefix && !typing) {
			const seq = `${this.pendingPrefix} ${combo}`;
			this.clearPrefix();
			for (const r of this.registrations) {
				if (r.key === seq && (this.enabled || combo === 'mod+k')) {
					const res = r.handler(e);
					if (res !== false) {
						e.preventDefault();
						return;
					}
				}
			}
			return;
		}

		// is this combo a prefix of any registered sequence?
		if (!typing && this.enabled && this.registrations.some((r) => r.key.startsWith(combo + ' '))) {
			this.pendingPrefix = combo;
			this.prefixTimer = setTimeout(() => this.clearPrefix(), 1200);
			e.preventDefault();
			return;
		}

		for (const r of this.registrations) {
			if (r.key !== combo) continue;
			if (typing && !r.allowInInput) continue;
			if (!this.enabled && !r.allowInInput && combo !== 'mod+k' && combo !== 'escape') continue;
			const res = r.handler(e);
			if (res !== false) {
				e.preventDefault();
				return;
			}
		}
	};

	private clearPrefix() {
		this.pendingPrefix = null;
		if (this.prefixTimer) clearTimeout(this.prefixTimer);
		this.prefixTimer = null;
	}
}

export const shortcuts = new ShortcutRegistry();
