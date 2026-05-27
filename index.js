import { getContext } from '../../../extensions.js';

const EXT_NAME = 'Chat Article Reader DE';
const STORE_KEY = 'crd_data_v6';
const PAGE_SIZE = 50;

let state = {
    lastChar: '',
    positions: {},
    lastViewed: {},
    fontSize: 'm',
    playMode: 'seq',
    settings: {
        deRate: 1,
        cnRate: 1,
        audioMode: 'cndtmix',
        showDE: true,
        showCN: true,
        showWW: true
    }
};

let charDataCache = {};
let charList = [];
let selectedChar = '';
let selectedArt = -1;
let sentenceIdx = 0;
let pageIdx = 0;
let isPlaying = false;
let playTimer = null;
let speechId = 0;
let voiceList = [];
let mobileScreen = 'list';
let playlistOn = false;
let playlistIdx = 0;
let playlistArts = [];
let tooltipEl = null;
let tooltipTimer = null;
let keepAliveAudio = null;
let renderPending = false;
let panelCreated = false;

function byId(id) {
    return document.getElementById(id);
}

function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
    if (!s) return '';
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isMobile() {
    return window.innerWidth <= 768;
}

function showToast(msg) {
    let t = byId('crd-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'crd-toast';
        t.className = 'crd-toast';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('on'), 2200);
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
            const d = JSON.parse(raw);
            if (d.lastChar !== undefined) state.lastChar = d.lastChar;
            if (d.positions) state.positions = d.positions;
            if (d.lastViewed) state.lastViewed = d.lastViewed;
            if (d.fontSize) state.fontSize = d.fontSize;
            if (d.playMode) state.playMode = d.playMode;
            if (d.settings) {
                const s = d.settings;
                if (s.deRate !== undefined) state.settings.deRate = s.deRate;
                if (s.cnRate !== undefined) state.settings.cnRate = s.cnRate;
                if (s.audioMode) state.settings.audioMode = s.audioMode;
                if (s.showDE !== undefined) state.settings.showDE = s.showDE;
                if (s.showCN !== undefined) state.settings.showCN = s.showCN;
                if (s.showWW !== undefined) state.settings.showWW = s.showWW;
            }
        }
    } catch (e) {}
}

function saveState() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
}

function savePos() {
    if (!selectedChar || selectedArt < 0) return;
    if (!state.positions[selectedChar]) state.positions[selectedChar] = {};
    state.positions[selectedChar].a = selectedArt;
    state.positions[selectedChar].s = sentenceIdx;
    state.lastChar = selectedChar;
    state.lastViewed[selectedChar] = selectedArt;
    saveState();
}

