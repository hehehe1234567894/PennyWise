/**
 * dsh-vision-unlock 冒烟测试（模拟 pi-ai 适配器与 Models 集合的形状）
 * 运行：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" smoke.mjs
 * 从 <profile>/node_modules/@local/dsh-vision-unlock 运行时可解析 schemastery。
 */
import assert from 'node:assert';
// 绝对路径导入已安装的插件：其内部对 @deepseek-ai/schemastery 的依赖
// 会沿 node_modules 链解析到 <profile>/node_modules。
import { apply } from 'file:///C:/Users/zxq07/.dsh/profiles/desktop/node_modules/@local/dsh-vision-unlock/dist/index.js';

// —— 模拟 pi-ai ModelsImpl：方法在原型上，实例字段可被插件实例级覆盖 ——
class FakeModels {
	#providers = new Map();
	constructor(table) { for (const [p, models] of Object.entries(table)) this.#providers.set(p, models); }
	getModels(provider) {
		if (provider !== undefined) return [...(this.#providers.get(provider) ?? [])];
		return [...this.#providers.values()].flat();
	}
	getModel(provider, id) { return this.getModels(provider).find((m) => m.id === id); }
}

// —— 模拟 pi-ai 适配器（current() 带快照记忆）——
function fakePiAiAdapter(table) {
	const models = new FakeModels(table);
	const snapshot = { profiles: {}, models };
	const adapter = {
		snapshot: undefined,
		current() {
			if (this.snapshot_ === undefined) this.snapshot_ = snapshot;
			return this.snapshot_;
		},
		snapshot_: undefined,
		listModels(provider) { return Promise.resolve(models.getModels(provider).map((m) => ({ provider, id: m.id, name: m.name, inputModalities: [...m.input] }))); },
		resolveModel(provider, model) { const m = models.getModel(provider, model); return Promise.resolve({ provider, id: model, name: m.name, inputModalities: [...m.input] }); },
		async prepareCall(provider, model) { const m = models.getModel(provider, model); return { model: { provider, id: model, name: m.name, inputModalities: [...m.input] }, stream() {} }; }
	};
	return adapter;
}

// —— 模拟通用适配器（无 current/snapshot）——
function fakeGenericAdapter() {
	return {
		listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text'] }],
		resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
		prepareCall: async (provider, model) => ({ model: { provider, id: model, name: model, inputModalities: ['text'] }, stream() {} })
	};
}

const piAi = fakePiAiAdapter({
	'zai-coding-cn': [
		{ id: 'glm-5.3-flash', name: 'glm-5.3-flash', provider: 'zai-coding-cn', input: ['text'] },
		{ id: 'glm-5.2', name: 'GLM-5.2', provider: 'zai-coding-cn', input: ['text'] }
	],
	xiaomi: [{ id: 'mimo-v2.5', name: 'MiMo', provider: 'xiaomi', input: ['text'] }]
});
const generic = fakeGenericAdapter();

const listeners = {};
const ctx = {
	llm: { adapters: new Map([['zai-coding-cn', { adapter: piAi }], ['deepseek', { adapter: generic }]]) },
	logger: console,
	on(name, fn) { (listeners[name] ??= []).push(fn); return () => {}; }
};

const config = {
	enabled: true,
	verbose: false,
	models: [
		{ provider: '*', model: 'glm-5.3-flash', input: ['text', 'image'] },
		{ provider: 'xiaomi', model: 'mimo-*' }
	]
};

await apply(ctx, config);

// 1) pi-ai Models 集合被覆盖
const m1 = piAi.current().models.getModel('zai-coding-cn', 'glm-5.3-flash');
assert.deepStrictEqual(m1.input, ['text', 'image'], 'glm-5.3-flash input 应被覆盖');
const m2 = piAi.current().models.getModel('xiaomi', 'mimo-v2.5');
assert.deepStrictEqual(m2.input, ['text', 'image'], 'mimo 通配应覆盖（默认 [text,image]）');
const m3 = piAi.current().models.getModel('zai-coding-cn', 'glm-5.2');
assert.deepStrictEqual(m3.input, ['text'], '未匹配的模型保持原样');
assert.strictEqual(piAi.current().models.getModel('zai-coding-cn', 'nope'), undefined, '未知模型仍返回 undefined');

// 2) 适配器元数据（门禁/catalog 路径）被覆盖
const listed = await piAi.listModels('zai-coding-cn');
assert.deepStrictEqual(listed.find((m) => m.id === 'glm-5.3-flash').inputModalities, ['text', 'image'], 'listModels 应带 image');
const resolved = await piAi.resolveModel('zai-coding-cn', 'glm-5.3-flash');
assert.deepStrictEqual(resolved.inputModalities, ['text', 'image'], 'resolveModel 应带 image');
const prepared = await piAi.prepareCall('zai-coding-cn', 'glm-5.3-flash');
assert.deepStrictEqual(prepared.model.inputModalities, ['text', 'image'], 'prepareCall 应带 image');

// 3) 通用适配器也覆盖
assert.deepStrictEqual((await generic.resolveModel('deepseek', 'deepseek-chat')).inputModalities, ['text'], '无匹配条目时不改写');
const generic2 = fakeGenericAdapter();
ctx.llm.adapters.set('openai', { adapter: generic2 });
for (const fn of listeners['llm/adapters-updated'] ?? []) fn();
assert.deepStrictEqual((await generic2.listModels('deepseek')).map((m) => m.inputModalities), [['text']], '后续注册的适配器在事件后被挂接（无匹配不改写）');

// 4) 收窄：input:[text] 能把目录里带 image 的模型收窄回去
const narrowed = fakePiAiAdapter({ p: [{ id: 'glm-x', name: 'x', provider: 'p', input: ['text', 'image'] }] });
const ctx2 = { llm: { adapters: new Map([['p', { adapter: narrowed }]]) }, logger: console, on: () => () => {} };
await apply(ctx2, { enabled: true, verbose: false, models: [{ provider: 'p', model: 'glm-x', input: ['text'] }] });
assert.deepStrictEqual(narrowed.current().models.getModel('p', 'glm-x').input, ['text'], '收窄到 [text] 生效');

// 5) enabled=false 清空覆盖
await apply(ctx, { enabled: false, verbose: false, models: config.models });
assert.deepStrictEqual(piAi.current().models.getModel('zai-coding-cn', 'glm-5.3-flash').input, ['text'], 'enabled=false 后不再改写');

console.log('SMOKE OK — 12 项断言全部通过');
