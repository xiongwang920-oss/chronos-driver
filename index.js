import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const ID = 'chronos-driver';
const DEFAULTS = {
    day: 1, hour: 8, minute: 0,   // 当前剧情时间
    mode: 'transition',           // transition | scene | summary
    insertMode: 'system',         // system | user
    autoGenerate: true,
    floatMode: false,
    note: '',
};
const settings = extension_settings[ID] ??= {};
for (const [key, value] of Object.entries(DEFAULTS)) if (settings[key] === undefined) settings[key] = value;

const $ = window.jQuery;
const DAY_MINUTES = 1440;
const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
};
// 酒馆各版本的导出略有差异，这些统一走动态导入，缺了就只影响单个功能，不会把整个插件拖垮
async function scriptApi() {
    return import('../../../../script.js');
}

/* ============================================================
   时间解析
   目标是听懂「一天后」「3 小时」「半小时」「两天半」「明天早上」这类写法。
   认不出来时报错让用户换个说法，而不是猜——剧情时间偷偷跑偏比报错更糟。
   ============================================================ */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9, 十: 10, 拾: 10 };
const UNIT_MINUTES = { 分钟: 1, 分: 1, 小时: 60, 钟头: 60, 天: DAY_MINUTES, 日: DAY_MINUTES, 星期: 7 * DAY_MINUTES, 周: 7 * DAY_MINUTES, 月: 30 * DAY_MINUTES, 年: 365 * DAY_MINUTES };
const TIME_WORDS = [
    { re: /清晨|拂晓|黎明|凌晨/, hour: 5 },
    { re: /早上|早晨|一早|上午/, hour: 8 },
    { re: /中午|正午|晌午/, hour: 12 },
    { re: /下午|午后/, hour: 14 },
    { re: /傍晚|黄昏|日落|擦黑/, hour: 18 },
    { re: /晚上|夜里|夜晚|入夜|晚间/, hour: 20 },
    { re: /深夜|半夜|午夜|子夜/, hour: 0 },
];
const DAY_WORDS = [
    { re: /大后天/, days: 3 },
    { re: /后天/, days: 2 },
    { re: /明天|次日|翌日|隔天/, days: 1 },
];

function parseChineseNumber(text) {
    if (text == null) return null;
    if (/^[0-9]+(\.[0-9]+)?$/.test(text)) return parseFloat(text);
    let total = 0;
    let section = 0;
    let has = false;
    for (const ch of text) {
        if (CN_DIGITS[ch] === undefined) return null;
        has = true;
        if (ch === '十' || ch === '拾') {
            section = (section || 1) * 10;
            total += section;
            section = 0;
        } else {
            section = section * 10 + CN_DIGITS[ch];
        }
    }
    return has ? total + section : null;
}

// 返回 { matched, minutes, dayOffset, atHour, label }
function parseTimeInput(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { matched: false };
    const backward = /前|以前|之前|倒回|回到|回溯/.test(text);
    let minutes = 0;
    let dayOffset = 0;
    let atHour = null;
    let hit = false;

    // 1) 「半小时」这类没有明确数字的写法
    if (/半(?:个)?(?:小时|钟头)/.test(text)) {
        minutes += 30;
        hit = true;
    }
    // 2) 数字 + 单位，支持连写（「1 天 3 小时」）
    const unitRe = /([0-9]+(?:\.[0-9]+)?|[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾]+)\s*(?:个)?(分钟|小时|钟头|分|天|日|星期|周|月|年)/g;
    let match;
    while ((match = unitRe.exec(text))) {
        const amount = parseChineseNumber(match[1]);
        const unitMinutes = UNIT_MINUTES[match[2]];
        if (amount == null || !unitMinutes) continue;
        let value = amount;
        // 「两天半」：数字单位之后紧跟「半」，补半个单位
        if (text.slice(unitRe.lastIndex, unitRe.lastIndex + 1) === '半') {
            value += 0.5;
            unitRe.lastIndex += 1;
        }
        minutes += value * unitMinutes;
        hit = true;
    }
    // 3) 日期词
    for (const item of DAY_WORDS) {
        if (item.re.test(text)) {
            dayOffset = Math.max(dayOffset, item.days);
            hit = true;
        }
    }
    // 4) 时段词
    for (const item of TIME_WORDS) {
        if (item.re.test(text)) {
            atHour = item.hour;
            hit = true;
            break;
        }
    }
    if (!hit) return { matched: false };
    if (backward) {
        minutes = -minutes;
        dayOffset = -dayOffset;
    }
    return { matched: true, minutes, dayOffset, atHour, label: text };
}