function cleanMsg(raw) {
    let t = raw || '';
    t = t.replace(/<prepare>[\s\S]*?<\/prepare>/gi, '');
    t = t.replace(/<details>[\s\S]*?<\/details>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    const tmp = document.createElement('textarea');
    tmp.innerHTML = t;
    t = tmp.value;
    return t.trim();
}

function isDeLine(line) {
    const de = (line.match(/[a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/g) || []).length;
    const cn = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    return de > cn && de >= 3;
}

function isCnLine(line) {
    return (line.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
}

function isWwLine(line) {
    if (!line) return false;
    const m = line.match(/[a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df][a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df'\u2019\-]*\s*\([^)]*[\u4e00-\u9fff][^)]*\)/g);
    return m && m.length >= 2;
}

function parseMessages(messages, chatFile) {
    const articles = [];
    let floor = 0;

    for (let mi = 0; mi < messages.length; mi++) {
        const msg = messages[mi];
        if (!msg || msg.is_user || msg.is_system) continue;
        if (!msg.mes || !msg.mes.trim()) continue;

        const text = cleanMsg(msg.mes);
        if (!text) continue;

        const rawLines = text.split('\n');
        const lines = [];
        for (let li = 0; li < rawLines.length; li++) {
            const trimmed = rawLines[li].trim();
            if (trimmed) lines.push(trimmed);
        }

        const sents = [];
        let i = 0;
        while (i < lines.length) {
            if (i + 2 < lines.length && isDeLine(lines[i]) && isCnLine(lines[i + 1]) && isWwLine(lines[i + 2])) {
                sents.push({ de: lines[i], cn: lines[i + 1], ww: lines[i + 2] });
                i += 3;
            } else if (i + 1 < lines.length && isDeLine(lines[i]) && isCnLine(lines[i + 1])) {
                sents.push({ de: lines[i], cn: lines[i + 1], ww: '' });
                i += 2;
            } else {
                i++;
            }
        }

        if (!sents.length) continue;
        floor++;

        let title = '#' + floor;
        for (let pi = mi - 1; pi >= 0; pi--) {
            if (messages[pi] && messages[pi].is_user && messages[pi].mes) {
                const ut = cleanMsg(messages[pi].mes);
                if (ut) title = '#' + floor + ' ' + ut.substring(0, 30);
                break;
            }
        }

        articles.push({ title, sentences: sents, floor, chatFile: chatFile || 'current' });
    }

    return articles;
}

async function fetchPost(urls, body) {
    const endpoints = Array.isArray(urls) ? urls : [urls];
    for (const url of endpoints) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (r.ok) return await r.json();
        } catch (e) {}
    }
    return null;
}

async function loadCharData(name, avatar) {
    if (charDataCache[name] && charDataCache[name].loaded) return charDataCache[name];

    const data = { name, articles: [], loaded: false };
    charDataCache[name] = data;

    try {
        const ctx = getContext();
        if (ctx && ctx.name2 === name && ctx.chat && ctx.chat.length > 0) {
            data.articles = parseMessages(ctx.chat, 'current');
        }
    } catch (e) {}

    try {
        const ctx = getContext();
        const av = avatar || (ctx && ctx.characters ? (ctx.characters.find(c => c.name === name) || {}).avatar : '') || '';
        const chatFiles = await fetchPost(['/api/characters/chats', '/getallchatsofcharacter'], { avatar_url: av });

        if (chatFiles && Array.isArray(chatFiles)) {
            let currentFile = '';
            try {
                const ctx2 = getContext();
                if (ctx2 && ctx2.name2 === name && ctx2.chat_metadata && ctx2.chat_metadata.file_name) {
                    currentFile = ctx2.chat_metadata.file_name;
                }
            } catch (e) {}

            for (const cf of chatFiles) {
                const fn = cf.file_name || cf.fileName;
                if (!fn) continue;
                if (currentFile && fn.indexOf(currentFile) >= 0) continue;

                try {
                    const msgs = await fetchPost(['/api/chats/get', '/getchat'], { ch_name: name, file_name: fn, avatar_url: av });
                    if (msgs && Array.isArray(msgs)) {
                        const arts = parseMessages(msgs, fn);
                        for (const a of arts) data.articles.push(a);
                    }
                } catch (e) {}
            }

            for (let i = 0; i < data.articles.length; i++) {
                data.articles[i].floor = i + 1;
            }
        }
    } catch (e) {}

    data.loaded = true;
    return data;
}

function getCharList() {
    const result = [];
    try {
        const ctx = getContext();
        if (!ctx) return result;
        const seen = {};
        const chars = ctx.characters || [];
        for (const c of chars) {
            if (c && c.name && !seen[c.name]) {
                seen[c.name] = true;
                result.push({ name: c.name, avatar: c.avatar || '' });
            }
        }
        if (ctx.name2 && !seen[ctx.name2]) {
            result.push({ name: ctx.name2, avatar: '' });
        }
    } catch (e) {}
    return result;
}

function initVoices() {
    if (!window.speechSynthesis) return;
    const load = () => { voiceList = speechSynthesis.getVoices(); };
    load();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
    setTimeout(load, 2000);
}

function findVoice(lang) {
    if (!voiceList.length) voiceList = speechSynthesis.getVoices();
    const prefix = lang.split('-')[0];
    const matches = voiceList.filter(v => v.lang === lang || v.lang.indexOf(prefix) === 0);
    return matches.find(v => v.localService) || matches[0] || null;
}

function speak(text, lang, rate) {
    return new Promise(resolve => {
        if (!window.speechSynthesis || !text || !text.trim()) { resolve(); return; }
        const u = new SpeechSynthesisUtterance(text.trim());
        u.lang = lang;
        u.rate = Math.max(0.1, Math.min(5, rate || 1));
        const v = findVoice(lang);
        if (v) u.voice = v;
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(tm); resolve(); } };
        const tm = setTimeout(finish, Math.max(8000, text.length * 600));
        u.onend = finish;
        u.onerror = finish;
        try { speechSynthesis.speak(u); } catch (e) { finish(); }
    });
}

function cancelSpeak() {
    try { speechSynthesis.cancel(); } catch (e) {}
}

function speakWord(w) {
    if (!w) return;
    cancelSpeak();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'de-DE';
    u.rate = state.settings.deRate;
    const v = findVoice('de-DE');
    if (v) u.voice = v;
    try { speechSynthesis.speak(u); } catch (e) {}
}

function stopPlay() {
    isPlaying = false;
    clearTimeout(playTimer);
    cancelSpeak();
    speechId++;
    stopKeepAlive();
    updateMS(false);
}

function startKeepAlive() {
    if (keepAliveAudio) return;
    try {
        keepAliveAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        keepAliveAudio.loop = true;
        keepAliveAudio.volume = 0.01;
        keepAliveAudio.play().catch(() => {});
    } catch (e) {}
}

function stopKeepAlive() {
    if (keepAliveAudio) { keepAliveAudio.pause(); keepAliveAudio = null; }
}

function updateMS(playing) {
    if (!('mediaSession' in navigator)) return;
    try {
        const art = getArt();
        navigator.mediaSession.metadata = new MediaMetadata({
            title: art ? art.title : 'Chat Reader DE',
            artist: selectedChar || '',
            album: 'Deutsch'
        });
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
        navigator.mediaSession.setActionHandler('play', () => togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => { stopPlay(); schedRender(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => navSent(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => navSent(1));
    } catch (e) {}
}

function cleanW(w) {
    return (w || '').replace(/^[.,!?;:'"()\-\u2013\u00bb\u00ab\[\]{}\/\\]+/, '').replace(/[.,!?;:'"()\-\u2013\u00bb\u00ab\u2026\[\]{}\/\\]+$/, '').trim();
}

function renderDE(text) {
    if (!text) return '';
    const cleaned = text.replace(/\|/g, '');
    const parts = cleaned.split(/(\s+)/);
    let html = '';
    for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { html += ' '; continue; }
        if (/[a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/.test(part)) {
            const m = part.match(/^([^a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]*)([a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df][a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df'\u2019\-]*[a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]|[a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df])([^a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]*)$/);
            if (m) {
                html += escHtml(m[1]) + '<span class="crd-word" data-w="' + escAttr(cleanW(m[2])) + '">' + escHtml(m[2]) + '</span>' + escHtml(m[3]);
            } else {
                html += '<span class="crd-word" data-w="' + escAttr(cleanW(part)) + '">' + escHtml(part) + '</span>';
            }
        } else {
            html += escHtml(part);
        }
    }
    return html;
}

function hideTip() {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
}

function showTip(el, text) {
    hideTip();
    const r = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'crd-tooltip';
    tip.textContent = text;
    tip.style.left = (r.left + r.width / 2) + 'px';
    if (r.top > 50) {
        tip.style.top = (r.top - 5) + 'px';
        tip.style.transform = 'translateX(-50%) translateY(-100%)';
    } else {
        tip.style.top = (r.bottom + 5) + 'px';
        tip.style.transform = 'translateX(-50%)';
    }
    document.body.appendChild(tip);
    requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect();
        if (tr.right > window.innerWidth - 4) tip.style.left = (window.innerWidth - tr.width / 2 - 4) + 'px';
        if (tr.left < 4) tip.style.left = (tr.width / 2 + 4) + 'px';
        tip.classList.add('visible');
    });
    tooltipEl = tip;
    tooltipTimer = setTimeout(hideTip, 3000);
}

function onWordClick(el) {
    const w = cleanW(el.dataset.w || el.textContent);
    if (!w) return;
    el.classList.add('speaking');
    setTimeout(() => el.classList.remove('speaking'), 1000);
    speakWord(w);
    hideTip();

    let trans = '';
    const cd = charDataCache[selectedChar];
    if (cd && selectedArt >= 0 && cd.articles[selectedArt]) {
        const sents = cd.articles[selectedArt].sentences;
        for (const s of sents) {
            if (!s.ww) continue;
            const rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)', 'i');
            const found = s.ww.match(rx);
            if (found) { trans = found[1]; break; }
        }
    }
    showTip(el, trans || w);
}

function getArt() {
    const d = charDataCache[selectedChar];
    return (d && d.articles && d.articles[selectedArt]) ? d.articles[selectedArt] : null;
}

function createPanel() {
    if (panelCreated) return;
    panelCreated = true;

    const panel = document.createElement('div');
    panel.id = 'crd-panel';
    panel.innerHTML =
        '<div class="crd-topbar">' +
            '<button class="crd-topbar-back" id="crdBack">◀</button>' +
            '<span class="crd-topbar-title" id="crdTitle">📘 Deutsch Reader</span>' +
            '<button class="crd-topbtn" id="crdRefresh" title="刷新">♻</button>' +
            '<button class="crd-topbtn" id="crdSettings" title="设置">⚙</button>' +
            '<button class="crd-topbtn" id="crdClose" title="关闭">✕</button>' +
        '</div>' +
        '<div class="crd-body">' +
            '<div class="crd-sidebar" id="crdSidebar">' +
                '<div class="crd-chartabs" id="crdChars"></div>' +
                '<div class="crd-artlist" id="crdArts"><div class="crd-empty">点击角色卡加载文章</div></div>' +
            '</div>' +
            '<div class="crd-main" id="crdMain">' +
                '<div class="crd-view on" id="crdVWel">' +
                    '<div class="crd-welcome"><div style="font-size:48px">📘</div><h3>Chat Article Reader DE</h3><p>选择左侧角色卡，自动扫描聊天记录。<br>点击德语单词播放发音并显示翻译。<br>支持顺序、循环、随机播放。</p></div>' +
                '</div>' +
                '<div class="crd-view" id="crdVRead">' +
                    '<div class="crd-toolbar" id="crdToolbar"></div>' +
                    '<div class="crd-optbar" id="crdFontBar"></div>' +
                    '<div class="crd-optbar" id="crdModeBar"></div>' +
                    '<div class="crd-plbar" id="crdPL"><span>📋 <b id="crdPLName">—</b></span><button class="crd-topbtn" id="crdPLClose" style="width:24px;height:24px;font-size:11px">✕</button></div>' +
                    '<div class="crd-progress"><div class="crd-progbar"><div class="crd-progfill" id="crdProgFill"></div></div><div class="crd-progmeta"><span id="crdProgIdx">0/0</span><span id="crdProgTitle">—</span></div></div>' +
                    '<div class="crd-pager" id="crdPager"></div>' +
                    '<div class="crd-reader dfs-m" id="crdReader"></div>' +
                    '<div class="crd-controls">' +
                        '<span class="crd-speedbtn" id="crdSpeed">1.0x</span>' +
                        '<button class="crd-ctrl" id="crdPrev">⏮</button>' +
                        '<button class="crd-ctrl playbtn" id="crdPlay">▶️</button>' +
                        '<button class="crd-ctrl" id="crdNext">⏭</button>' +
                        '<button class="crd-ctrl" id="crdLoop">🔁</button>' +
                        '<button class="crd-ctrl" id="crdGoList">📋</button>' +
                    '</div>' +
                '</div>' +
                '<div class="crd-view" id="crdVSet">' +
                    '<div class="crd-setbody" id="crdSetBody"></div>' +
                '</div>' +
            '</div>' +
        '</div>';

    document.body.appendChild(panel);
    bindEvents();
}

function addSettingsUI() {
    const settingsHtml = `
    <div id="crd-settings-block" class="extension_block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📘 Chat Article Reader DE</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">
                <button id="crd-launch-btn" class="crd-open-btn">📘 打开德语阅读器</button>
                <div class="crd-desc">
                    扫描聊天记录中的德语学习内容。<br>
                    支持三行格式：德文 + 中文 + 逐词标注。
                </div>
            </div>
        </div>
    </div>`;

    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);
    }

    setTimeout(() => {
        const btn = document.getElementById('crd-launch-btn');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });
        }
    }, 100);
}

function addWandButton() {
    const wandBtnHtml = `<div id="crd-wand-btn" class="list-group-item flex-container flexGap5" title="Chat Reader DE">
        <span>📘</span> Deutsch
    </div>`;

    const addToMenu = () => {
        if (byId('crd-wand-btn')) return;

        const wandMenu = document.getElementById('extensionsMenu');
        if (wandMenu) {
            wandMenu.insertAdjacentHTML('beforeend', wandBtnHtml);
            const btn = byId('crd-wand-btn');
            if (btn) {
                btn.style.cursor = 'pointer';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openPanel();
                });
            }
            return;
        }

        const sendForm = document.getElementById('send_form');
        if (sendForm && !byId('crd-float-btn')) {
            const floatBtn = document.createElement('button');
            floatBtn.id = 'crd-float-btn';
            floatBtn.textContent = '📘';
            floatBtn.title = 'Chat Reader DE';
            floatBtn.style.cssText = 'position:fixed;bottom:140px;right:10px;width:48px;height:48px;border-radius:50%;border:2px solid #1a5276;background:#1a5276;color:#fff;font-size:20px;cursor:pointer;z-index:99990;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;';
            floatBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPanel();
            });
            floatBtn.addEventListener('touchend', (e) => {
                e.preventDefault();
                openPanel();
            });
            document.body.appendChild(floatBtn);
        }
    };

    addToMenu();
    setTimeout(addToMenu, 2000);
    setTimeout(addToMenu, 5000);
    setTimeout(addToMenu, 10000);
}

