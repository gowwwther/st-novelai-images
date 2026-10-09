/** NovelAI-only adapter; the surrounding parser/pipeline comes from SillyImages. */
import { getSettings, setLastRequestSnapshot, nniLog } from './settings.js';
import { NOVELAI_MODELS, validateNovelAIParameters } from './novelai.js';
import { ProviderError, fetchWithTimeout } from './utils.js';
import { buildNativeRequest } from './catalog.js';
import { attachNativeReferences, decodeImageResponse } from './referenceApi.js';
const endpoint = 'https://image.novelai.net';
export function validateSettings() {
    const s = getSettings();
    const errors = validateNovelAIParameters(s);
    if (!s.apiKey?.trim()) errors.push('Вставь Persistent API Token NovelAI.');
    if (!Object.hasOwn(NOVELAI_MODELS, s.model)) errors.push('Выбери модель NovelAI.');
    if (String(s.endpoint).replace(/\/$/, '') !== endpoint) errors.push('Официальный endpoint: https://image.novelai.net');
    if (errors.length) throw new ProviderError({ message: errors.join('; '), code: 'invalid_request', providerId: 'novelai' });
}
const provider = {
    id: 'novelai', displayName: 'NovelAI',
    supportsReferences: () => false, // References are attached in native fields, not the generic avatar pipeline.
    supportsNegativePrompt: s => s.model !== 'nai-diffusion-5-full-medium',
    capabilities: { referencesMaxCount: 0 },
    collectReferences: async () => [],
    getModelLabel: model => NOVELAI_MODELS[model] || model,
    async generate({ prompt, style = '', options = {} }) {
        const settings = structuredClone(getSettings()); // One immutable request config across UI changes/retries.
        settings.apiType = 'novelai'; settings.apiKey = settings.apiKey.trim().replace(/^Bearer\s+/i, '');
        let request;
        try { request = buildNativeRequest(settings, { prompt, style, ...options }); }
        catch (e) {
            setLastRequestSnapshot({ timestamp: Date.now(), status: 'blocked', error: e.message, prompt, metadata: { model: settings.model, apiType: 'novelai' }, warnings: [e.message] });
            throw new ProviderError({ message: e.message, code: 'invalid_request', providerId: 'novelai' });
        }
        const snapshot = { timestamp: Date.now(), status: 'preparing', prompt: request.positive, negativePrompt: request.negative,
            characters: request.slots.map(s => ({ name: s.name, description: s.description, negative: s.negative, center: s.center, reason: s.reason })),
            references: [], skippedReferences: request.skippedReferences, warnings: request.warnings,
            metadata: { provider: 'NovelAI', apiType: 'novelai', model: settings.model, style: request.style?.name || '', size: `${request.body.parameters.width}x${request.body.parameters.height}`, seed: request.body.parameters.seed },
            url: `${endpoint}/ai/generate-image`, body: request.body };
        setLastRequestSnapshot(snapshot);
        for (const warning of request.warnings) { nniLog('WARN', warning); globalThis.toastr?.warning(warning, 'NovelAI'); }
        try {
            snapshot.references = await attachNativeReferences(request, settings, options.signal);
            snapshot.body = structuredClone(request.body); snapshot.parameters = snapshot.body.parameters;
            snapshot.status = 'sending'; setLastRequestSnapshot(snapshot);
            nniLog('INFO', `Native request: ${settings.model}, ${request.slots.length} character slots, ${snapshot.references.length} images, seed=${snapshot.metadata.seed}`);
            const response = await fetchWithTimeout(snapshot.url, { method: 'POST',
                headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(snapshot.body),
            }, settings.requestTimeoutMs || 600000, options.signal);
            if (!response.ok) {
                const raw = (await response.text()).split(settings.apiKey).join('[TOKEN REDACTED]').slice(0, 800);
                throw new ProviderError({ message: `NovelAI ${response.status}: ${raw}`, status: response.status, code: String(response.status), retryable: [429, 502, 503, 504].includes(response.status), providerId: 'novelai' });
            }
            const image = await decodeImageResponse(response);
            snapshot.status = 'success'; snapshot.httpStatus = response.status; setLastRequestSnapshot(snapshot);
            return image;
        } catch (cause) {
            snapshot.status = options.signal?.aborted ? 'cancelled' : 'error'; snapshot.error = String(cause.message).split(settings.apiKey).join('[TOKEN REDACTED]');
            setLastRequestSnapshot(snapshot);
            if (cause instanceof ProviderError) throw cause;
            throw new ProviderError({ message: snapshot.error, code: options.signal?.aborted ? 'aborted' : cause.name === 'AbortError' ? 'timeout' : 'request_failed', retryable: false, providerId: 'novelai', cause: undefined });
        }
    },
};
export const resolveActiveProvider = () => provider;
export const getActiveProviderMaxReferences = () => 0;
export const fetchModels = async () => Object.keys(NOVELAI_MODELS);
