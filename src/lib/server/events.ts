/**
 * In-process event bus feeding Server-Sent Events streams, one per browser session.
 * Events are scoped by profile; the client filters/refreshes based on type.
 */
export interface SlateEvent {
	type: string;
	profileId?: number;
	data?: unknown;
}

type Listener = (ev: SlateEvent) => void;

const listeners = new Set<Listener>();

export function publish(ev: SlateEvent) {
	for (const l of listeners) {
		try {
			l(ev);
		} catch {
			/* listener errors must not break the bus */
		}
	}
}

export function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