/* ============================================================
   剧情时钟
   ============================================================ */

function currentClock() {
    return {
        day: clamp(settings.day, 1, 99999, 1),
        hour: clamp(settings.hour, 0, 23, 8),
        minute: clamp(settings.minute, 0, 59, 0),
    };
}
function clockToMinutes(clock) {
    return (clock.day - 1) * DAY_MINUTES + clock.hour * 60 + clock.minute;
}
function minutesToClock(total) {
    let value = Math.max(0, Math.round(total));
    const day = Math.floor(value / DAY_MINUTES) + 1;
    value %= DAY_MINUTES;
    return { day, hour: Math.floor(value / 60), minute: value % 60 };
}
function clockLabel(clock) {
    return `第 ${clock.day} 天 ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}
function humanSpan(minutes) {
    const units = [['年', 365 * DAY_MINUTES], ['个月', 30 * DAY_MINUTES], ['天', DAY_MINUTES], ['小时', 60], ['分钟', 1]];
    let rest = Math.abs(minutes);
    const parts = [];
    for (const [unit, size] of units) {
        if (!rest || rest < size) continue;
        const count = Math.floor(rest / size);
        rest -= count * size;
        parts.push(`${count} ${unit}`);
    }
    if (!parts.length) parts.push('不到 1 分钟');
    return parts.join(' ');
}
// 推进规则：
//   只给时长      → 直接相加
//   给了「明天」   → 先跳到目标那天的同一时刻，再按需覆盖时间点
//   只给时间点    → 取「下一个该时刻」；若今天还没到就是今天，已经过了就是明天
// 关键是先算出目标「日期」，再在日期上设时刻，否则「晚上出发去明天早上」会被算成第 3 天。
function applyAdvance(clock, parsed) {
    const original = clockToMinutes(clock);
    let target = original + parsed.minutes;
    if (parsed.dayOffset) target += parsed.dayOffset * DAY_MINUTES;
    if (parsed.atHour !== null) {
        const dayIndex = Math.floor(target / DAY_MINUTES);
        target = dayIndex * DAY_MINUTES + parsed.atHour * 60;
        // 既没给日期也没给时长时，「早上」这种说法要看当天是否已经过去
        if (!parsed.dayOffset && !parsed.minutes && target < original) target += DAY_MINUTES;
    }
    return minutesToClock(Math.max(0, target));
}

/* ============================================================
   指令文本
   ============================================================ */

const MODE_BODY = {
    transition: '先用一到两段简短交代这段时间里各方各自的动向与状态变化（谁在哪、做了什么、关系和心境有无变化），再描写当前时刻的场景，从上一幕中断的地方自然接续。',
    scene: '跳过这段时间的经过，直接描写当前时刻的场景，从上一幕中断的地方自然接续。',
    summary: '只简述这段时间里发生了什么，不展开新的场景，把镜头停在当前时刻。',
};
function buildInstruction(input, from, to, mode, note) {
    const span = humanSpan(clockToMinutes(to) - clockToMinutes(from));
    const lines = [
        '【时间推进】',
        `用户指令：${input}`,
        `剧情时间从「${clockLabel(from)}」推进到「${clockLabel(to)}」，跨度 ${span}。`,
        MODE_BODY[mode] ?? MODE_BODY.transition,
        '要求：直接写正文，不要输出「时间推进」这类标签、标题或括号说明；保持原有的叙事人称与文风；不要让角色凭空出现在原地，也不要重复已经写过的内容。',
    ];
    if (note) lines.push(`补充说明：${note}`);
    return lines.join('\n');
}

/* ============================================================
   执行推进
   ============================================================ */

let lastSkip = null;   // 撤销用：记录上一次推进前的时钟

function requireChat() {
    const context = getContext();
    if (!Array.isArray(context.chat) || !context.chat.length) throw new Error('当前没有聊天记录，请先开始一个聊天。');
    return context;
}
async function pushMessage(message) {
    const context = getContext();
    context.chat.push(message);
    const api = await scriptApi();
    // 先渲染再存盘：addOneMessage 会把新消息插到聊天界面里
    if (typeof api.addOneMessage === 'function') api.addOneMessage(message);
    if (typeof api.saveChat === 'function') await api.saveChat();
    else if (typeof context.saveChat === 'function') await context.saveChat();
}
async function runTimeSkip(input, { notify = true } = {}) {
    requireChat();
    const text = String(input ?? '').trim();
    if (!text) throw new Error('请输入要推进的时间，例如「一天后」。');
    const parsed = parseTimeInput(text);
    if (!parsed.matched) {
        throw new Error('没能识别出时间跨度。可以写成「一天后」「3 小时」「半小时」「两天半」「明天早上」这类形式。');
    }
    const from = currentClock();
    const to = applyAdvance(from, parsed);
    const instruction = buildInstruction(text, from, to, settings.mode, settings.note);

    if (settings.insertMode === 'user') {
        await pushMessage({ name: getContext().name1, is_user: true, is_system: false, send_date: Date.now(), mes: `（${text}）`, extra: {} });
    }
    await pushMessage({ name: '时间推进', is_user: false, is_system: true, send_date: Date.now(), mes: instruction, extra: {} });

    lastSkip = from;
    settings.day = to.day;
    settings.hour = to.hour;
    settings.minute = to.minute;
    saveSettingsDebounced();
    renderClock();

    if (notify) toast(`已推进到 ${clockLabel(to)}`);
    if (settings.autoGenerate) {
        const api = await scriptApi();
        if (typeof api.Generate !== 'function') throw new Error('当前酒馆版本没有提供 Generate 接口，消息已插入，请手动点发送。');
        await api.Generate('normal');
    }
    return { from, to };
}
function undoLastSkip() {
    if (!lastSkip) return toast('还没有可撤销的推进记录。');
    settings.day = lastSkip.day;
    settings.hour = lastSkip.hour;
    settings.minute = lastSkip.minute;
    lastSkip = null;
    saveSettingsDebounced();
    renderClock();
    toast('已把剧情时间退回上一次推进之前（已生成的消息不会删除）。');
}

/* ============================================================
   界面
   ============================================================ */

function el(tag, className = '', content = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
}
// 沙漏徽标
function emblemSVG(prefix) {
    return `<svg class="chron-emblem-svg" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs><linearGradient id="${prefix}-gold" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#ffd98a"/><stop offset="55%" stop-color="#e0b352"/><stop offset="100%" stop-color="#a8781f"/>
</linearGradient></defs>
<circle cx="24" cy="24" r="21" fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.6" opacity=".55"/>
<path d="M15 9h18M15 39h18" stroke="url(#${prefix}-gold)" stroke-width="2.4" stroke-linecap="round"/>
<path d="M17 9c0 6 7 8 7 12s-7 6-7 12M31 9c0 6-7 8-7 12s7 6 7 12" fill="none" stroke="url(#${prefix}-gold)" stroke-width="2" stroke-linejoin="round"/>
<path d="M18.5 36c0-4 5.5-6 5.5-9 0 3 5.5 5 5.5 9z" fill="url(#${prefix}-gold)" opacity=".85"/>
<path d="M4 24h6M38 24h6" stroke="#e0b352" stroke-width="2" stroke-linecap="round" opacity=".8"/>
</svg>`;
}
function toast(message) {
    try {
        if (typeof window.toastr?.success === 'function') return window.toastr.success(message, '时间推进器');
    } catch { /* 退回控制台 */ }
    console.info('[时间推进器]', message);
}
function renderClock() {
    const clock = currentClock();
    $('#chron-clock').text(clockLabel(clock));
    $('#chron-day').val(clock.day);
    $('#chron-hour').val(clock.hour);
    $('#chron-minute').val(clock.minute);
}

function buildUI() {
    const panel = el('div', 'chron-panel');
    panel.id = 'chron-panel';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><span class="chron-emblem">${emblemSVG('title')}</span><b>时间推进器</b><span class="chron-tag">剧情时钟</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
      <div class="chron-hero"><span class="chron-emblem chron-emblem-lg">${emblemSVG('hero')}</span><div class="chron-hero-text"><div class="chron-hero-title">当前剧情时间</div><div id="chron-clock" class="chron-clock">第 1 天 08:00</div></div></div>

      <section class="chron-card"><h4><i class="fa-solid fa-forward"></i>推进时间</h4>
      <label>快速选择<select id="chron-preset" class="text_pole"><option value="">— 自定义 —</option><option value="1小时后">1 小时后</option><option value="半天后">半天后</option><option value="1天后">1 天后</option><option value="3天后">3 天后</option><option value="1周后">1 周后</option><option value="1个月后">1 个月后</option><option value="1小时前">1 小时前</option><option value="1天前">1 天前</option></select></label>
      <label>或直接输入<input id="chron-input" class="text_pole" type="text" placeholder="如：一天后 / 3 小时 / 明天早上"></label>
      <label>补充说明（可选）<input id="chron-note" class="text_pole" type="text" placeholder="如：这段时间她在出差"></label>
      <div class="chron-actions"><button id="chron-go" class="menu_button chron-primary" type="button"><i class="fa-solid fa-hourglass-half"></i>推进剧情</button><button id="chron-undo" class="menu_button" type="button" title="把剧情时间退回这次推进之前"><i class="fa-solid fa-rotate-left"></i>撤销上次</button><button id="chron-float-toggle" class="menu_button" type="button"><i class="fa-solid fa-window-restore"></i><span class="chron-btn-label">浮窗显示</span></button></div>
      </section>

      <section class="chron-card"><h4><i class="fa-solid fa-wand-magic-sparkles"></i>推进后生成</h4>
      <label>生成方式<select id="chron-mode" class="text_pole"><option value="transition">过渡 + 新场景（推荐）</option><option value="scene">直接切到新场景</option><option value="summary">只写过渡小结</option></select></label>
      <label>记录方式<select id="chron-insert" class="text_pole"><option value="system">插一条系统消息（不干扰对话）</option><option value="user">插一条用户消息</option></select></label>
      <label class="chron-check"><input id="chron-auto" type="checkbox">推进后自动触发生成</label>
      </section>

      <section class="chron-card"><h4><i class="fa-solid fa-clock"></i>校准时钟</h4>
      <div class="chron-grid">
      <label>第几天<input id="chron-day" class="text_pole" type="number" min="1" step="1"></label>
      <label>时<input id="chron-hour" class="text_pole" type="number" min="0" max="23" step="1"></label>
      <label>分<input id="chron-minute" class="text_pole" type="number" min="0" max="59" step="1"></label>
      </div>
      <div class="chron-actions"><button id="chron-save-clock" class="menu_button" type="button"><i class="fa-solid fa-floppy-disk"></i>保存当前时间</button></div>
      <div class="chron-hint">换聊天或换角色卡时，建议先把时钟校准到与该剧情一致。也可以在聊天输入框直接打 <b>/t 一天后</b>。</div>
      </section>
      </div></div>`;
    document.querySelector('#extensions_settings')?.append(panel);

    const floatBox = el('div', 'chron-float chron-hidden'); floatBox.id = 'chron-float';
    floatBox.append(el('div', 'chron-float-body'));
    const launcher = el('button', 'chron-launcher chron-hidden'); launcher.id = 'chron-launcher'; launcher.type = 'button';
    launcher.title = '打开时间推进器';
    launcher.setAttribute('aria-label', '打开时间推进器');
    launcher.innerHTML = emblemSVG('launcher');
    document.body.append(floatBox, launcher);

    for (const [selector, key] of Object.entries({ '#chron-mode': 'mode', '#chron-insert': 'insertMode' })) {
        const input = $(selector);
        input.val(settings[key]);
        input.on('change', () => { settings[key] = input.val(); saveSettingsDebounced(); });
    }
    $('#chron-auto').prop('checked', Boolean(settings.autoGenerate)).on('change', function () {
        settings.autoGenerate = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#chron-note').val(settings.note ?? '').on('input', function () {
        settings.note = String($(this).val() ?? '');
        saveSettingsDebounced();
    });
    $('#chron-preset').on('change', function () {
        const value = String($(this).val() ?? '');
        if (value) $('#chron-input').val(value);
    });
    $('#chron-go').on('click', () => {
        // 输入框优先，为空时退回下拉里选的那一项
        const input = String($('#chron-input').val() ?? '').trim() || String($('#chron-preset').val() ?? '').trim();
        runTimeSkip(input).catch(error => {
            toast(error.message);
            console.warn('[时间推进器]', error);
        });
    });
    $('#chron-undo').on('click', undoLastSkip);
    $('#chron-save-clock').on('click', () => {
        settings.day = clamp($('#chron-day').val(), 1, 99999, 1);
        settings.hour = clamp($('#chron-hour').val(), 0, 23, 8);
        settings.minute = clamp($('#chron-minute').val(), 0, 59, 0);
        saveSettingsDebounced();
        renderClock();
        toast(`时钟已设为 ${clockLabel(currentClock())}`);
    });
    $('#chron-float-toggle').on('click', () => { settings.floatMode = !settings.floatMode; saveSettingsDebounced(); applyPanelMode(); });
    launcher.addEventListener('click', () => { settings.floatMode = true; saveSettingsDebounced(); applyPanelMode(); });
    applyPanelMode();
    renderClock();
    return panel;
}

