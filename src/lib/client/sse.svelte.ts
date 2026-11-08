/** SSE client: single EventSource per tab, typed event dispatch, auto-reconnect. */
import { browser } from '$app/environment';

export type SseHandler = (data: Record<string, unknown>) => void;

class SseClient {
	connected = $state(false);
	private source: EventSource | null = null;
	private handlers = new Map<string, Set<SseHandler>>();
	private retryMs = 1000;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	start() {
		if (!browser || this.source) return;
		this.connect();
	}

	private connect() {
		try {
			this.source = new EventSource('/api/events');
		} catch {
			this.scheduleRetry();
			return;
		}
		this.source.onopen = () => {
			this.connected = true;
			this.retryMs = 1000;
		};
		this.source.onerror = () => {
			this.connected = false;
			this.source?.close();
			this.source = null;
			this.scheduleRetry();
		};
		this.source.onmessage = (e) => {
			try {
				const parsed = JSON.parse(e.data) as { type: string } & Record<string, unknown>;
				const set = this.handlers.get(parsed.type);
				if (set) for (const h of set) h(parsed);
				const all = this.handlers.get('*');
				if (all) for (const h of all) h(parsed);
			} catch { /* ignore malformed */ }
		};
	}

	private scheduleRetry() {
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryMs = Math.min(this.retryMs * 2, 30_000);
			this.connect();
		}, this.retryMs);
	}

	on(type: string, handler: SseHandler): () => void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(handler);
		return () => set.delete(handler);
	}

	stop() {
		this.source?.close();
		this.source = null;
		this.connected = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}

export const sse = new SseClient();
