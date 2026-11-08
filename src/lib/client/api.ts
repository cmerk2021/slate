/** Small typed fetch helpers for the Slate API. */

export async function apiGet<T = Record<string, unknown>>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		let msg = `Request failed (${res.status})`;
		try {
			const body = await res.json();
			if (body?.message) msg = body.message;
			else if (body?.error) msg = body.error;
		} catch { /* non-JSON */ }
		throw new Error(msg);
	}
	return res.json();
}

export async function apiPost<T = Record<string, unknown>>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `Request failed (${res.status})`);
	}
	return data as T;
}

export async function apiPut<T = Record<string, unknown>>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
	}
	return data as T;
}
