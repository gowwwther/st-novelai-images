// Read metadata only. No preview, upload or generation happens during import.
import { NOVELAI_MODELS, NOVELAI_SAMPLERS } from './novelai.js';

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader(), chunks = []; let size = 0;
    try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
            if (size > 2 * 1024 * 1024) throw new Error('Метаданные PNG слишком большие.'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(result);
}

export function normalizePNGMetadata(raw) {
    const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const comment = outer?.Comment ?? outer;
    const metadata = typeof comment === 'string' ? JSON.parse(comment) : comment;
    if (!metadata?.v4_prompt?.caption || !metadata?.v4_negative_prompt?.caption) throw new Error('В PNG нет отдельных промптов NovelAI V4.5/V5. Скачай оригинальный PNG кнопкой NovelAI.');
    return metadata;
}

export async function readNovelAIPNG(file) {
    if (file.size > 20 * 1024 * 1024) throw new Error('PNG больше 20 МБ.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) throw new Error('Нужен оригинальный PNG NovelAI.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder();
    // Ordinary tEXt metadata, when present, avoids decoding the pixel data.
    for (let p = 8; p + 12 <= bytes.length;) {
        const length = view.getUint32(p), end = p + 12 + length;
        if (end > bytes.length) throw new Error('Повреждённый PNG.');
        if (decoder.decode(bytes.subarray(p+4,p+8)) === 'tEXt') {
            const data = bytes.subarray(p+8,p+8+length), zero = data.indexOf(0);
            if (zero > 0 && decoder.decode(data.subarray(0,zero)) === 'Comment') return normalizePNGMetadata(decoder.decode(data.subarray(zero+1)));
        }
        p = end;
    }
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width*height > 16*1024*1024) throw new Error('Слишком большое разрешение PNG для чтения метаданных.');
    const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap,0,0); bitmap.close();
    const rgba = ctx.getImageData(0,0,width,height).data; canvas.width = canvas.height = 0;
    let bit = 0;
    const byte = () => { let value = 0; for (let i=0;i<8;i++) { const x=Math.floor(bit/height),y=bit%height; bit++;
        if (x>=width) throw new Error('Обрезанные метаданные PNG.'); value=(value<<1)|(rgba[(y*width+x)*4+3]&1); } return value; };
    const signature = String.fromCharCode(...Array.from({length:15},byte));
    if (signature !== 'stealth_pngcomp') throw new Error('Скрытые метаданные NovelAI не найдены. Нужен исходный PNG, а не скриншот.');
    const length = byte()*16777216 + byte()*65536 + byte()*256 + byte();
    if (length%8 || length/8 > 2*1024*1024 || length > width*height-bit) throw new Error('Некорректный размер метаданных PNG.');
    const compressed = Uint8Array.from({length:length/8},byte);
    return normalizePNGMetadata(await gunzip(compressed));
}

