/**
 * dsh-vision-unlock — 模型图片输入能力覆盖插件 for deepseek-harness (dsh)
 *
 * 解决的问题：settings.yaml 里手工声明的模型（如 zai-coding-cn/glm-5.3-flash）
 * 不写 `input` 时，pi-ai 适配器默认只报 ["text"]，于是：
 *   - dsh-host-apiproxy 在发消息时用 MODEL_DOES_NOT_SUPPORT_IMAGES 拦下图片；
 *   - 模型目录/选择器也认为该模型不能看图。
 * 而模型本身（GLM-5.3-Flash 为官方原生多模态）其实支持图片输入。
 *
 * 本插件在运行时内存里做"输入模态覆盖"，不改任何 DSH 文件：
 *   1) 通用层：包裹每个已注册适配器的 listModels / resolveModel / prepareCall，
 *      改写返回元数据里的 inputModalities —— 覆盖模型目录、发消息门禁、
 *      以及 LlmRuntime 派发前的图片→文本投影判定；
 *   2) pi-ai 层：包裹 pi-ai 适配器的 current() 快照，改写其 Models 集合的
 *      getModel/getModels —— 这样 pi-ai 内部序列化也认为模型收图，
 *      会真正把图片以 base64 image_url 发给 OpenAI 兼容端点。
 *
 * 配置见 Config；每次 apply（含热重载/配置变更）都会刷新覆盖条目，
 * 无需重启。适配器随后注册/更换时通过 `llm/adapters-updated` 事件自动重新挂接。
 *
 * 移植到其它设备：把整个包目录拷到目标 DSH 的
 *   <profile>/node_modules/@local/dsh-vision-unlock
 * 再把 cordis.patch.yml 里的 insert 段追加到 <profile>/cordis.patch.yml。
 * 详见包内 README.md。
 */
import Schema from '@deepseek-ai/schemastery';

// ── Cordis 插件元数据 ──
export const name = 'vision-unlock';
export const inject = ['llm'];

const DEFAULT_INPUT = ['text', 'image'];

export const Config = Schema.object({
	enabled: Schema.boolean().default(true).description('启用图片输入能力覆盖'),
	verbose: Schema.boolean().default(true).description('在日志中打印覆盖详情'),
	models: Schema.array(Schema.object({
		provider: Schema.string().default('*').description('提供方 id（settings.yaml llm-pi-ai.providers 的键）；* 匹配全部'),
		model: Schema.string().default('*').description('模型 id；支持 * 通配，例如 glm-* 或 *'),
		input: Schema.array(Schema.union(['text', 'image'])).default([...DEFAULT_INPUT]).description('覆盖后的输入模态（也可用来收窄，如 [text]）')
	})).default([]).description('覆盖条目；按声明顺序取第一条匹配')
});

// ── 内部符号（挂在适配器/Models 实例上做一次性挂接守卫）──
const STATE = Symbol('dsh-vision-unlock.state');
const MODELS_WRAPPED = Symbol('dsh-vision-unlock.models');
const LIST_WRAPPED = Symbol('dsh-vision-unlock.list');
const RESOLVE_WRAPPED = Symbol('dsh-vision-unlock.resolve');
const PREPARE_WRAPPED = Symbol('dsh-vision-unlock.prepare');

const escapeRx = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** 通配匹配：空或 '*' 匹配一切；含 '*' 按通配；否则全等。 */
function matchValue(pattern, value) {
	if (pattern === undefined || pattern === null || pattern === '' || pattern === '*') return true;
	if (typeof pattern !== 'string' || typeof value !== 'string') return false;
	if (!pattern.includes('*')) return pattern === value;
	return new RegExp(`^${pattern.split('*').map(escapeRx).join('.*')}$`).test(value);
}

/** 返回应覆盖的输入模态列表；不匹配时返回 undefined。 */
function pick(entries, providerId, modelId) {
	if (!modelId) return undefined;
	for (const entry of entries) {
		if (!matchValue(entry.provider, providerId) || !matchValue(entry.model, modelId)) continue;
		return Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : [...DEFAULT_INPUT];
	}
	return undefined;
}

const warn = (logger, message, error) => {
	try {
		logger.warn?.(`[vision-unlock] ${message}${error ? `: ${error?.message ?? String(error)}` : ''}`);
	} catch { /* 日志失败不影响主流程 */ }
};

/**
 * 在一个 pi-ai Models 集合实例上挂接 getModel/getModels（实例级，一次性）。
 * 只影响该快照；快照随配置变化重建时会再次走到这里（守卫防重复）。
 */
function wrapModels(models, state, logger) {
	if (!models || typeof models.getModels !== 'function' || models[MODELS_WRAPPED]) return;
	try {
		models[MODELS_WRAPPED] = true;
		const origGetModels = models.getModels.bind(models);
		const applyOne = (model, providerId) => {
			const input = pick(state.entries, model?.provider ?? providerId, model?.id);
			return input ? { ...model, input } : model;
		};
		models.getModels = (provider) => origGetModels(provider).map((model) => applyOne(model, provider));
		models.getModel = (provider, id) => {
			const found = origGetModels(provider).find((model) => model?.id === id);
			return found ? applyOne(found, provider) : found;
		};
		if (state.verbose) logger.info?.('[vision-unlock] pi-ai Models 集合已挂接');
	} catch (error) {
		warn(logger, '挂接 pi-ai Models 集合失败', error);
	}
}