function openPanel() {
    createPanel();
    const panel = byId('crd-panel');
    if (!panel) return;
    if (panel.classList.contains('open')) return;

    panel.classList.add('open');

    if (isMobile()) {
        mobileScreen = 'list';
        const sidebar = byId('crdSidebar');
        const main = byId('crdMain');
        if (sidebar) sidebar.classList.remove('hide');
        if (main) main.classList.add('hide');
        const back = byId('crdBack');
        if (back) back.classList.remove('show');
        byId('crdTitle').textContent = '📘 Deutsch Reader';
    } else {
        byId('crdSidebar').classList.remove('hide');
        byId('crdMain').classList.remove('hide');
    }

    refreshChars();
    if (state.lastChar && !selectedChar) selectChar(state.lastChar);
}

function closePanel() {
    const panel = byId('crd-panel');
    if (panel) panel.classList.remove('open');
}

function refreshChars() {
    charList = getCharList();
    renderCharTabs();
}

function renderCharTabs() {
    const el = byId('crdChars');
    if (!el) return;
    if (!charList.length) {
        el.innerHTML = '<span style="color:#aaa;font-size:11px;padding:6px">无角色卡</span>';
        return;
    }
    let html = '';
    for (const c of charList) {
        html += '<button class="crd-chartab' + (c.name === selectedChar ? ' on' : '') + '" data-name="' + escAttr(c.name) + '" data-avatar="' + escAttr(c.avatar) + '">' + escHtml(c.name) + '</button>';
    }
    el.innerHTML = html;
}