export function buildPNGRequest(settings, raw) {
    const n = normalizePNGMetadata(raw), model = settings.model;
    if (!Object.hasOwn(NOVELAI_MODELS,model)) throw new Error('Выбери модель для повторения PNG.');
    if (model === 'nai-diffusion-5-full-medium') throw new Error('Для точного повтора PNG выбери V5 Full/Curated High: Medium имеет фиксированные параметры.');
    const source = String(n.model_name || n.model || '');
    const family = /V5|nai-diffusion-5/i.test(source) ? '5' : /V4\.5|nai-diffusion-4-5/i.test(source) ? '4-5' : null;
    if (!family || !model.startsWith(`nai-diffusion-${family}-`)) throw new Error('Выбранная модель не совпадает с семейством из PNG. Выбери соответствующую V5 или V4.5.');
    if (n.request_type && n.request_type !== 'PromptGenerateRequest') throw new Error('Этот PNG создан не обычной текстовой генерацией. Повтор требует исходного изображения.');
    if (['reference_strength_multiple','director_reference_strengths','director_reference_descriptions'].some(k => n[k]?.length)) throw new Error('PNG использовал фото-референсы. Их исходные данные отсутствуют в метаданных, точный повтор невозможен.');
    for (const key of ['seed','steps','width','height','scale']) if (!Number.isFinite(n[key])) throw new Error(`В PNG нет корректного ${key}.`);
    if (!Number.isInteger(n.seed) || n.seed<0 || n.seed>4294967295 || !Number.isInteger(n.steps) || n.steps<1 || n.steps>50
        || n.width<64 || n.height<64 || n.width%64 || n.height%64 || n.width*n.height>16*1024*1024 || n.scale<0 || n.scale>10) throw new Error('Параметры PNG вне поддерживаемых границ.');
    if (!Object.hasOwn(NOVELAI_SAMPLERS,n.sampler)) throw new Error('Sampler из PNG не поддерживается.');
    const max = family==='5' ? 22 : 6;
    const validateCaption = (value, ordered) => {
        if (typeof value.caption.base_caption!=='string' || !Array.isArray(value.caption.char_captions) || value.caption.char_captions.length>max) throw new Error('Некорректная структура слотов PNG.');
        for (const c of value.caption.char_captions) {
            if (typeof c.char_caption!=='string' || !Array.isArray(c.centers) || !c.centers.length || c.centers.some(p=>![p.x,p.y].every(v=>typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1))) throw new Error('Некорректные координаты/текст слота PNG.');
        }
        return {caption:{base_caption:value.caption.base_caption,char_captions:value.caption.char_captions.map(c=>({char_caption:c.char_caption,centers:c.centers.map(p=>({x:p.x,y:p.y}))}))},
            use_coords:!!value.use_coords,use_order:value.use_order==null?ordered:!!value.use_order,legacy_uc:!!value.legacy_uc};
    };
    const positive=validateCaption(n.v4_prompt,true),negative=validateCaption(n.v4_negative_prompt,false);
    if (positive.caption.char_captions.length!==negative.caption.char_captions.length) throw new Error('Число позитивных и негативных слотов PNG не совпадает.');
    const parameters = { params_version:4, width:n.width, height:n.height, steps:n.steps, scale:n.scale, seed:n.seed,
        n_samples:1, sampler:n.sampler, noise_schedule:n.noise_schedule || 'karras', qualityToggle:false, ucPreset:3,
        negative_prompt:negative.caption.base_caption, v4_prompt:positive, v4_negative_prompt:negative };
    // Only generation controls are copied. Never forward hashes, endpoints,
    // credentials, arbitrary passthrough settings or metadata UI hints.
    for (const key of ['cfg_rescale','uncond_scale','legacy_v3_extend','straight_alpha','quality_boost','dynamic_thresholding','sm','sm_dyn',
        'skip_cfg_above_sigma','skip_cfg_below_sigma','deliberate_euler_ancestral_bug','prefer_brownian',
        'cfg_sched_eligibility','explike_fine_detail','minimize_sigma_inf','uncond_per_vibe','wonky_vibe_correlation']) {
        if (Object.hasOwn(n,key) && (n[key]===null || ['number','boolean','string'].includes(typeof n[key]))) parameters[key]=n[key];
    }
    const slots=positive.caption.char_captions.map((c,i)=>({name:`PNG · персонаж ${i+1}`,description:c.char_caption,
        negative:negative.caption.char_captions[i].char_caption,center:c.centers[0],reason:'точный текст из метаданных PNG'}));
    return { body:{action:'generate',model,input:positive.caption.base_caption,parameters},slots,
        positive:positive.caption.base_caption,negative:negative.caption.base_caption,
        style:{name:'Общий промпт из PNG',value:'',selectionSource:'png'},
        presets:{qualityPreset:'из PNG · уже в тексте',ucPreset:'из PNG · уже в тексте'},
        warnings:[],
        notices:['Повтор PNG: стиль и библиотечные описания не добавляются. Весь текст, seed и параметры берутся из PNG.',
            `PNG сообщает семейство ${source}; вариант Full/Curated/Medium определяется выбранной моделью ${model}.`],
        activeReferences:[],skippedReferences:[] };
}
