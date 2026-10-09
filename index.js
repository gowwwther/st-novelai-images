/**
 * Inline Image Generation — entry point.
 *
 * Catches `[IMG:GEN:{json}]` tags in AI messages and `<img data-iig-instruction>`
 * and generates images via configured API.
 *
 * Вся логика вынесена в `src/`. Этот файл — только импорт + init.
 */

import {
    getSettings,
    initializeConnectionProfiles,
    saveSettings,
} from './src/settings.js';
import { createSettingsUI, syncInstructions } from './src/ui.js';
import { addButtonsToExistingMessages, subscribeEvents } from './src/events.js';
import { registerIigBookMacro } from './src/references.js';
import { resolveActiveProvider } from './src/providers.js';
import { initLightbox } from './src/lightbox.js';
import { initImageActions } from './src/imageActions.js';
import { catalogInstructions } from './src/catalog.js';

(function init() {
    const context = SillyTavern.getContext();

    // Load/seed settings eagerly so getSettings() сразу возвращает валидный объект.
    const settings = getSettings();

    initializeConnectionProfiles(settings);
    saveSettings();

    // Register {{nni-book}} macro — делает refs-список доступным для вставки
    // в карточки / пресеты, чтобы LLM видела какие триггеры можно ставить.
    registerIigBookMacro(() => resolveActiveProvider()?.supportsReferences(getSettings()) === true);

    // Create settings UI when app is ready.
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat.
        addButtonsToExistingMessages();
        // Lightbox: делегированный click-handler на #chat, оверлей один на страницу.
        initLightbox();
        // Floating corner-кнопки на сгенерированных картинках.
        initImageActions();
        console.log('[NNI] Inline Image Generation extension loaded');
    });

    context.registerMacro?.('nni-catalog', () => catalogInstructions(getSettings()));
    syncInstructions();
    subscribeEvents();

    console.log('[NNI] Inline Image Generation extension initialized');
})();
