/** Native NovelAI libraries: names select entries; descriptions never depend on the LLM. */
import { getSettings, getActiveStyle, getEffectiveNegativePrompt } from './settings.js';
import { findPrimaryKeyMatch, promptMatchesAllSecondaryKeys, buildAdditionalReferencesPromptBlock } from './parser.js';
import { buildNovelAIParameters, splitNovelAICharacterPrompts, isNovelAIMedium } from './novelai.js';

export const id = () => `nni-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
export const join = (...parts) => parts.map(x => String(x ?? '').trim()).filter(Boolean).join(', ');
export function makeCharacter(name = '') {
    return { id: id(), name, aliases: '', description: '', negative: '', enabled: true, matchMode: 'match',
        priority: 0, useRegex: false, secondaryKeys: '', positionEnabled: false, x: .5, y: .5,
        imagePath: '', referenceEnabled: false, referenceMode: 'character', strength: 1, fidelity: 1 };
}
export function makeStyle(name = '') {
    return { id: id(), name, value: '', negative: '', imagePath: '', referenceEnabled: false,
        referenceMode: 'style', strength: 1, fidelity: 1, informationExtracted: 1 };
}
function findCharacter(selector, library) {
    const key = String(selector ?? '').normalize('NFKC').toLowerCase().trim();
    return library.find(c => c.id === selector || [c.name, ...String(c.aliases || '').split(',')]
        .some(n => String(n).normalize('NFKC').toLowerCase().trim() === key));
}
function matchCharacter(prompt, entry) {
    const keys = [entry.name, entry.aliases].filter(Boolean).join(',');
    return (entry.matchMode === 'always' || findPrimaryKeyMatch(prompt, keys, entry.useRegex))
        && promptMatchesAllSecondaryKeys(prompt, entry.secondaryKeys || '');
}
function center(c, override) {
    if (override?.center != null) {
        const { x, y } = override.center;
        if (![x, y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Character center must contain x/y between 0 and 1.');
        return { x, y };
    }
    return c?.positionEnabled ? { x: Number(c.x), y: Number(c.y) } : { x: .5, y: .5 };
}
export function resolveCharacters(instruction, settings = getSettings()) {
    const library = (settings.novelCharacters || []).filter(c => c.enabled !== false);
    const split = splitNovelAICharacterPrompts(instruction.prompt);
    const slots = [];
    const seen = new Set();
    const push = (c, extra = '', selector = null, reason = 'explicit') => {
        if (c && seen.has(c.id)) throw new Error(`Персонаж «${c.name}» указан дважды. Используй отдельные карточки для двойников.`);
        if (c) seen.add(c.id);
        slots.push({ entry: c, name: c?.name || 'Character', description: join(c?.description, extra),
            negative: String(c?.negative || ''), center: center(c, selector),
            positionEnabled: !!(c?.positionEnabled || selector?.center), reason });
    };
    if (instruction.characters !== undefined && instruction.characters !== null) {
        if (!Array.isArray(instruction.characters)) throw new Error('characters должен быть массивом имён или объектов {name, prompt}.');
        for (const value of instruction.characters) {
            const obj = typeof value === 'string' ? { name: value } : value;
            if (!obj || typeof obj !== 'object' || typeof (obj.id || obj.name) !== 'string') throw new Error('Некорректная запись characters.');
            const c = findCharacter(obj.id || obj.name, library);
            if (!c) throw new Error(`В библиотеке нет включённого персонажа «${obj.id || obj.name}». Запрос не отправлен.`);
            push(c, obj.prompt || '', obj, 'characters');
        }
        if (split.characters.length) throw new Error('Используй characters ИЛИ разделители |, чтобы не дублировать персонажей.');
    } else if (split.characters.length) {
        for (const part of split.characters) {
            const exact = findCharacter(part, library);
            const matches = exact ? [exact] : library.filter(c => matchCharacter(part, { ...c, matchMode: 'match' }));
            if (matches.length > 1) throw new Error(`Несколько персонажей совпали в одном блоке: ${matches.map(c => c.name).join(', ')}. Используй characters.`);
            const c = matches[0];
            let extra = part;
            if (c) {
                // Remove selector only; all scene/action text survives.
                for (const name of [c.name, ...String(c.aliases || '').split(',')].sort((a, b) => b.length - a.length)) {
                    if (!name.trim()) continue;
                    extra = extra.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'giu'), '$1');
                }
                extra = extra.replace(/^[\s,:;]+|[\s,:;]+$/g, '');
            }
            push(c, extra, null, c ? 'pipe-match' : 'raw-pipe');
        }
    } else {
        const matched = library.filter(c => matchCharacter(split.base, c)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
        for (const c of matched) push(c, '', null, c.matchMode === 'always' ? 'always' : 'name-match');
    }
    for (const slot of slots) {
        if (!slot.description) throw new Error(`У «${slot.name}» пустое описание внешности. Заполни карточку.`);
        if (![slot.center.x, slot.center.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error(`Некорректная позиция «${slot.name}».`);
        if (/[\\]?\|/.test(slot.description) || /[\\]?\|/.test(slot.negative)) throw new Error(`У «${slot.name}» есть | в описании/негативе. В карточке должен быть один персонаж.`);
    }
    return { base: split.base, slots };
}
export function resolveStyle(instruction, settings = getSettings()) {
    const selector = instruction.styleId || instruction.style_id || instruction.style;
    if (selector) {
        const style = (settings.styles || []).find(s => s.id === selector || s.name?.toLowerCase() === String(selector).toLowerCase());
        if (style) return style;
        if (instruction.styleId || instruction.style_id) throw new Error(`Стиль «${selector}» не найден.`);
        return { name: 'Inline style', value: selector, negative: '' };
    }
    return getActiveStyle(settings);
}
export function buildNativeRequest(settings, instruction = {}) {
    const { base, slots } = resolveCharacters(instruction, settings);
    const style = resolveStyle(instruction, settings);
    const additional = buildAdditionalReferencesPromptBlock(instruction.matchedAdditionalRefs || []);
    const basePrompt = join(style?.value, base, additional);
    if (!basePrompt) throw new Error('Промпт пустой.');
    for (const part of [style?.value, style?.negative, settings.globalNegative, instruction.negativePrompt]) {
        if (part && /[\\]?\|/.test(part)) throw new Error('В стиле и общем негативе нельзя использовать |. Личные негативы указывай в карточках.');
    }
    const globalNegative = join(settings.globalNegative, getEffectiveNegativePrompt(settings.novelaiNegativePrompt, settings), style?.negative, instruction.negativePrompt);
    if (isNovelAIMedium(settings.model) && (globalNegative || slots.some(s => s.negative))) {
        throw new Error('V5 Medium использует фиксированный негатив. Выбери V5 Full/Curated для своих негативов. Запрос не отправлен.');
    }
    const positive = [basePrompt, ...slots.map(s => s.description)].join(' | ');
    const negative = [globalNegative, ...slots.map(s => s.negative)].join(' | ');
    const parameters = buildNovelAIParameters({ ...settings, novelaiAspectRatio: instruction.aspectRatio || settings.novelaiAspectRatio }, positive, negative, settings.model);
    parameters.v4_prompt.use_coords = slots.some(s => s.positionEnabled);
    parameters.v4_prompt.caption.char_captions.forEach((c, i) => c.centers = [slots[i].center]);
    parameters.v4_negative_prompt.caption.char_captions.forEach((c, i) => c.centers = [slots[i].center]);
    const referencePlans = [];
    for (const slot of slots) {
        if (slot.entry?.referenceEnabled && slot.entry?.imagePath) referencePlans.push({ ...slot.entry, label: slot.name, kind: 'character', slotIndex: slots.indexOf(slot) });
    }
    if (style?.referenceEnabled && style?.imagePath) referencePlans.push({ ...style, label: style.name, kind: 'style' });
    const warnings = [];
    const activeReferences = [];
    const skippedReferences = [];
    for (const plan of referencePlans) {
        let reason = '';
        if (settings.referencePolicy === 'text-only') reason = 'Выбран режим «Только текст»';
        else if (!settings.model.startsWith('nai-diffusion-4-5-')) reason = 'Фотореференсы поддерживаются только V4.5';
        if (reason) {
            skippedReferences.push({ label: plan.label, reason, imagePath: plan.imagePath });
            if (settings.referencePolicy === 'strict') throw new Error(`${plan.label}: ${reason}. Переключи модель на V4.5 или отключи отправку фото.`);
            warnings.push(`${plan.label}: фото не отправлено — ${reason}.`);
        } else activeReferences.push(plan);
    }
    const precise = activeReferences.filter(r => r.referenceMode !== 'vibe');
    const vibes = activeReferences.filter(r => r.referenceMode === 'vibe');
    if (precise.length && vibes.length) throw new Error('Precise Reference и Vibe Transfer нельзя использовать вместе. Выбери один режим для фото.');
    if (precise.filter(r => r.kind === 'character').length > 1) warnings.push('NovelAI смешивает несколько фотореференсов персонажей; фото не привязаны к отдельным текстовым слотам.');
    if (vibes.length > 16) throw new Error('NovelAI поддерживает не более 16 Vibe-референсов в одном запросе.');
    return { body: { action: 'generate', model: settings.model, input: basePrompt, parameters },
        positive, negative, style, slots, activeReferences, skippedReferences, warnings };
}
export function catalogInstructions(settings = getSettings()) {
    const names = (settings.novelCharacters || []).filter(c => c.enabled !== false && c.name).map(c => c.name);
    const styles = (settings.styles || []).map(s => s.name).filter(Boolean);
    return `When an illustration is appropriate, append one <naicom><img data-iig-instruction='{"prompt":"SCENE ONLY","characters":[{"name":"EXACT LIBRARY NAME","prompt":"pose, expression, current clothing"}],"aspect_ratio":"1:1"}' src="[IMG:GEN]" /></naicom> outside the prose. Use valid JSON, escape apostrophes as &#39; in HTML attributes. The base prompt describes the scene, number of people, interactions, framing and lighting. Do not write character appearance, artist tags or negative prompts: the extension supplies them from its libraries. List only characters actually visible. Each character prompt contains actions/expression/current clothing only. Select characters using exact names below. An optional "style" selects a style by exact name; omit it to use the active style. Never invent a file path or copy a generated image tag. Do not wrap the block in Markdown code fences.\nAvailable characters: ${JSON.stringify(names)}\nAvailable styles: ${JSON.stringify(styles)}`;
}
