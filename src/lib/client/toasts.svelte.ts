/** Toast store with undo support (Svelte 5 runes). */

export interface Toast {
	id: number;
	message: string;
	kind: 'info' | 'success' | 'error' | 'undo' | 'progress';
	undoLabel?: string;
	onUndo?: () => void | Promise<void>;
	onExpire?: () => void | Promise<void>;
	expiresAt?: number;
	duration?: number;
}

let nextId = 1;

class ToastStore {
	toasts = $state<Toast[]>([]);

	show(message: string, kind: Toast['kind'] = 'info', durationMs = 4000): number {
		const id = nextId++;
		this.toasts = [...this.toasts, { id, message, kind, duration: durationMs }];
		if (durationMs > 0) setTimeout(() => this.dismiss(id), durationMs);
		return id;
	}

	success(message: string) { return this.show(message, 'success'); }
	error(message: string) { return this.show(message, 'error', 6000); }

	/** Undoable action toast: runs onExpire after the window unless undone. */
	undoable(message: string, opts: { onUndo: () => void | Promise<void>; onExpire?: () => void | Promise<void>; durationMs?: number; undoLabel?: string }): number {
		const id = nextId++;
		const duration = opts.durationMs ?? 8000;
		this.toasts = [...this.toasts, {
			id, message, kind: 'undo',
			undoLabel: opts.undoLabel ?? 'Undo',
			onUndo: opts.onUndo,
			onExpire: opts.onExpire,
			expiresAt: Date.now() + duration,
			duration
		}];
		setTimeout(() => {
			const t = this.toasts.find((x) => x.id === id);
			if (t) {
				void t.onExpire?.();
				this.dismiss(id);
			}
		}, duration);
		return id;
	}

	async undo(id: number) {
		const t = this.toasts.find((x) => x.id === id);
		if (!t) return;
		this.dismiss(id);
		await t.onUndo?.();
	}

	dismiss(id: number) {
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	/** Undo the most recent undoable toast (for the global `z` shortcut). */
	undoLatest(): boolean {
		const last = [...this.toasts].reverse().find((t) => t.kind === 'undo');
		if (!last) return false;
		void this.undo(last.id);
		return true;
	}
}

export const toasts = new ToastStore();
