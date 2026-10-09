/** Native /ai/encode-vibe and /ai/generate-image reference fields. */
import { fetchWithTimeout, imageUrlToDataUrl } from './utils.js';
const inflightVibes = new Map();
const memoryVibes = new Map();
function base64(bytes) {
    let out = ''; for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(out);
}
async function database() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('nni-vibe-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('vibes');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
}
async function cache(key, value) {
    try {
        const db = await database();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('vibes', value === undefined ? 'readonly' : 'readwrite');
            const req = value === undefined ? tx.objectStore('vibes').get(key) : tx.objectStore('vibes').put(value, key);
            let result; req.onsuccess = () => result = req.result;
            tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => { db.close(); reject(tx.error); };
        });
    } catch { return undefined; }
}
export async function referenceImageData(imagePath, precise = false) {
    const dataUrl = imagePath.startsWith('data:') ? imagePath : await imageUrlToDataUrl(imagePath);
    if (!dataUrl) throw new Error('Не удалось загрузить фото референса.');
    const img = new Image(); img.src = dataUrl;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Пустое изображение референса.');
    const ratio = img.naturalWidth / img.naturalHeight;
    const [width, height] = precise ? (ratio < .85 ? [1024, 1536] : ratio > 1.2 ? [1536, 1024] : [1472, 1472])
        : (ratio < 1 ? [Math.max(64, Math.round(1024 * ratio)), 1024] : [1024, Math.max(64, Math.round(1024 / ratio))]);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
    const result = canvas.toDataURL('image/png'); return { base64: result.split(',')[1], dataUrl: result, width, height };
}
async function encodeVibe(image, info, settings, signal) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
    const key = `${settings.model}:${info}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
    const existing = memoryVibes.get(key) || await cache(key);
    if (existing) return { token: existing, cached: true };
    if (inflightVibes.has(key)) return inflightVibes.get(key);
    const promise = (async () => {
        const response = await fetchWithTimeout(`${settings.endpoint.replace(/\/$/, '')}/ai/encode-vibe`, {
            method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/octet-stream' },
            body: JSON.stringify({ image, information_extracted: info, model: settings.model }),
        }, settings.requestTimeoutMs, signal);
        if (!response.ok) throw new Error(`Vibe encoding ${response.status}: ${(await response.text()).slice(0, 500)}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error('NovelAI вернул пустой Vibe.');
        const token = base64(bytes); memoryVibes.set(key, token); await cache(key, token);
        return { token, cached: false };
    })();
    inflightVibes.set(key, promise);
    try { return await promise; } finally { inflightVibes.delete(key); }
}
export async function attachNativeReferences(request, settings, signal) {
    const parameters = request.body.parameters;
    const previews = [];
    for (const ref of request.activeReferences) {
        const precise = ref.referenceMode !== 'vibe';
        const image = await referenceImageData(ref.imagePath, precise);
        const strength = Number(ref.strength ?? 1), fidelity = Number(ref.fidelity ?? 1), info = Number(ref.informationExtracted ?? 1);
        if (![strength, fidelity, info].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error(`${ref.label}: значения референса должны быть от 0 до 1.`);
        if (precise) {
            (parameters.director_reference_images ??= []).push(image.base64);
            (parameters.director_reference_descriptions ??= []).push({ caption: { base_caption: ref.referenceMode === 'character&style' ? 'character&style' : ref.kind === 'style' ? 'style' : 'character', char_captions: [] }, legacy_uc: false });
            (parameters.director_reference_information_extracted ??= []).push(1);
            (parameters.director_reference_strength_values ??= []).push(strength);
            (parameters.director_reference_secondary_strength_values ??= []).push(fidelity);
            previews.push({ label: ref.label, mode: ref.referenceMode, dataUrl: image.dataUrl, width: image.width, height: image.height, strength, fidelity, extraAnlas: 5 });
        } else {
            const encoded = await encodeVibe(image.base64, info, settings, signal);
            (parameters.reference_image_multiple ??= []).push(encoded.token);
            (parameters.reference_strength_multiple ??= []).push(strength);
            parameters.normalize_reference_strength_multiple = true;
            previews.push({ label: ref.label, mode: 'vibe', dataUrl: image.dataUrl, width: image.width, height: image.height, strength, informationExtracted: info, cached: encoded.cached });
        }
    }
    return previews;
}
export async function decodeImageResponse(response) {
    const type = response.headers.get('content-type') || '';
    if (type.includes('json')) {
        const data = await response.json(); const value = data?.images?.[0]?.image;
        if (typeof value !== 'string' || !value.trim()) throw new Error('NovelAI вернул ответ без картинки.');
        return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (type.startsWith('image/')) return `data:${type.split(';')[0]};base64,${base64(bytes)}`;
    // ZIP fallback (central directory handles data descriptors). Never execute archive contents.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break;
    if (end < 0 || end < bytes.length - 65557) throw new Error(`Неизвестный формат ответа NovelAI: ${type}.`);
    let offset = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);
    for (let i = 0; i < count; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Повреждённый ZIP NovelAI.');
        const method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (/\.(png|webp|jpe?g)$/i.test(name)) {
            const local = view.getUint32(offset + 42, true);
            const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            let image = bytes.slice(start, start + size);
            if (method === 8) image = new Uint8Array(await new Response(new Blob([image]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
            else if (method !== 0) throw new Error('Неподдерживаемое сжатие ZIP NovelAI.');
            const mime = /\.webp$/i.test(name) ? 'image/webp' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
            return `data:${mime};base64,${base64(image)}`;
        }
        offset += 46 + nameLength + extra + comment;
    }
    throw new Error('ZIP NovelAI не содержит изображения.');
}