/** 通用适配器元数据挂接：任何适配器都覆盖目录、解析与准备调用里的模态。 */
function wrapGeneric(adapter, state, logger) {
	try {
		if (typeof adapter.listModels === 'function' && !adapter[LIST_WRAPPED]) {
			adapter[LIST_WRAPPED] = true;
			const orig = adapter.listModels.bind(adapter);
			adapter.listModels = (provider) => Promise.resolve().then(() => orig(provider)).then((models) => Array.isArray(models)
				? models.map((model) => {
					const input = pick(state.entries, model?.provider ?? provider, model?.id);
					return input ? { ...model, inputModalities: input } : model;
				})
				: models);
		}
		if (typeof adapter.resolveModel === 'function' && !adapter[RESOLVE_WRAPPED]) {
			adapter[RESOLVE_WRAPPED] = true;
			const orig = adapter.resolveModel.bind(adapter);
			adapter.resolveModel = (provider, model, signal) => Promise.resolve().then(() => orig(provider, model, signal)).then((info) => {
				const input = pick(state.entries, info?.provider ?? provider, info?.id ?? model);
				return input ? { ...info, inputModalities: input } : info;
			});
		}
		if (typeof adapter.prepareCall === 'function' && !adapter[PREPARE_WRAPPED]) {
			adapter[PREPARE_WRAPPED] = true;
			const orig = adapter.prepareCall.bind(adapter);
			adapter.prepareCall = async (provider, model, signal) => {
				const call = await orig(provider, model, signal);
				if (call?.model) {
					const input = pick(state.entries, call.model.provider ?? provider, call.model.id ?? model);
					if (input) call.model = { ...call.model, inputModalities: input };
				}
				return call;
			};
		}
	} catch (error) {
		warn(logger, '挂接适配器元数据方法失败', error);
	}
}

/**
 * 挂接一个适配器（幂等）。首次挂接安装补丁，之后每次调用仅刷新覆盖条目，
 * 因此配置热更新无需重建补丁。
 * @returns 是否为首次挂接。
 */
function wrapAdapter(adapter, entries, verbose, logger) {
	if (!adapter || typeof adapter !== 'object') return false;
	let state = adapter[STATE];
	const fresh = state === undefined;
	if (fresh) {
		state = { entries: [], verbose };
		try {
			Object.defineProperty(adapter, STATE, { value: state, configurable: true });
		} catch {
			adapter[STATE] = state;
		}
		// pi-ai 适配器：包一层 current()，让每个新快照里的 Models 集合都被挂接
		if (typeof adapter.current === 'function') {
			const origCurrent = adapter.current.bind(adapter);
			adapter.current = () => {
				const snapshot = origCurrent();
				try {
					if (snapshot?.models) wrapModels(snapshot.models, state, logger);
				} catch (error) {
					warn(logger, '挂接适配器快照失败', error);
				}
				return snapshot;
			};
			try {
				if (adapter.snapshot?.models) wrapModels(adapter.snapshot.models, state, logger);
			} catch { /* 快照尚不存在，等下一次 current() */ }
		}
		wrapGeneric(adapter, state, logger);
	}
	state.entries = entries;
	state.verbose = verbose;
	return fresh;
}

export async function apply(ctx, config) {
	const logger = ctx.logger ?? console;
	const enabled = config.enabled !== false;
	const verbose = config.verbose !== false;
	const entries = (Array.isArray(config.models) ? config.models : [])
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => ({
			provider: typeof entry.provider === 'string' && entry.provider.length > 0 ? entry.provider : '*',
			model: typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : '*',
			input: Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : [...DEFAULT_INPUT]
		}));

	const rescan = () => {
		let freshCount = 0;
		try {
			const adapters = ctx.llm?.adapters;
			if (adapters && typeof adapters.values === 'function') {
				for (const registration of adapters.values()) {
					if (wrapAdapter(registration?.adapter ?? registration, enabled ? entries : [], verbose, logger)) freshCount++;
				}
			}
		} catch (error) {
			warn(logger, '扫描已注册适配器失败', error);
		}
		return freshCount;
	};

	// 立即挂接现有适配器；之后再注册/更换的由事件兜底（发射点：LlmRuntime.registerAdapter/replace）
	const freshCount = rescan();
	if (verbose) {
		logger.info?.(`[vision-unlock] 覆盖已应用（enabled=${enabled}，新挂接适配器 ${freshCount} 个）：${JSON.stringify(entries)}`);
	}
	try {
		ctx.on('llm/adapters-updated', () => {
			rescan();
			if (verbose) logger.info?.('[vision-unlock] 适配器拓扑变化，覆盖已重新应用');
		});
	} catch (error) {
		warn(logger, '注册 adapters-updated 监听失败（仅影响后续新适配器）', error);
	}
}