async function selectChar(name) {
    const ch = charList.find(c => c.name === name);
    if (!ch) return;

    selectedChar = name;
    state.lastChar = name;
    saveState();
    renderCharTabs();

    byId('crdArts').innerHTML = '<div class="crd-empty">⏳ 扫描中...</div>';

    const data = await loadCharData(name, ch.avatar);
    if (selectedChar !== name) return;

    renderArtList(data.articles);

    if (!data.articles.length) {
        byId('crdArts').innerHTML = '<div class="crd-empty">此角色无三行格式内容</div>';
    }

    const saved = state.positions[name];
    if (saved && saved.a >= 0 && saved.a < data.articles.length) {
        openArt(saved.a, saved.s || 0);
    }
}

function renderArtList(articles) {
    const el = byId('crdArts');
    if (!el) return;
    if (!articles.length) {
        el.innerHTML = '<div class="crd-empty">此角色无三行格式内容</div>';
        return;
    }

    const groups = {};
    const order = [];
    for (let i = 0; i < articles.length; i++) {
        const g = articles[i].chatFile || 'current';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push({ art: articles[i], idx: i });
    }

    const lv = state.lastViewed[selectedChar];
    let html = '';

    for (const gn of order) {
        const items = groups[gn];
        if (order.length > 1) {
            html += '<div class="crd-chatlabel">' + (gn === 'current' ? '📍 当前聊天' : '📄 ' + escHtml(gn.substring(0, 20))) + '</div>';
        }
        for (const item of items) {
            const isCur = item.idx === selectedArt;
            const isLV = item.idx === lv && !isCur;
            html += '<div class="crd-artcard' + (isCur ? ' playing' : '') + (isLV ? ' lastview' : '') + '" data-idx="' + item.idx + '">' +
                '<div class="crd-artnum">' + item.art.floor + '</div>' +
                '<div class="crd-artinfo"><div class="crd-artname">' + escHtml(item.art.title) + '</div><div class="crd-artmeta">' + item.art.sentences.length + '句</div></div>' +
                '<span class="crd-artbadge">' + item.art.sentences.length + '</span></div>';
        }
    }

    html += '<div class="crd-playallwrap"><button class="crd-playallbtn" id="crdPlayAll">▶ 连续播放全部 (' + articles.length + '篇)</button></div>';
    el.innerHTML = html;
}

