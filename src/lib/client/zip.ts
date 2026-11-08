/** Minimal ZIP writer (store method, no compression) for "download all attachments". */

function crc32(data: Uint8Array): number {
	let table = crcTable;
	if (!table) {
		table = crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
let crcTable: Uint32Array | null = null;

export function buildZip(files: { name: string; data: Uint8Array }[]): Blob {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const f of files) {
		const nameBytes = encoder.encode(f.name);
		const crc = crc32(f.data);
		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true); // version
		lv.setUint16(6, 0x0800, true); // UTF-8 flag
		lv.setUint16(8, 0, true); // store
		lv.setUint32(14, crc, true);
		lv.setUint32(18, f.data.length, true);
		lv.setUint32(22, f.data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		chunks.push(local, f.data);

		const cent = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(cent.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, f.data.length, true);
		cv.setUint32(24, f.data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		cent.set(nameBytes, 46);
		central.push(cent);

		offset += local.length + f.data.length;
	}

	const centralSize = central.reduce((s, c) => s + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);

	return new Blob([...chunks, ...central, end] as BlobPart[], { type: 'application/zip' });
}
