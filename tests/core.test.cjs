const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function app() {
 const ctx = { extensionSettings: {}, saveSettingsDebounced() {}, characters: [], powerUserSettings: {}, chat: [] };
 const document = {createElement(){return {textContent:'',get innerHTML(){return this.textContent.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}};}};
 const sandbox = vm.createContext({ document, console, structuredClone, URL, Math, Date, Number, JSON, Promise, Set, Map, RegExp, Error, Object, String, Array, SillyTavern: { getContext: () => ctx }, setTimeout, clearTimeout });
 const modules = new Map();
 function module(file) {
  if (modules.has(file)) return modules.get(file);
  const source = file.endsWith('/i18n.js') ? 'export const t=(s,...v)=>String.raw({raw:s},...v); export const translate=s=>s;' : fs.readFileSync(file, 'utf8');
  const m = new vm.SourceTextModule(source, { context: sandbox, identifier: file, initializeImportMeta: meta => meta.url = `file://${file}` }); modules.set(file, m);
  return m;
 }
 const catalog = module(path.join(root, 'src/catalog.js')); await catalog.link((specifier, ref) => module(path.resolve(path.dirname(ref.identifier), specifier))); await catalog.evaluate();
 const png=module(path.join(root,'src/pngMetadata.js'));await png.link((specifier,ref)=>module(path.resolve(path.dirname(ref.identifier),specifier)));await png.evaluate();
 return { catalog: catalog.namespace, png:png.namespace, settings: modules.get(path.join(root, 'src/settings.js')).namespace, parser: modules.get(path.join(root, 'src/parser.js')).namespace, ctx };
}
async function seeded() {
 const a = await app(), s = a.settings.getSettings();
 Object.assign(s, { apiKey:'test', novelCharacters:[{...a.catalog.makeCharacter('Ren'), description:'boy, slim, blonde hair', negative:'muscles', aliases:'Рен'},{...a.catalog.makeCharacter('Gojo'),description:'boy, tall, white hair',negative:'spiky hair',aliases:'Сатору'}], styles:[{...a.catalog.makeStyle('My style'), value:'painterly',negative:'flat shading'}],globalNegative:'watermark' }); s.activeStyleId=s.styles[0].id;
 return {...a,s};
}
test('descriptions and personal negatives occupy paired native slots, no bleed into base', async()=>{
 const {catalog,s}=await seeded(); const r=catalog.buildNativeRequest(s,{prompt:'2boys, garden',characters:[{name:'Gojo',prompt:'standing'},{name:'Ren',prompt:'sitting'}]});
 assert.equal(r.body.input,'painterly, 2boys, garden');
 assert.equal(r.body.parameters.negative_prompt,'watermark, flat shading');
 assert.deepEqual(JSON.parse(JSON.stringify(r.body.parameters.v4_prompt.caption.char_captions.map(c=>c.char_caption))),['boy, tall, white hair, standing','boy, slim, blonde hair, sitting']);
 assert.deepEqual(JSON.parse(JSON.stringify(r.body.parameters.v4_negative_prompt.caption.char_captions.map(c=>c.char_caption))),['spiky hair','muscles']);
});
test('unknown explicit selector blocks instead of silently losing appearance',async()=>{const {catalog,s}=await seeded();assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Unknown']}),/нет включённого/);});
test('empty explicit list excludes automatic characters',async()=>{const {catalog,s}=await seeded();s.novelCharacters[0].matchMode='always';const r=catalog.buildNativeRequest(s,{prompt:'Ren',characters:[]});assert.equal(r.slots.length,0);});
test('unicode aliases match whole names only',async()=>{const {catalog,s}=await seeded();assert.equal(catalog.buildNativeRequest(s,{prompt:'Рен in garden'}).slots[0].name,'Ren');assert.equal(catalog.buildNativeRequest(s,{prompt:'Renata'}).slots.length,0);});
test('legacy | slots retain actions and align negatives',async()=>{const {catalog,s}=await seeded();const r=catalog.buildNativeRequest(s,{prompt:'2boys | Рен, smiling | Gojo, standing'});assert.equal(r.slots[0].description,'boy, slim, blonde hair, smiling');assert.equal(r.body.parameters.v4_negative_prompt.caption.char_captions[1].char_caption,'spiky hair');});
test('style selector overrides active style and includes linked negative',async()=>{const {catalog,s}=await seeded();s.styles.push({...catalog.makeStyle('Other'),value:'watercolor',negative:'oil paint'});const r=catalog.buildNativeRequest(s,{prompt:'portrait',style:'Other',characters:['Ren']});assert.equal(r.body.input,'watercolor, portrait');assert.equal(r.body.parameters.negative_prompt,'watermark, oil paint');});
test('V5 strict photo fails; text mode records every omitted photo',async()=>{const {catalog,s}=await seeded();Object.assign(s.novelCharacters[0],{imagePath:'/ref.png',referenceEnabled:true});s.referencePolicy='strict';assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren']}),/V4.5/);s.referencePolicy='text-only';const r=catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren']});assert.equal(r.skippedReferences.length,1);assert.equal(r.activeReferences.length,0);});
test('V4.5 plans actual precise refs and rejects incompatible Vibe combination',async()=>{const {catalog,s}=await seeded();Object.assign(s,{model:'nai-diffusion-4-5-full',referencePolicy:'strict'});Object.assign(s.novelCharacters[0],{imagePath:'/ren.png',referenceEnabled:true});Object.assign(s.styles[0],{imagePath:'/style.png',referenceEnabled:true});const r=catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren']});assert.equal(r.activeReferences.length,2);s.styles[0].referenceMode='vibe';assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren']}),/нельзя использовать вместе/);});
test('Medium cannot discard custom negatives silently',async()=>{const {catalog,s}=await seeded();s.model='nai-diffusion-5-full-medium';assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren']}),/фиксированный негатив/);});
test('positioning applies identical centers to both native captions',async()=>{const {catalog,s}=await seeded();const r=catalog.buildNativeRequest(s,{prompt:'portrait',characters:[{name:'Ren',center:{x:.25,y:.7}}]});assert.equal(r.body.parameters.v4_prompt.use_coords,true);assert.equal(r.body.parameters.v4_prompt.caption.char_captions[0].centers[0].x,.25);assert.equal(r.body.parameters.v4_negative_prompt.caption.char_captions[0].centers[0].y,.7);assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:[{name:'Ren',center:{x:2,y:0}}]}),/between/);});
test('library is unlimited, request enforces model character cap',async()=>{const {catalog,s}=await seeded();s.novelCharacters=Array.from({length:300},(_,i)=>({...catalog.makeCharacter(`c${i}`),description:'boy'}));const r=catalog.buildNativeRequest(s,{prompt:'group',characters:s.novelCharacters.slice(0,22).map(c=>c.name)});assert.equal(r.slots.length,22);assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'group',characters:s.novelCharacters.slice(0,23).map(c=>c.name)}),/up to 22/);});
test('parser persists selection/negative/style through legacy upgrade and regen',async()=>{const {parser}=await seeded();const text='[IMG:GEN:'+JSON.stringify({prompt:'garden',characters:[{name:'Ren',prompt:'smiling'}],negative_prompt:'fog',style_id:'s1',aspect_ratio:'2:3'})+']';const [tag]=await parser.parseImageTags(text);assert.equal(tag.characters[0].name,'Ren');assert.equal(tag.negativePrompt,'fog');const saved=parser.buildPersistedImageTag(tag,'/user/images/test.png');const [again]=await parser.parseImageTags(saved,{forceAll:true});assert.equal(again.characters[0].name,'Ren');assert.equal(again.styleId,'s1');assert.equal(again.negativePrompt,'fog');});
test('custom fields survive style normalization / settings reload',async()=>{const {settings,s}=await seeded();Object.assign(s.styles[0],{imagePath:'/image.png',referenceEnabled:true,fidelity:.6});settings.ensureStyles(s);assert.equal(s.styles[0].negative,'flat shading');assert.equal(s.styles[0].imagePath,'/image.png');assert.equal(settings.getSettings().styles[0].fidelity,.6);});
test('unrecognized tag style cannot replace active library style or lose its negative',async()=>{
 const {catalog,s}=await seeded();const r=catalog.buildNativeRequest(s,{prompt:'portrait',style:'cinematic anime',characters:['Ren']});
 assert.equal(r.body.input,'painterly, portrait');assert.equal(r.body.parameters.negative_prompt,'watermark, flat shading');assert.equal(r.style.id,s.activeStyleId);assert.equal(r.style.selectionSource,'active-fallback');assert.ok(r.warnings.some(w=>w.includes('активный стиль')));
 assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',style_id:'missing'}),/не найден/);
});
test('legacy raw style matching a library value retains the linked negative',async()=>{
 const {catalog,s}=await seeded();const r=catalog.buildNativeRequest(s,{prompt:'portrait',style:'painterly',characters:['Ren']});assert.equal(r.style.id,s.activeStyleId);assert.equal(r.body.parameters.negative_prompt,'watermark, flat shading');
});
test('all selectable model IDs remain exact, V5 uses fixed Karras, JSON aliases match request settings',async()=>{
 const {catalog,s}=await seeded();for(const model of ['nai-diffusion-5-full','nai-diffusion-5-curated','nai-diffusion-4-5-full','nai-diffusion-4-5-curated']){
 s.model=model;s.novelaiNoiseSchedule='exponential';const r=catalog.buildNativeRequest(s,{prompt:'portrait',characters:['Ren'],aspect_ratio:'2:3',negative_prompt:'fog'});assert.equal(r.body.model,model);assert.equal(r.body.parameters.width,832);assert.equal(r.body.parameters.height,1216);assert.equal(r.body.parameters.noise_schedule,model.startsWith('nai-diffusion-5-')?'karras':'exponential');assert.equal(r.body.parameters.negative_prompt,'watermark, flat shading, fog');
 }
});
test('web UC and quality presets expand in native base captions without changing character slots',async()=>{
 const {catalog,s}=await seeded();Object.assign(s,{novelaiUcPreset:'heavy',novelaiNegativeNsfw:true,novelaiQualityPreset:'standard',novelaiSeed:424242});
 const r=catalog.buildNativeRequest(s,{prompt:'2boys, garden',characters:['Ren','Gojo']});const p=r.body.parameters;
 const heavy='lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
 assert.equal(r.body.model,'nai-diffusion-5-full');assert.equal(p.seed,424242);
 assert.equal(r.body.input,'painterly, 2boys, garden, very aesthetic, masterpiece, no text');assert.equal(p.v4_prompt.caption.base_caption,r.body.input);
 assert.equal(p.negative_prompt,`nsfw, ${heavy}, watermark, flat shading`);assert.equal(p.v4_negative_prompt.caption.base_caption,p.negative_prompt);
 assert.equal(p.v4_prompt.caption.char_captions[0].char_caption,'boy, slim, blonde hair');assert.equal(p.v4_negative_prompt.caption.char_captions[0].char_caption,'muscles');
 assert.equal(p.v4_prompt.legacy_uc,false);assert.equal(p.v4_negative_prompt.use_order,false);assert.equal(p.v4_negative_prompt.use_coords,false);
 assert.equal(p.qualityToggle,false);assert.equal(p.ucPreset,3);assert.equal(r.presets.ucPreset,'heavy');assert.equal(r.presets.undesiredTags,`nsfw, ${heavy}`);
 const again=catalog.buildNativeRequest(s,{prompt:'2boys, garden',characters:['Ren','Gojo']});assert.deepEqual(JSON.parse(JSON.stringify(again.body)),JSON.parse(JSON.stringify(r.body)));
});
test('presets follow model, preserve Text blocks and keep coordinates aligned',async()=>{
 const {catalog,s}=await seeded();Object.assign(s,{novelaiQualityPreset:'light',novelaiUcPreset:'light'});
 let r=catalog.buildNativeRequest(s,{prompt:'portrait\n\nText: HELLO',characters:[{name:'Ren',center:{x:.2,y:.4}}]});
 assert.equal(r.body.input,'painterly, portrait, very aesthetic, amazing quality, no text\n\nText: HELLO');assert.ok(r.warnings.some(w=>w.includes('no text')));
 assert.ok(r.body.parameters.negative_prompt.startsWith('lowres, bad hands, bad anatomy, artistic error, sepia, white haze'));
 assert.equal(r.body.parameters.v4_negative_prompt.use_coords,true);
 s.model='nai-diffusion-4-5-curated';s.novelaiUcPreset='human';r=catalog.buildNativeRequest(s,{prompt:'portrait',characters:[]});
 assert.ok(r.body.input.endsWith('location, masterpiece, no text, -0.8::feet::, rating:general'));assert.ok(r.body.parameters.negative_prompt.startsWith('blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands'));
 s.novelaiUcPreset='invalid';assert.throws(()=>catalog.buildNativeRequest(s,{prompt:'portrait',characters:[]}),/Unknown NovelAI UC preset/);
});
test('new preset settings survive connection profile save/load without modifying libraries',async()=>{
 const {settings,s}=await seeded();Object.assign(s,{novelaiQualityPreset:'standard',novelaiUcPreset:'heavy',novelaiNegativeNsfw:true});
 const p=settings.createConnectionProfile('Website settings',s);Object.assign(s,{novelaiQualityPreset:'none',novelaiUcPreset:'none',novelaiNegativeNsfw:false});
 settings.loadConnectionProfile(p.id,s);assert.equal(s.novelaiQualityPreset,'standard');assert.equal(s.novelaiUcPreset,'heavy');assert.equal(s.novelaiNegativeNsfw,true);assert.equal(s.styles[0].value,'painterly');
});
test('PNG repeat preserves native inputs and seed despite different active library and presets',async()=>{
 const {catalog,png,s}=await seeded();s.novelaiSeed=424242;const source=catalog.buildNativeRequest(s,{prompt:'2boys, park',characters:[{name:'Ren',center:{x:.3,y:.5}},'Gojo']}).body;
 const metadata={...JSON.parse(JSON.stringify(source.parameters)),model_name:'NovelAI Diffusion V5',request_type:'PromptGenerateRequest',signed_hash:'private-not-forwarded',stream:'msgpack',extra_passthrough_testing:{prompt:'not-forwarded'}};
 delete metadata.negative_prompt;metadata.uc=source.parameters.negative_prompt;
 Object.assign(s,{novelaiSeed:999,novelaiQualityPreset:'standard',novelaiUcPreset:'human',globalNegative:'unrelated'});s.styles[0].value='unrelated style';s.novelCharacters[0].description='unrelated appearance';
 const r=png.buildPNGRequest(s,{Comment:JSON.stringify(metadata)});
 assert.equal(r.body.input,source.input);assert.equal(r.body.parameters.seed,424242);assert.equal(r.body.parameters.negative_prompt,source.parameters.negative_prompt);
 assert.deepEqual(JSON.parse(JSON.stringify(r.body.parameters.v4_prompt)),JSON.parse(JSON.stringify(source.parameters.v4_prompt)));assert.deepEqual(JSON.parse(JSON.stringify(r.body.parameters.v4_negative_prompt)),JSON.parse(JSON.stringify(source.parameters.v4_negative_prompt)));
 assert.equal(r.body.parameters.signed_hash,undefined);assert.equal(r.body.parameters.extra_passthrough_testing,undefined);assert.equal(r.body.parameters.stream,undefined);
 assert.throws(()=>png.buildPNGRequest(s,{...metadata,director_reference_strengths:[.8]}),/фото-референсы/);
 s.model='nai-diffusion-4-5-full';assert.throws(()=>png.buildPNGRequest(s,metadata),/семейством/);
 s.model='nai-diffusion-5-full-medium';assert.throws(()=>png.buildPNGRequest(s,metadata),/Medium/);
});