function openArt(idx, startSent) {
    const data = charDataCache[selectedChar];
    if (!data || !data.articles[idx]) return;

    selectedArt = idx;
    sentenceIdx = startSent || 0;
    pageIdx = Math.floor(sentenceIdx / PAGE_SIZE);
    state.lastViewed[selectedChar] = idx;
    savePos();

    switchView('reader');
    schedRender();

    if (isMobile()) {
        mobileScreen = 'reader';
        byId('crdSidebar').classList.add('hide');
        byId('crdMain').classList.remove('hide');
        byId('crdBack').classList.add('show');
        byId('crdTitle').textContent = data.articles[idx].title;
    }

    renderArtList(data.articles);
}

function switchView(v) {
    const wel = byId('crdVWel');
    const read = byId('crdVRead');
    const set = byId('crdVSet');
    if (wel) wel.classList.toggle('on', v === 'welcome');
    if (read) read.classList.toggle('on', v === 'reader');
    if (set) set.classList.toggle('on', v === 'settings');
}

function goBack() {
    stopPlay();
    if (isMobile()) {
        mobileScreen = 'list';
        byId('crdSidebar').classList.remove('hide');
        byId('crdMain').classList.add('hide');
        byId('crdBack').classList.remove('show');
        byId('crdTitle').textContent = '📘 Deutsch Reader';
    }
}

function schedRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; doRender(); });
}