function applyPanelMode() {
    const panel = document.getElementById('chron-panel');
    const floatBox = document.getElementById('chron-float');
    const launcher = document.getElementById('chron-launcher');
    if (!panel || !floatBox || !launcher) return;
    $('#chron-float-toggle .chron-btn-label').text(settings.floatMode ? '收回设置页' : '浮窗显示');
    if (!settings.floatMode) {
        if (panel.parentElement !== document.querySelector('#extensions_settings')) {
            document.querySelector('#extensions_settings')?.append(panel);
        }
        floatBox.classList.add('chron-hidden');
        launcher.classList.add('chron-hidden');
        return;
    }
    floatBox.querySelector('.chron-float-body').append(panel);
    floatBox.classList.remove('chron-hidden');
    launcher.classList.add('chron-hidden');
    const content = panel.querySelector('.inline-drawer-content');
    if (content && window.getComputedStyle(content).display === 'none') $(content).slideDown();
}

/* ============================================================
   斜杠命令：/t 一天后
   注册失败不影响面板按钮，所以整段包在 try 里。
   ============================================================ */

async function registerSlashCommand() {
    try {
        const [{ SlashCommandParser }, { SlashCommand }, { SlashCommandArgument, ARGUMENT_TYPE }] = await Promise.all([
            import('../../../slash-commands/SlashCommandParser.js'),
            import('../../../slash-commands/SlashCommand.js'),
            import('../../../slash-commands/SlashCommandArgument.js'),
        ]);
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 't',
            aliases: ['timeskip', '推进'],
            helpString: '推进剧情时间，例如 <code>/t 一天后</code>、<code>/t 3 小时</code>、<code>/t 明天早上</code>。',
            returns: '推进结果',
            unnamedArgumentList: [new SlashCommandArgument('时间', [ARGUMENT_TYPE.STRING], true)],
            callback: async (_args, value) => {
                const result = await runTimeSkip(value, { notify: false });
                return `剧情时间已从 ${clockLabel(result.from)} 推进到 ${clockLabel(result.to)}。`;
            },
        }));
        console.info('[时间推进器] 斜杠命令 /t 已注册');
    } catch (error) {
        console.warn('[时间推进器] 斜杠命令注册失败，面板按钮仍可正常使用：', error);
    }
}

/* ============================================================
   启动
   ============================================================ */

$(function () {
    buildUI();
    registerSlashCommand();
    // 换聊天/换角色只刷新显示，不动时钟——剧情可能跨聊天连续，重置反而更麻烦
    for (const type of [event_types.CHAT_CHANGED, event_types.APP_READY]) {
        eventSource.on(type, () => renderClock());
    }
});
