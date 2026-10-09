import { getSettings, saveSettings, createConnectionProfile, loadConnectionProfile, saveCurrentIntoProfile, renameConnectionProfile, removeConnectionProfile, getLastRequestSnapshot, exportLogs, ensureStyles } from './settings.js';
import { NOVELAI_MODELS, NOVELAI_NUMERIC_FIELDS, NOVELAI_RESOLUTION_PRESETS, NOVELAI_ASPECT_RATIOS, NOVELAI_SAMPLERS, NOVELAI_NOISE_SCHEDULES, isNovelAIMedium } from './novelai.js';
import { makeCharacter, makeStyle, id, catalogInstructions, buildNativeRequest } from './catalog.js';
import { sanitizeForHtml as esc, readFileAsDataUrl, saveImageToFile, imageUrlToDataUrl } from './utils.js';
import { triggerBrowserDownload } from './references.js';
import { generateImageWithRetry } from './pipeline.js';
import { applyImageActionsStyle } from './imageActions.js';
import { Popup } from '../../../../popup.js';
let root, selectedCharacter = '', selectedStyle = '', libraryKind = 'characters';
const select = (key, label, values) => `<label>${label}<select data-setting="${key}" class="text_pole">${Object.entries(values).map(([v, text]) => `<option value="${esc(v)}" ${getSettings()[key] === v ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
const check = (key, label) => `<label class="checkbox_label"><input type="checkbox" data-setting="${key}" ${getSettings()[key] ? 'checked' : ''}>${label}</label>`;
const field = (key, label, type = 'text', extra = '') => `<label>${label}<input class="text_pole" data-setting="${key}" type="${type}" value="${esc(String(getSettings()[key] ?? ''))}" ${extra}></label>`;
const area = (key, label, rows = 3) => `<label>${label}<textarea class="text_pole" data-setting="${key}" rows="${rows}">${esc(getSettings()[key] || '')}</textarea></label>`;
const button = (action, label) => `<button class="menu_button" type="button" data-action="${action}">${label}</button>`;
export function syncInstructions() {
    const ctx = SillyTavern.getContext(), s = getSettings();
    ctx.setExtensionPrompt?.('novelai_inline_images', s.enabled && s.injectImageInstructions ? catalogInstructions(s) : '', 1, 0, false, 0);
}
export async function showLastRequest(snapshot = getLastRequestSnapshot()) {
    if (!snapshot) { toastr.info('Пока нет запроса. Нажми «Проверить сборку» или сгенерируй картинку.'); return; }
    const smallBody = JSON.parse(JSON.stringify(snapshot.body || {}, (key, val) => {
        if ((key === 'director_reference_images' || key === 'reference_image_multiple') && Array.isArray(val)) return val.map((s, i) => `[base64 #${i + 1}: ${s.length} chars — полный JSON доступен для скачивания]`);
        return val;
    }));
    const html = `<div class="nni-debug"><p><b>${esc(snapshot.status || 'preview')}</b> · ${esc(snapshot.url || '')}</p>
        ${snapshot.error ? `<p class="nni-notice">${esc(snapshot.error)}</p>` : ''}
        ${(snapshot.warnings || []).map(w => `<p class="nni-notice">${esc(w)}</p>`).join('')}
        <h4>Общий промпт</h4><pre>${esc(snapshot.body?.input || snapshot.prompt || '')}</pre>
        <h4>Персонажи: отдельные positive / negative</h4>${(snapshot.characters || []).map((c, i) => `<section><b>${i + 1}. ${esc(c.name)} · ${esc(c.reason || '')}</b><pre>${esc(c.description)}</pre><pre>Negative: ${esc(c.negative || '(пусто)')}</pre></section>`).join('')}
        <h4>Общий негатив</h4><pre>${esc(snapshot.body?.parameters?.negative_prompt || snapshot.negativePrompt || '')}</pre>
        <h4>Отправленные фото (${snapshot.references?.length || 0})</h4><div class="nni-ref-preview">${(snapshot.references || []).map(r => `<figure><img src="${esc(r.dataUrl)}"><figcaption>${esc(r.label)} · ${esc(r.mode)} · ${r.width}×${r.height}${r.cached != null ? ` · Vibe ${r.cached ? 'из кэша' : 'закодирован'}` : ''}</figcaption></figure>`).join('')}</div>
        <h4>Фото, которые не отправлены</h4>${(snapshot.skippedReferences || []).map(r => `<p>${esc(r.label)}: ${esc(r.reason)}</p>`).join('') || '<p>Нет</p>'}
        <h4>Тело запроса JSON</h4><pre>${esc(JSON.stringify(smallBody, null, 2))}</pre></div>`;
    await Popup.show.text('NovelAI — точный запрос', html, { allowVerticalScrolling: true, wide: true });
}
function connectionHtml() {
    const s = getSettings();
    return `<p class="nni-subtitle">Официальный NovelAI · настройки сохраняются автоматически</p>
        <div class="nni-profile"><select id="nni_profile" class="text_pole">${s.connectionProfiles.map(p => `<option value="${esc(p.id)}" ${p.id === s.activeConnectionProfileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>${button('profile-save', 'Сохранить')}${button('profile-new', 'Новый')}${button('profile-rename', 'Имя')}${button('profile-remove', 'Удалить')}</div>
        ${field('apiKey', 'Persistent API Token', 'password', 'autocomplete="off"')}
        <p class="nni-subtitle">Endpoint: https://image.novelai.net</p>
        ${select('model', 'Модель', NOVELAI_MODELS)}
        <div class="nni-grid">${select('novelaiResolution', 'Размер', Object.fromEntries(Object.entries(NOVELAI_RESOLUTION_PRESETS).map(([k, v]) => [k, v.label])))}${select('novelaiAspectRatio', 'Пропорции', Object.fromEntries(NOVELAI_ASPECT_RATIOS.map(v => [v, v])))}
        ${NOVELAI_NUMERIC_FIELDS.map(f => field(f.key, f.label, 'number', `min="${f.min}" max="${f.max}" step="${f.step}"`)).join('')}
        ${select('novelaiSampler', 'Sampler', NOVELAI_SAMPLERS)}${select('novelaiNoiseSchedule', 'Noise schedule · V4.5', Object.fromEntries(NOVELAI_NOISE_SCHEDULES.map(v => [v, v])))}</div>
        <p id="nni_model_hint" class="nni-notice"></p>
        ${select('referencePolicy', 'Отправка фотографий', { 'text-only': 'Только текст · фото остаются в библиотеке', strict: 'Отправлять фото · ошибка при несовместимой модели' })}
        <p class="nni-subtitle">Фото поддерживаются V4.5. Precise Reference: +5 Anlas за каждое фото. Несколько фото персонажей могут смешивать внешность. Vibe: кодирование +2 Anlas, затем кэш; несовместим с Precise Reference.</p>
        ${area('globalNegative', 'Общий негатив (добавляется к негативу стиля и активному пресету)')}
        <details><summary>Дополнительные настройки</summary><div class="nni-form">${check('externalBlocks', 'Обрабатывать extblocks / naicom')}${check('processUserMessages', 'Обрабатывать теги в моих сообщениях')}${check('injectImageInstructions', 'Автоматически давать ИИ инструкцию и каталог имён')}${check('imageActionsEnabled', 'Кнопки скачивания и повторной генерации на картинке')}${field('imageActionsOpacity', 'Видимость кнопок, %', 'number', 'min="0" max="100"')}${field('maxRetries', 'Автоповторы при 429 / 5xx', 'number', 'min="0" max="5"')}${field('retryDelay', 'Пауза перед повтором, мс', 'number', 'min="1000" max="60000"')}${field('requestTimeoutMs', 'Таймаут запроса, мс', 'number', 'min="10000" max="600000"')}</div></details>`;
}
function modelHint() {
    const s = getSettings(), el = root.querySelector('#nni_model_hint');
    if (el) el.textContent = isNovelAIMedium(s.model) ? 'Medium: 14 шагов, Euler Ancestral и фиксированный негатив. Свои негативы требуют Full/Curated.' : s.model.startsWith('nai-diffusion-5-') ? 'V5: отдельные текстовые слоты и негативы. Фото пока не поддерживаются. Noise schedule и Skip CFG не отправляются.' : 'V4.5: Character / Style Reference и Vibe Transfer доступны.';
}
function collection() { const s = getSettings(); return libraryKind === 'characters' ? s.novelCharacters : libraryKind === 'styles' ? s.styles : s.negativePrompts; }
function selected() { return libraryKind === 'characters' ? selectedCharacter : selectedStyle; }
function setSelected(value) { if (libraryKind === 'characters') selectedCharacter = value; else selectedStyle = value; }
function renderLibraryList() {
    const s = getSettings(), query = (root.querySelector('#nni_search')?.value || '').toLowerCase();
    root.querySelector('#nni_entries').innerHTML = collection().filter(c => `${c.name} ${c.aliases || ''}`.toLowerCase().includes(query)).map(c => `<button type="button" class="nni-entry ${c.id === selected() ? 'selected' : ''}" data-entry="${esc(c.id)}"><strong>${esc(c.name || 'Без имени')}</strong><small>${esc((c.description || c.value || '').slice(0, 65))}</small>${c.id === s.activeStyleId || c.id === s.activeNegativePromptId ? '<span>Активен</span>' : ''}</button>`).join('') || '<p class="nni-subtitle">Нет записей</p>';
}
const entryField = (c, key, label, type = 'text', extra = '') => `<label>${label}<input class="text_pole" data-entry-field="${key}" type="${type}" value="${esc(String(c[key] ?? ''))}" ${extra}></label>`;
const entryArea = (c, key, label) => `<label>${label}<textarea class="text_pole" data-entry-field="${key}" rows="5">${esc(c[key] || '')}</textarea></label>`;
const entryCheck = (c, key, label) => `<label class="checkbox_label"><input type="checkbox" data-entry-field="${key}" ${c[key] ? 'checked' : ''}>${label}</label>`;
function renderEditor() {
    const c = collection().find(c => c.id === selected()), char = libraryKind === 'characters', negative = libraryKind === 'negatives';
    const editor = root.querySelector('#nni_editor');
    if (!c) { editor.innerHTML = '<p class="nni-empty">Добавь запись или выбери её слева.</p>'; return; }
    editor.innerHTML = `${entryField(c, 'name', 'Имя')}${char ? `${entryField(c, 'aliases', 'Алиасы через запятую')}${entryCheck(c, 'enabled', 'Персонаж включён')}${entryArea(c, 'description', 'Внешность · отправляется в отдельный Character Prompt')}${entryArea(c, 'negative', 'Личный негатив · только для этого персонажа')}
        <div class="nni-grid"><label>Подключение<select class="text_pole" data-entry-field="matchMode"><option value="match" ${c.matchMode !== 'always' ? 'selected' : ''}>По имени / из characters</option><option value="always" ${c.matchMode === 'always' ? 'selected' : ''}>Всегда при автоматическом подборе</option></select></label>${entryField(c, 'priority', 'Приоритет автоподбора', 'number')}</div>
        ${entryCheck(c, 'positionEnabled', 'Задать положение на изображении')}<div class="nni-grid">${entryField(c, 'x', 'X: 0 слева — 1 справа', 'number', 'min="0" max="1" step="0.05"')}${entryField(c, 'y', 'Y: 0 сверху — 1 снизу', 'number', 'min="0" max="1" step="0.05"')}</div>
        <details><summary>Условия автоподбора</summary>${entryCheck(c, 'useRegex', 'Имена / алиасы как регулярное выражение')}${entryField(c, 'secondaryKeys', 'Дополнительные ключи (все должны совпасть)')}</details>` : entryArea(c, 'value', negative ? 'Негативный промпт' : 'Теги стиля / художники')}
        ${!char && !negative ? entryArea(c, 'negative', 'Негатив этого стиля · добавляется к общему') : ''}
        ${!negative ? `<details open><summary>Фото референса</summary><div class="nni-photo">${c.imagePath ? `<img src="${esc(c.imagePath)}" data-nni-lightbox="true">` : '<p>Фото не добавлено</p>'}<label class="menu_button">Загрузить фото<input type="file" id="nni_photo" accept="image/png,image/jpeg,image/webp" hidden></label>${button('photo-remove', 'Убрать фото')}</div>
        ${entryField(c, 'imagePath', 'Или URL изображения')}${entryCheck(c, 'referenceEnabled', 'Отправлять это фото · только при выбранном режиме отправки')}
        <label>Режим<select class="text_pole" data-entry-field="referenceMode">${Object.entries(char ? { character: 'Character Reference', 'character&style': 'Character + Style' } : { style: 'Style Reference (Precise)', vibe: 'Vibe Transfer' }).map(([v, t]) => `<option value="${v}" ${c.referenceMode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <div class="nni-grid">${entryField(c, 'strength', 'Strength', 'number', 'min="0" max="1" step="0.05"')}${entryField(c, 'fidelity', 'Fidelity · Precise', 'number', 'min="0" max="1" step="0.05"')}${!char ? entryField(c, 'informationExtracted', 'Information extracted · Vibe', 'number', 'min="0" max="1" step="0.05"') : ''}</div></details>` : ''}
        <div class="nni-toolbar">${!char ? button('activate', 'Активировать') + button('deactivate', 'Выключить активный') : ''}${button('duplicate', 'Дублировать')}${button('entry-remove', 'Удалить')}</div>`;
}
function renderLibrary() {
    root.querySelector('#nni_library').innerHTML = `<div class="nni-toolbar"><button type="button" class="menu_button ${libraryKind === 'characters' ? 'active' : ''}" data-library="characters">Персонажи</button><button type="button" class="menu_button ${libraryKind === 'styles' ? 'active' : ''}" data-library="styles">Стили</button><button type="button" class="menu_button ${libraryKind === 'negatives' ? 'active' : ''}" data-library="negatives">Негативы</button></div>
        <p class="nni-subtitle">Количество записей не ограничено. В одном запросе: до 22 текстовых персонажей V5 / 6 V4.5. Имена выбирает ИИ, внешность добавляет расширение.</p>
        <div class="nni-toolbar"><input id="nni_search" class="text_pole" placeholder="Поиск">${button('entry-add', '+ Добавить')}</div>
        <div class="nni-library-grid"><div id="nni_entries"></div><div id="nni_editor" class="nni-form"></div></div>`;
    renderLibraryList(); renderEditor();
}
function preview() {
    const s = getSettings(); const instruction = JSON.parse(root.querySelector('#nni_test').value);
    const request = buildNativeRequest(s, { ...instruction, aspectRatio: instruction.aspect_ratio });
    const snapshot = { timestamp: Date.now(), status: 'preview · запрос не отправлялся', url: 'https://image.novelai.net/ai/generate-image', body: request.body,
        characters: request.slots, warnings: [...request.warnings, ...request.activeReferences.map(r => `Фото «${r.label}» планируется (${r.referenceMode}); Base64 появится в последнем реальном запросе.`)], skippedReferences: request.skippedReferences, references: [] };
    return showLastRequest(snapshot);
}
export function createSettingsUI() {
    if (document.getElementById('nni_settings')) return;
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) return;
    const s = getSettings(); ensureStyles(s); ensureStyles(s, 'negativePrompts'); s.apiType = 'novelai'; s.endpoint = 'https://image.novelai.net';
    root = document.createElement('div'); root.id = 'nni_settings'; root.className = 'nni-only';
    root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>NovelAI Images — Till</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
        ${check('enabled', 'Генерация включена')}<div class="nni-tabs"><button class="menu_button active" type="button" data-tab="connection">Генерация</button><button class="menu_button" type="button" data-tab="library">Библиотека</button><button class="menu_button" type="button" data-tab="debug">Отладка / перенос</button></div>
        <section data-panel="connection" class="nni-form">${connectionHtml()}</section><section data-panel="library" id="nni_library" hidden></section>
        <section data-panel="debug" hidden><div class="nni-toolbar">${button('last-request', 'Последний запрос')}${button('download-request', 'Скачать полный JSON')}${button('logs', 'Скачать логи')}${button('instructions', 'Инструкция для ИИ')}</div>
        <label>Проверка сборки / ручная генерация<textarea id="nni_test" class="text_pole" rows="6">${esc(JSON.stringify({ prompt: '1boy, portrait, soft daylight', characters: [], aspect_ratio: '1:1' }, null, 2))}</textarea></label>
        <div class="nni-toolbar">${button('preview', 'Проверить сборку · бесплатно')}${button('generate', 'Сгенерировать')}</div><p id="nni_test_status" role="status"></p><img id="nni_test_result" class="nni-test-result" hidden>
        <details><summary>Импорт / экспорт</summary><p class="nni-subtitle">Экспорт содержит библиотеки и фото, без API-ключей. Импорт добавляет записи, не стирая существующие.</p><div class="nni-toolbar">${button('export', 'Экспорт библиотеки')}<label class="menu_button">Импорт JSON<input id="nni_import" type="file" accept="application/json,.json" hidden></label>${button('import-silly', 'Перенести из SillyImages')}</div></details>
        </section></div></div>`;
    container.appendChild(root); renderLibrary(); modelHint(); bind(); syncInstructions(); applyImageActionsStyle();
}
async function handleAction(action, target) {
    const s = getSettings(), c = collection().find(c => c.id === selected());
    switch (action) {
    case 'entry-add': { const entry = libraryKind === 'characters' ? makeCharacter(`Персонаж ${collection().length + 1}`) : makeStyle(`${libraryKind === 'styles' ? 'Стиль' : 'Негатив'} ${collection().length + 1}`); collection().push(entry); setSelected(entry.id); renderLibraryList(); renderEditor(); break; }
    case 'entry-remove': if (c && await Popup.show.confirm('Удалить запись?', esc(c.name))) { const list = collection(); list.splice(list.indexOf(c), 1); setSelected(''); if (s.activeStyleId === c.id) s.activeStyleId = ''; if (s.activeNegativePromptId === c.id) s.activeNegativePromptId = ''; renderLibraryList(); renderEditor(); } break;
    case 'duplicate': if (c) { const copy = { ...structuredClone(c), id: id(), name: `${c.name} — копия` }; collection().push(copy); setSelected(copy.id); renderLibraryList(); renderEditor(); } break;
    case 'activate': if (c) { s[libraryKind === 'styles' ? 'activeStyleId' : 'activeNegativePromptId'] = c.id; renderLibraryList(); } break;
    case 'deactivate': s[libraryKind === 'styles' ? 'activeStyleId' : 'activeNegativePromptId'] = ''; renderLibraryList(); break;
    case 'photo-remove': if (c) { c.imagePath = ''; c.referenceEnabled = false; renderEditor(); } break;
    case 'last-request': await showLastRequest(); break;
    case 'download-request': { const snapshot = getLastRequestSnapshot(); if (!snapshot?.body) throw new Error('Нет записанного тела запроса.'); triggerBrowserDownload('novelai-last-request.json', JSON.stringify({ url: snapshot.url, body: snapshot.body, characters: snapshot.characters, warnings: snapshot.warnings, status: snapshot.status }, null, 2)); break; }
    case 'logs': exportLogs(); break;
    case 'instructions': await Popup.show.text('Инструкция · {{nni-catalog}}', `<pre class="nni-instruction-text">${esc(catalogInstructions(s))}</pre>`, { wide: true, allowVerticalScrolling: true }); break;
    case 'preview': await preview(); break;
    case 'generate': { target.disabled = true; try { const instruction = JSON.parse(root.querySelector('#nni_test').value); const data = await generateImageWithRetry(instruction.prompt, instruction.style || '', msg => root.querySelector('#nni_test_status').textContent = msg, { characters: instruction.characters, styleId: instruction.style_id, aspectRatio: instruction.aspect_ratio, negativePrompt: instruction.negative_prompt }); const path = await saveImageToFile(data); const img = root.querySelector('#nni_test_result'); img.src = path; img.hidden = false; img.setAttribute('data-nni-lightbox', 'true'); root.querySelector('#nni_test_status').textContent = 'Готово · сохранено в папке изображений Таверны'; } finally { target.disabled = false; } break; }
    case 'export': { const payload = { kind: 'nni-library', version: 1, characters: structuredClone(s.novelCharacters), styles: structuredClone(s.styles), negatives: structuredClone(s.negativePrompts), activeStyleId: s.activeStyleId, globalNegative: s.globalNegative }; for (const entry of [...payload.characters, ...payload.styles]) if (entry.imagePath && !entry.imagePath.startsWith('data:')) { const image = await imageUrlToDataUrl(entry.imagePath); if (!image) throw new Error(`Не удалось включить фото ${entry.name} в экспорт.`); entry.imagePath = image; } triggerBrowserDownload('novelai-library.json', JSON.stringify(payload, null, 2)); break; }
    case 'import-silly': { const old = SillyTavern.getContext().extensionSettings.inline_image_gen; if (!old) throw new Error('Настройки SillyImages не найдены.'); importLibrary({ kind: 'nni-library', styles: old.styles || [], negatives: old.negativePrompts || [], characters: (old.lorebooks || []).flatMap(b => (b.refs || []).filter(r => r.description).map(r => ({ ...makeCharacter(r.name), description: r.description, aliases: '', imagePath: r.imagePath || '', enabled: r.enabled !== false, priority: r.priority || 0, useRegex: !!r.useRegex, secondaryKeys: r.secondaryKeys || '', matchMode: r.matchMode || 'match' }))) }); for (const [kind, entries] of Object.entries(old.characterReferenceLibrary || {})) for (const e of Object.values(entries || {})) { const name = e.displayName; const description = [e.primary?.description, ...(e.appearanceItems || []).filter(i => i.enabled !== false).map(i => i.description)].filter(Boolean).join(', '); if (name && description) s.novelCharacters.push({ ...makeCharacter(name), description, imagePath: e.primary?.imagePath || '' }); } renderLibraryList(); break; }
    case 'profile-save': saveCurrentIntoProfile(); toastr.success('Профиль сохранён'); break;
    case 'profile-new': { const name = await Popup.show.input('Новый профиль', 'Имя'); if (name) createConnectionProfile(name); refreshConnection(); break; }
    case 'profile-rename': { const name = await Popup.show.input('Переименовать профиль', 'Имя'); if (name) renameConnectionProfile(s.activeConnectionProfileId, name); refreshConnection(); break; }
    case 'profile-remove': if (await Popup.show.confirm('Удалить профиль?', 'Библиотеки сохранятся.')) { removeConnectionProfile(s.activeConnectionProfileId); refreshConnection(); } break;
    }
    saveSettings(); syncInstructions();
}
function refreshConnection() { root.querySelector('[data-panel="connection"]').innerHTML = connectionHtml(); modelHint(); }
function importLibrary(payload) {
    if (payload.kind !== 'nni-library' || (payload.version && payload.version !== 1)) throw new Error('Нужен JSON экспорта NovelAI Images (версия 1).');
    const s = getSettings();
    for (const [source, dest, factory] of [['characters', 'novelCharacters', makeCharacter], ['styles', 'styles', makeStyle], ['negatives', 'negativePrompts', makeStyle]]) {
        if (payload[source] != null && !Array.isArray(payload[source])) throw new Error(`${source} должен быть массивом.`);
        for (const raw of payload[source] || []) {
            if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') throw new Error('Некорректная запись библиотеки.');
            const entry = factory(raw.name);
            for (const key of Object.keys(entry)) if (key !== 'id' && Object.hasOwn(raw, key)) entry[key] = raw[key];
            s[dest].push(entry);
        }
    }
    renderLibraryList(); saveSettings(); syncInstructions(); toastr.success('Библиотеки добавлены');
}
function bind() {
    root.addEventListener('click', async e => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { root.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== tab.dataset.tab); root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === tab)); return; }
        const lib = e.target.closest('[data-library]'); if (lib) { libraryKind = lib.dataset.library; setSelected(''); renderLibrary(); return; }
        const entry = e.target.closest('[data-entry]'); if (entry) { setSelected(entry.dataset.entry); renderLibraryList(); renderEditor(); return; }
        const action = e.target.closest('[data-action]'); if (action) try { await handleAction(action.dataset.action, action); } catch (err) { toastr.error(err.message, 'NovelAI'); }
    });
    root.addEventListener('input', e => {
        if (e.target.id === 'nni_search') { renderLibraryList(); return; }
        const key = e.target.dataset.setting, entryKey = e.target.dataset.entryField;
        if (!key && !entryKey) return;
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
        if (key) { getSettings()[key] = value; if (key === 'model') modelHint(); applyImageActionsStyle(); }
        if (entryKey) { const c = collection().find(c => c.id === selected()); if (c) c[entryKey] = value; renderLibraryList(); }
        saveSettings(); syncInstructions();
    });
    root.addEventListener('change', async e => {
        try {
            if (e.target.id === 'nni_profile') { loadConnectionProfile(e.target.value); refreshConnection(); saveSettings(); return; }
            const file = e.target.files?.[0]; if (!file) return;
            if (e.target.id === 'nni_photo') { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Фото должно быть PNG, JPEG или WebP.'); if (file.size > 20 * 1024 * 1024) throw new Error('Фото слишком большое (больше 20 МБ).'); const c = collection().find(c => c.id === selected()); const path = await saveImageToFile(await readFileAsDataUrl(file)); if (c) c.imagePath = path; renderEditor(); saveSettings(); }
            if (e.target.id === 'nni_import') importLibrary(JSON.parse(await file.text()));
        } catch (err) { toastr.error(err.message, 'NovelAI'); }
    });
}