function doRender() {
    const art = getArt();
    if (!art) return;

    const ss = art.sentences;
    const tp = Math.ceil(ss.length / PAGE_SIZE);
    const ap = Math.floor(sentenceIdx / PAGE_SIZE);
    if (isPlaying && pageIdx !== ap) pageIdx = ap;
    if (pageIdx >= tp) pageIdx = tp - 1;
    if (pageIdx < 0) pageIdx = 0;
    const ps = pageIdx * PAGE_SIZE;
    const pe = Math.min(ps + PAGE_SIZE, ss.length);

    const pf = byId('crdProgFill');
    if (pf) pf.style.width = Math.round((sentenceIdx + 1) / ss.length * 100) + '%';
    const pi = byId('crdProgIdx');
    if (pi) pi.textContent = (sentenceIdx + 1) + '/' + ss.length;
    const pt = byId('crdProgTitle');
    if (pt) pt.textContent = art.title;

    const pgr = byId('crdPager');
    if (pgr) {
        if (tp > 1) {
            let h = '<button class="crd-pgbtn" data-p="0"' + (pageIdx === 0 ? ' disabled' : '') + '>⏮</button>';
            h += '<button class="crd-pgbtn" data-p="' + (pageIdx - 1) + '"' + (pageIdx === 0 ? ' disabled' : '') + '>◀</button>';
            let sp = Math.max(0, pageIdx - 2);
            let ep = Math.min(tp, sp + 5);
            if (ep - sp < 5) sp = Math.max(0, ep - 5);
            for (let p = sp; p < ep; p++) {
                h += '<button class="crd-pgbtn' + (p === pageIdx ? ' on' : '') + '" data-p="' + p + '">' + (p + 1) + '</button>';
            }
            h += '<button class="crd-pgbtn" data-p="' + (pageIdx + 1) + '"' + (pageIdx >= tp - 1 ? ' disabled' : '') + '>▶</button>';
            h += '<button class="crd-pgbtn" data-p="' + (tp - 1) + '"' + (pageIdx >= tp - 1 ? ' disabled' : '') + '>⏭</button>';
            h += '<span class="crd-pgmeta">' + (ps + 1) + '-' + pe + '/' + ss.length + '</span>';
            pgr.innerHTML = h;
            pgr.classList.add('on');
        } else {
            pgr.innerHTML = '';
            pgr.classList.remove('on');
        }
    }

    const rd = byId('crdReader');
    if (rd) {
        const st = state.settings;
        let html = '';
        for (let i = ps; i < pe; i++) {
            const s = ss[i];
            const act = i === sentenceIdx;
            const dn = i < sentenceIdx;
            const de = (s.de || '').replace(/\|/g, '');
            const cn = (s.cn || '').replace(/\|/g, '');
            const ww = (s.ww || '').replace(/\|/g, '');

            html += '<div class="crd-sent' + (act ? ' active' : '') + (dn ? ' done' : '') + '" data-si="' + i + '">';
            html += '<span class="crd-sentnum">#' + (i + 1) + '</span>';
            html += '<div class="crd-de' + (st.showDE ? '' : ' crd-hidden') + '">' + renderDE(de) + '</div>';
            html += '<div class="crd-cn' + (st.showCN ? '' : ' crd-hidden') + '">' + escHtml(cn) + '</div>';
            if (ww) html += '<div class="crd-ww' + (st.showWW ? '' : ' crd-hidden') + '">' + renderDE(ww) + '</div>';
            html += '</div>';
        }
        rd.innerHTML = html;
        rd.className = 'crd-reader dfs-' + (state.fontSize || 'm');
        setTimeout(() => {
            const actEl = rd.querySelector('.active');
            if (actEl) actEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
    }

    const pb = byId('crdPlay');
    if (pb) { pb.textContent = isPlaying ? '⏸' : '▶️'; pb.classList.toggle('on', isPlaying); }

    const lb = byId('crdLoop');
    if (lb) lb.classList.toggle('loopon', state.playMode === 'loop');

    const sb = byId('crdSpeed');
    if (sb) sb.textContent = state.settings.deRate.toFixed(1) + 'x';

    const plBar = byId('crdPL');
    if (plBar) {
        if (playlistOn) {
            plBar.classList.add('on');
            const pln = byId('crdPLName');
            if (pln) pln.textContent = art.title + ' (' + (playlistIdx + 1) + '/' + playlistArts.length + ')';
        } else {
            plBar.classList.remove('on');
        }
    }

    renderTB();
    renderFB();
    renderMB();
}

function renderTB() {
    const el = byId('crdToolbar');
    if (!el) return;
    const s = state.settings;
    el.innerHTML =
        '<button class="crd-tbtn' + (s.audioMode === 'cndtmix' ? ' on' : '') + '" data-am="cndtmix">🔊中德</button>' +
        '<button class="crd-tbtn' + (s.audioMode === 'dtonly' ? ' on' : '') + '" data-am="dtonly">🔊纯德</button>' +
        '<button class="crd-tbtn' + (s.audioMode === 'wwonly' ? ' on' : '') + '" data-am="wwonly">🔊词汇</button>' +
        '<span class="crd-tsep"></span>' +
        '<button class="crd-tbtn' + (s.showDE ? ' on' : '') + '" data-sh="de">德文</button>' +
        '<button class="crd-tbtn' + (s.showCN ? ' on' : '') + '" data-sh="cn">中文</button>' +
        '<button class="crd-tbtn' + (s.showWW ? ' on' : '') + '" data-sh="ww">词汇</button>';
}

function renderFB() {
    const el = byId('crdFontBar');
    if (!el) return;
    const sizes = [['s', '小'], ['m', '中'], ['l', '大'], ['xl', '特大']];
    let h = '<label>字号:</label>';
    for (const sz of sizes) {
        h += '<button class="crd-optbtn' + (state.fontSize === sz[0] ? ' on' : '') + '" data-fs="' + sz[0] + '">' + sz[1] + '</button>';
    }
    el.innerHTML = h;
}

function renderMB() {
    const el = byId('crdModeBar');
    if (!el) return;
    const modes = [['seq', '顺序'], ['loop', '单篇循环'], ['shuffle', '随机']];
    let h = '<label>播放:</label>';
    for (const m of modes) {
        h += '<button class="crd-optbtn' + (state.playMode === m[0] ? ' on' : '') + '" data-pm="' + m[0] + '">' + m[1] + '</button>';
    }
    el.innerHTML = h;
}

function togglePlay() {
    if (isPlaying) { stopPlay(); schedRender(); return; }
    if (!getArt()) { showToast('请先选择文章'); return; }
    isPlaying = true;
    startKeepAlive();
    updateMS(true);
    playStep();
}

async function playStep() {
    if (!isPlaying) return;
    const art = getArt();
    if (!art || sentenceIdx >= art.sentences.length) { handleEnd(); return; }

    const np = Math.floor(sentenceIdx / PAGE_SIZE);
    if (np !== pageIdx) pageIdx = np;
    schedRender();
    savePos();

    const s = art.sentences[sentenceIdx];
    const de = (s.de || '').replace(/\|/g, '');
    const cn = (s.cn || '').replace(/\|/g, '');
    const mode = state.settings.audioMode;

    speechId++;
    const myId = speechId;
    cancelSpeak();
    await new Promise(r => setTimeout(r, 40));
    if (speechId !== myId || !isPlaying) return;

    if (mode === 'wwonly' && s.ww) {
        const pairs = (s.ww || '').match(/([a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df][a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df'\u2019\-]*)\s*\(([^)]+)\)/g) || [];
        for (const pair of pairs) {
            if (speechId !== myId || !isPlaying) return;
            const mm = pair.match(/([a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df][a-zA-Z\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df'\u2019\-]*)\s*\(([^)]+)\)/);
            if (mm) {
                await speak(mm[1], 'de-DE', state.settings.deRate);
                if (speechId !== myId || !isPlaying) return;
                await speak(mm[2], 'zh-CN', state.settings.cnRate);
                if (speechId !== myId || !isPlaying) return;
            }
        }
    } else {
        await speak(de, 'de-DE', state.settings.deRate);
        if (speechId !== myId || !isPlaying) return;
        if (mode === 'cndtmix' && cn) {
            await speak(cn, 'zh-CN', state.settings.cnRate);
            if (speechId !== myId || !isPlaying) return;
        }
    }

    playTimer = setTimeout(() => {
        if (!isPlaying) return;
        sentenceIdx++;
        if (sentenceIdx >= art.sentences.length) handleEnd();
        else playStep();
    }, 400);
}

function handleEnd() {
    const data = charDataCache[selectedChar];
    if (!data) { stopPlay(); schedRender(); return; }

    if (state.playMode === 'loop') { sentenceIdx = 0; playStep(); return; }

    if (playlistOn) {
        playlistIdx++;
        if (playlistIdx >= playlistArts.length) {
            showToast('🎉 列表播放完成');
            stopPlay(); playlistOn = false; schedRender(); return;
        }
        selectedArt = data.articles.indexOf(playlistArts[playlistIdx]);
        sentenceIdx = 0; savePos(); playStep(); return;
    }

    if (state.playMode === 'shuffle' && data.articles.length > 1) {
        let nx = selectedArt;
        while (nx === selectedArt) nx = Math.floor(Math.random() * data.articles.length);
        selectedArt = nx; sentenceIdx = 0; savePos(); renderArtList(data.articles); playStep(); return;
    }

    if (selectedArt + 1 < data.articles.length) {
        selectedArt++; sentenceIdx = 0; savePos(); renderArtList(data.articles); playStep(); return;
    }

    sentenceIdx = 0; showToast('🎉 全部完成'); stopPlay(); schedRender();
}

function navSent(dir) {
    const art = getArt();
    if (!art) return;
    stopPlay();
    sentenceIdx += dir;
    if (sentenceIdx < 0) sentenceIdx = art.sentences.length - 1;
    if (sentenceIdx >= art.sentences.length) sentenceIdx = 0;
    savePos(); schedRender();
    const s = art.sentences[sentenceIdx];
    if (s) {
        cancelSpeak();
        speak((s.de || '').replace(/\|/g, ''), 'de-DE', state.settings.deRate).then(() => {
            if (state.settings.audioMode === 'cndtmix' && s.cn) speak((s.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
        });
    }
}

function startPlayAll() {
    const data = charDataCache[selectedChar];
    if (!data || !data.articles.length) { showToast('无文章'); return; }

    if (state.playMode === 'shuffle') {
        playlistArts = data.articles.slice();
        for (let i = playlistArts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playlistArts[i], playlistArts[j]] = [playlistArts[j], playlistArts[i]];
        }
    } else {
        playlistArts = data.articles.slice();
    }

    playlistIdx = 0; playlistOn = true;
    selectedArt = data.articles.indexOf(playlistArts[0]);
    sentenceIdx = 0;
    switchView('reader');

    if (isMobile()) {
        mobileScreen = 'reader';
        byId('crdSidebar').classList.add('hide');
        byId('crdMain').classList.remove('hide');
        byId('crdBack').classList.add('show');
    }

    isPlaying = true; startKeepAlive(); updateMS(true); playStep();
}

function renderSetView() {
    const el = byId('crdSetBody');
    if (!el) return;
    const s = state.settings;
    el.innerHTML =
        '<div style="font-size:16px;font-weight:700;color:#1a5276;margin-bottom:12px">⚙ 设置</div>' +
        '<div class="crd-setrow"><label>德语语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crdDR" min="0.5" max="2.5" step="0.1" value="' + s.deRate + '"><span class="val" id="crdDRV">' + s.deRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="crd-setrow"><label>中文语速</label><div style="display:flex;align-items:center;gap:6px"><input type="range" id="crdCR" min="0.5" max="2.5" step="0.1" value="' + s.cnRate + '"><span class="val" id="crdCRV">' + s.cnRate.toFixed(1) + 'x</span></div></div>' +
        '<div class="crd-setinfo"><div style="font-weight:700;color:#1a5276;margin-bottom:4px">📘 说明</div>' +
        '<div>• 扫描所有角色卡聊天记录</div>' +
        '<div>• 识别三行格式: 德文+中文+逐词</div>' +
        '<div>• 点击单词播放德语发音显示翻译</div>' +
        '<div>• 顺序/循环/随机播放</div>' +
        '<div>• 后台播放+锁屏控制</div>' +
        '<div>• 自动记录位置</div>' +
        '<div>• 小/中/大/特大字号</div>' +
        '<div style="margin-top:6px;color:#bbb">v6.0.0 DE</div></div>';
}

function bindEvents() {
    byId('crdClose').addEventListener('click', e => { e.preventDefault(); closePanel(); });

    byId('crdBack').addEventListener('click', e => {
        e.preventDefault();
        if (byId('crdVSet').classList.contains('on')) {
            if (selectedArt >= 0) {
                switchView('reader');
                if (isMobile()) byId('crdTitle').textContent = getArt() ? getArt().title : '📘';
            } else goBack();
        } else goBack();
    });

    byId('crdRefresh').addEventListener('click', e => {
        e.preventDefault();
        charDataCache = {};
        refreshChars();
        if (selectedChar) selectChar(selectedChar);
        showToast('刷新完成');
    });

    byId('crdSettings').addEventListener('click', e => {
        e.preventDefault();
        if (byId('crdVSet').classList.contains('on')) {
            if (selectedArt >= 0) {
                switchView('reader');
                if (isMobile()) byId('crdTitle').textContent = getArt() ? getArt().title : '📘';
            } else { switchView('welcome'); if (isMobile()) goBack(); }
        } else {
            renderSetView(); switchView('settings');
            if (isMobile()) {
                byId('crdSidebar').classList.add('hide');
                byId('crdMain').classList.remove('hide');
                byId('crdBack').classList.add('show');
                byId('crdTitle').textContent = '⚙ 设置';
            }
        }
    });

    byId('crdChars').addEventListener('click', e => {
        const tab = e.target.closest('.crd-chartab');
        if (tab) { e.preventDefault(); selectChar(tab.dataset.name); }
    });

    byId('crdArts').addEventListener('click', e => {
        const card = e.target.closest('.crd-artcard');
        if (card) { e.preventDefault(); openArt(parseInt(card.dataset.idx)); return; }
        const pa = e.target.closest('#crdPlayAll');
        if (pa) { e.preventDefault(); startPlayAll(); }
    });

    byId('crdToolbar').addEventListener('click', e => {
        const btn = e.target.closest('.crd-tbtn');
        if (!btn) return;
        e.preventDefault();
        if (btn.dataset.am) { state.settings.audioMode = btn.dataset.am; saveState(); schedRender(); }
        if (btn.dataset.sh === 'de') { state.settings.showDE = !state.settings.showDE; saveState(); schedRender(); }
        if (btn.dataset.sh === 'cn') { state.settings.showCN = !state.settings.showCN; saveState(); schedRender(); }
        if (btn.dataset.sh === 'ww') { state.settings.showWW = !state.settings.showWW; saveState(); schedRender(); }
    });

    byId('crdFontBar').addEventListener('click', e => {
        const btn = e.target.closest('.crd-optbtn');
        if (btn && btn.dataset.fs) {
            e.preventDefault(); state.fontSize = btn.dataset.fs; saveState(); renderFB();
            const rd = byId('crdReader'); if (rd) rd.className = 'crd-reader dfs-' + state.fontSize;
        }
    });

    byId('crdModeBar').addEventListener('click', e => {
        const btn = e.target.closest('.crd-optbtn');
        if (btn && btn.dataset.pm) { e.preventDefault(); state.playMode = btn.dataset.pm; saveState(); renderMB(); schedRender(); }
    });

    byId('crdPager').addEventListener('click', e => {
        const btn = e.target.closest('.crd-pgbtn');
        if (btn && !btn.disabled) { e.preventDefault(); pageIdx = parseInt(btn.dataset.p); schedRender(); byId('crdReader').scrollTo(0, 0); }
    });

    byId('crdPLClose').addEventListener('click', e => { e.preventDefault(); playlistOn = false; stopPlay(); schedRender(); });

    byId('crdPlay').addEventListener('click', e => { e.preventDefault(); togglePlay(); });
    byId('crdPrev').addEventListener('click', e => { e.preventDefault(); navSent(-1); });
    byId('crdNext').addEventListener('click', e => { e.preventDefault(); navSent(1); });

    byId('crdLoop').addEventListener('click', e => {
        e.preventDefault(); state.playMode = state.playMode === 'loop' ? 'seq' : 'loop'; saveState(); schedRender();
    });

    byId('crdSpeed').addEventListener('click', e => {
        e.preventDefault();
        const speeds = [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 2.0];
        let ci = speeds.findIndex(s => Math.abs(s - state.settings.deRate) < 0.05);
        state.settings.deRate = speeds[(ci + 1) % speeds.length];
        saveState(); schedRender();
    });

    byId('crdGoList').addEventListener('click', e => { e.preventDefault(); goBack(); });

    byId('crdReader').addEventListener('click', e => {
        const w = e.target.closest('.crd-word');
        if (w) { e.preventDefault(); e.stopPropagation(); onWordClick(w); return; }
        const s = e.target.closest('.crd-sent');
        if (s) {
            e.preventDefault();
            const idx = parseInt(s.dataset.si);
            if (!isNaN(idx)) {
                sentenceIdx = idx; savePos(); if (!isPlaying) schedRender();
                const art = getArt();
                if (art && art.sentences[idx]) {
                    const sent = art.sentences[idx];
                    cancelSpeak();
                    speak((sent.de || '').replace(/\|/g, ''), 'de-DE', state.settings.deRate).then(() => {
                        if (state.settings.audioMode === 'cndtmix' && sent.cn) speak((sent.cn || '').replace(/\|/g, ''), 'zh-CN', state.settings.cnRate);
                    });
                }
            }
        }
    });

    byId('crdSetBody').addEventListener('input', e => {
        if (e.target.id === 'crdDR') {
            state.settings.deRate = parseFloat(e.target.value);
            const v = byId('crdDRV'); if (v) v.textContent = state.settings.deRate.toFixed(1) + 'x';
            saveState();
        }
        if (e.target.id === 'crdCR') {
            state.settings.cnRate = parseFloat(e.target.value);
            const v = byId('crdCRV'); if (v) v.textContent = state.settings.cnRate.toFixed(1) + 'x';
            saveState();
        }
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.crd-tooltip') && !e.target.closest('.crd-word')) hideTip();
    });

    document.addEventListener('keydown', e => {
        const panel = byId('crd-panel');
        if (!panel || !panel.classList.contains('open')) return;
        if (!byId('crdVRead') || !byId('crdVRead').classList.contains('on')) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); navSent(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); navSent(1); }
        if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    });
}

jQuery(async () => {
    loadState();
    addSettingsUI();
    addWandButton();
    initVoices();
    console.log('[ChatReaderDE] v6.0 loaded');
});
