/**
 * dsh-maoying — 毛颖创作台 DSH Web client bundle（手写，零构建）
 *
 * 加载机制：
 *  - 宿主把声明了 dsh.client + exports["./client"] 的插件编进
 *    window.__DSH_BOOT__，并以 /plugins/<挂载包名>/client.js 服务本文件；
 *    __ModuleLoader__.load 的 id 必须等于图行 id，否则首次加载的后置校验
 *    （factories.has(图行 id)）失败 → import 报错 → 二次执行撞 duplicate
 *    factory 守卫。合并 bundle 下 currentScript.src 是唯一可靠线索：宿主
 *    保证本行 URL「<挂载名>/client.js」必在 script src 里，故直接用
 *    /plugins/<名>/client.js 正则解析，未命中回退主包名 dsh-maoying。
 *  - factory 内 require() 只解析平台 seed 模块；本 bundle 依赖 react 与
 *    @deepseek-ai/dsh-client-ui-primitives（图标只用 …OutlineRegular 系 +
 *    size prop，缺名不渲染不抛），react-dom/client 取不到时仅失去 overlay。
 *  - 挂载点：左侧栏底部动作位入口（sidebar.footer.action 键控槽）+ 会话
 *    中栏全页 overlay（data-dsh-maoying-view / html[data-dsh-maoying-active]）；
 *    与 mnemon / taskboard / ssh 等全页面板互斥（dsh-panel-activate
 *    事件 + active 属性双通道），点侧栏会话行等上下文自动关闭。
 *  - CSS 正文在 lib/base.css，由 Node 侧 GET /api/maoying/client.css 现读
 *    下发；此处只在首次物化幂等注入 <link data-plugin-css="maoying-creator/base">
 *    （bundle 不含 CSS 正文，改样式无需重编）。数据走同源 /api/maoying/*。
 *  - 写操作（状态流转 / 阶段推进 / 索引重建）POST 成功后重拉 state 刷新，
 *    不做乐观更新；错误统一 toast，读取失败另在卡内留错误态。
 */
var __dshSrc = (document.currentScript && document.currentScript.src) || "";
window.__ModuleLoader__.load({
  id: (__dshSrc.match(/\/plugins\/([^/]+)\/client\.js/) || [])[1] || "dsh-maoying",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState, useEffect = React.useEffect, useCallback = React.useCallback, useRef = React.useRef, useMemo = React.useMemo;
    // 复制一份导出面再补属性：不往共享模块对象上写东西（避免污染宿主里
    // 其他 ui-primitives 消费者）；后续片段看到的就是这份副本。
    var P = Object.assign({}, require("@deepseek-ai/dsh-client-ui-primitives"));
    var ReactDOMClient = null;
    try { ReactDOMClient = require("react-dom/client"); } catch (err) { ReactDOMClient = null; }

    // 图标兜底：只用 …OutlineRegular 系（0.1.7+ 命名）+ size prop；导出名
    // 缺失（更老宿主）返回 null 不渲染，绝不因图标炸面板。
    function ic(name, size) {
      var C = P[name];
      if (typeof C !== "function") return null;
      return h(C, { size: size || 16, "aria-hidden": "true" });
    }

    // ── 常量与文案（全中文，禁 emoji 图标）────────────────────────────────
    var API_BASE = "/api/maoying/";
    var CSS_URL = "/api/maoying/client.css";
    var CSS_KEY = "maoying-creator/base";
    var WS_STORAGE_KEY = "maoying.workspace";
    var API_TIMEOUT_MS = 60000;
    // 一键升级单独放宽：服务端 pnpm add 超时上限 180s，统一 60s 会先掐断，
    // 故 self-update 请求走 200s（留 20s 余量），其余请求仍用 API_TIMEOUT_MS。
    var SELF_UPDATE_TIMEOUT_MS = 200000;

    var STATUS_FLOW = ["pending", "writing", "review", "accepted"];
    var FS_ORDER = ["planted", "progressing", "resolved", "abandoned"];
    var FS_FLOW = { planted: "progressing", progressing: "resolved" };
    var PHASES = ["idea", "setting", "outline", "writing", "review", "consistency", "export"];
    // clue.* 词典键是小驼峰，数据里的 kind 按契约（templates/novel/README.md、
    // docs/spec.md）是 clue|red-herring|deduction|question——此前键表误按
    // snake_case + inference 写，红鲱鱼/推理两组永远查不中、只能裸显英文原值。
    // 尾两个旧键是历史手写数据的容错别名，契约值优先。
    var CLUE_KIND_KEYS = { clue: "clue", "red-herring": "redHerring", deduction: "inference", question: "question", red_herring: "redHerring", inference: "inference" };
    var TABS = [
      ["overview", "tabs.overview"], ["chapters", "tabs.chapters"], ["characters", "tabs.characters"],
      ["foreshadows", "tabs.foreshadows"], ["relations", "tabs.relations"], ["timeline", "tabs.timeline"],
      ["world", "tabs.world"], ["index", "tabs.index"],
    ];

    // 角色徽章四色（role 是自由文本）：按关键词归 tone，命中即返。
    function roleTone(role) {
      var r = String(role || "");
      if (/主角|protagonist|男主|女主/i.test(r)) return "a";
      if (/反派|对立|antagonist|敌/i.test(r)) return "b";
      if (/配角|支持|盟友|friend|ally/i.test(r)) return "c";
      return "d";
    }
    // 契约四态 role（protagonist|antagonist|supporting|minor）按界面语言出标签，
    // role 是自由文本，契约外取值原样展示不翻译。
    var ROLE_CONTRACT = { protagonist: 1, antagonist: 1, supporting: 1, minor: 1 };
    function roleBadge(role) {
      var text = String(role || "").trim();
      if (!text) return null;
      var key = text.toLowerCase();
      if (!ROLE_CONTRACT[key]) key = null;
      return h("span", { className: "myt-badge myt-roleBadge", "data-tone": roleTone(text) }, key ? tt("role." + key) : text);
    }
    function statusBadge(status) {
      var s = STATUS_FLOW.indexOf(status) !== -1 ? status : "pending";
      return h("span", { className: "myt-badge", "data-status": s }, tt("status." + s) + (status && s !== status ? tf("status.rawSuffix", { raw: status }) : ""));
    }
    function phasePill(phase) {
      var p = PHASES.indexOf(phase) !== -1 ? phase : null;
      if (!p) return h("span", { className: "myt-phase", "data-phase": "idea", title: phase || "" }, phase ? String(phase) : tt("phase.unset"));
      return h("span", { className: "myt-phase", "data-phase": p }, tt("phase." + p));
    }
    function priDot(pri) {
      var p = pri === "high" || pri === "low" ? pri : "normal";
      return h("span", { className: "myt-priDot", "data-pri": p, title: tf("common.priorityTitle", { pri: tt("pri." + p) }), "aria-label": tf("common.priorityAria", { pri: tt("pri." + p) }) });
    }

    // ── 格式化小工具 ─────────────────────────────────────────────────────
    function fmtNum(n) {
      var v = typeof n === "number" && isFinite(n) ? n : null;
      if (v === null) return "—";
      try { return v.toLocaleString("zh-CN"); } catch (err) { return String(v); }
    }
    function orDash(v) {
      var s = v === null || v === undefined ? "" : String(v);
      return s.trim() === "" ? "—" : s;
    }
    function truncate(s, n) {
      var t = String(s === null || s === undefined ? "" : s);
      return t.length > n ? t.slice(0, n - 1) + "…" : t;
    }
    // 章节「卷-章」定位：volume 缺省只显示第 N 章。
    function chWhere(ch) {
      if (!ch) return "";
      var num = typeof ch.num === "number" ? tf("common.chapterNum", { n: ch.num }) : "";
      return ch.volume ? String(ch.volume) + " · " + num : num;
    }
    // 孤儿章纲的「卷-章」定位（0.1.15）：从章纲文件名 stem（v01-c003.md）
    // 反推，显示格式与 chWhere 对齐；不合规范的文件名返回空串（调用方退回
    // 文件名兜底显示）。
    function olWhere(ol) {
      var stem = ol && ol.chapter ? String(ol.chapter).replace(/\.md$/i, "") : "";
      var m = /^v(\d+)-c(\d+)$/i.exec(stem);
      if (!m) return "";
      return "v" + m[1] + " · " + tf("common.chapterNum", { n: Number(m[2]) });
    }
    function chFullTitle(ch) {
      if (!ch) return "";
      var where = chWhere(ch);
      var title = ch.title ? String(ch.title) : (ch.file || "");
      return where ? where + " · " + title : title;
    }
    // 章节文件绝对路径（抽屉「复制路径」按钮用）：novelDir 由服务端 resolve 过，
    // 这里只补 chapters/ 段；novelDir 尾部分隔符兜掉，分隔符统一用 /（即 Windows
    // 下 novelDir 自带的 \ 不受影响，拼出的路径可直接贴进文件管理器）。
    function chapterAbsPath(novelDir, file) {
      return String(novelDir || "").replace(/[\\/]+$/, "") + "/chapters/" + file;
    }
    // localStorage 安全读写（隐私模式 / 禁存环境不炸）。
    function lsGet(key) {
      try { return window.localStorage.getItem(key); } catch (err) { return null; }
    }
    function lsSet(key, value) {
      try { window.localStorage.setItem(key, value); } catch (err) { /* 静默 */ }
    }
    // 复制：clipboard API 优先，老环境回落隐藏 textarea + execCommand。
    function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
      }
      return Promise.resolve(legacyCopy(text));
    }
    function legacyCopy(text) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (err) { return false; }
    }

    // ── 服务端 API 助手（同源 /api/maoying/*，非 2xx 抛错）─────────────────
    // 错误统一 toast（读路由调用方另留卡内错误态）；总超时防按钮永久转圈。
    function maoyingApi(path, body, timeoutMs) {
      // timeoutMs 缺省用统一 60s；一键升级单独放宽到 200s（见常量处注释）。
      var limit = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : API_TIMEOUT_MS;
      var opts = body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = null;
      if (ctrl) {
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { ctrl.abort(); }, limit);
      }
      return fetch(API_BASE + path, opts).then(function (r) {
        // 先取全文再 JSON.parse：代理错误页 / 空体不再抛 SyntaxError。
        return r.text().then(function (raw) {
          var d = null;
          try { d = raw ? JSON.parse(raw) : null; } catch (err) { d = null; }
          if (!r.ok) {
            // 错误对象带状态码：调用方按码分流（如设置保存只在 409 外部改动
            // 冲突时重置表单，其余失败保留用户正在编辑的内容）。
            var e = new Error((d && d.error) || ("HTTP " + r.status));
            e.status = r.status;
            throw e;
          }
          if (!d) throw new Error(tf("api.notJson", { code: r.status }));
          return d;
        });
      }).catch(function (err) {
        if (ctrl && err && err.name === "AbortError") throw new Error(tf("api.timeout", { s: Math.round(limit / 1000) }));
        throw err;
      }).finally(function () {
        if (timer !== null) clearTimeout(timer);
      });
    }
    function apiGet(path, params) {
      var qs = "";
      if (params) {
        var usp = new URLSearchParams();
        Object.keys(params).forEach(function (k) { if (params[k] !== undefined && params[k] !== null) usp.append(k, String(params[k])); });
        qs = usp.toString();
      }
      return maoyingApi(path + (qs ? (path.indexOf("?") === -1 ? "?" : "&") + qs : "")).catch(function (err) {
        toast.err(tf("toast.prefix", { msg: err.message }));
        throw err;
      });
    }
    function apiPost(path, body) {
      return maoyingApi(path, body || {}).then(function (d) {
        toast.ok(apiPostOkText(path, d));
        return d;
      }, function (err) {
        toast.err(tf("toast.prefix", { msg: err.message }));
        throw err;
      });
    }
    // 写操作成功提示按路由分流（server 返回 chapters 计数时带上）。
    function apiPostOkText(path, d) {
      if (path === "rebuild-index") return tf("toast.indexRebuilt", { n: fmtNum(d && d.chapters) });
      if (path === "chapter-status") return tt("toast.chapterStatus");
      if (path === "chapter-create") return tf("toast.chapterCreated", { title: (d && d.title) || "—" });
      if (path === "foreshadow-status") return tt("toast.foreshadowStatus");
      if (path === "phase") return tf("toast.phaseAdvanced", { phase: d && d.phase && PHASES.indexOf(d.phase) !== -1 ? tt("phase." + d.phase) : (d && d.phase) || "—" });
      return tt("toast.success");
    }

    // ── Toast 控制器（模块级单例；ok 4s / warn 6s 自动消失，err 手动关）────
    function createToastCtrl() {
      var seq = 0;
      var items = [];
      var listeners = [];
      function notify() { listeners.slice().forEach(function (fn) { fn(); }); }
      function dismiss(id) {
        items = items.filter(function (it) { return it.id !== id; });
        notify();
      }
      function push(kind, text) {
        var it = { id: ++seq, kind: kind, text: String(text || "") };
        items = items.concat([it]);
        if (items.length > 4) items = items.slice(items.length - 4);
        if (kind !== "err") {
          setTimeout(function () { dismiss(it.id); }, kind === "warn" ? 6000 : 4000);
        }
        notify();
        return it.id;
      }
      return {
        ok: function (t) { return push("ok", t); },
        warn: function (t) { return push("warn", t); },
        err: function (t) { return push("err", t); },
        dismiss: dismiss,
        subscribe: function (fn) {
          listeners.push(fn);
          return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
        },
        snapshot: function () { return items.slice(); },
      };
    }
    var toast = createToastCtrl();

    function ToastHost() {
      var _t = useState(function () { return toast.snapshot(); }), items = _t[0], setItems = _t[1];
      useEffect(function () {
        return toast.subscribe(function () { setItems(toast.snapshot()); });
      }, []);
      if (!items.length) return null;
      // portal 到 body：与弹层同坐标系。中栏 transform/overflow 会把 fixed 劫持
      // 成相对中栏定位，锚区变量（视口坐标）在此会被二次偏移；挂 body 后
      // fixed 恒等于视口，--myt-anchor-* 直接可用（base.css 按锚区居中）。
      return h(MaskPortal, { className: "myt-toastHost", "aria-live": "polite" },
        items.map(function (it) {
          return h("div", {
            key: it.id,
            className: "myt-toast myt-toast" + it.kind.charAt(0).toUpperCase() + it.kind.slice(1),
            role: it.kind === "err" ? "alert" : "status",
          },
            h("div", { className: "myt-toastText" }, it.text),
            h("button", {
              type: "button", className: "myt-toastClose", "aria-label": tt("common.closeTip"),
              onClick: function () { toast.dismiss(it.id); },
            }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")));
        }));
    }

    // ── 样式注入（幂等）：同名 data 属性的 link 已存在即跳过 ───────────────
    function mountCss() {
      if (document.querySelector('link[data-plugin-css="' + CSS_KEY + '"]')) return;
      var link = document.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("data-plugin", "dsh-maoying");
      link.setAttribute("data-plugin-css", CSS_KEY);
      link.setAttribute("href", CSS_URL);
      if (document.head) {
        document.head.appendChild(link);
      } else if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mountCss);
      } else {
        document.documentElement.appendChild(link);
      }
    }
    if (typeof document !== "undefined") mountCss();

    // ── 挂载：底部入口 + 会话中栏全页 overlay ──────────────────────────────
    // 框架无关小状态器：侧栏入口与 overlay 共享同一份 { open } 快照。
    function createPanelController() {
      var snapshot = { open: false };
      var listeners = [];
      function notify() { listeners.slice().forEach(function (fn) { fn(); }); }
      function setOpen(open, reassert) {
        if (snapshot.open === open && !reassert) return;
        snapshot = { open: open };
        notify();
      }
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var i = listeners.indexOf(listener);
            if (i !== -1) listeners.splice(i, 1);
          };
        },
        // open 带 reassert：属性观察兜底重复触发时也把广播重刷一遍。
        open: function () { setOpen(true, true); },
        close: function () { setOpen(false); },
        toggle: function () { setOpen(!snapshot.open); },
      };
    }

    function makeFooterEntry(controller) {
      return function FooterEntry(props) {
        var wide = !!(props && props.wide);
        var _st = useState(controller.getSnapshot().open), open = _st[0], setOpenState = _st[1];
        useEffect(function () {
          return controller.subscribe(function () { setOpenState(controller.getSnapshot().open); });
        }, []);
        return h("button", {
          type: "button",
          className: "myt-footerBtn" + (wide ? "" : " myt-footerRail"),
          "data-active": open ? "true" : undefined,
          "aria-label": "毛颖创作台",
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          title: "毛颖创作台",
          onClick: function () { controller.toggle(); },
        },
          ic("IconEditOutlineRegular", wide ? 16 : 18),
          wide ? h("span", { className: "myt-footerLabel" }, "毛颖创作台") : null);
      };
    }

    function mountFooterEntry(ctx, controller) {
      if (typeof document === "undefined") return function () {};
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") {
        return function () {}; // 槽口不可用（老宿主）：只失去底部入口，不炸
      }
      var Entry = makeFooterEntry(controller);
      var dispose = ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register({ name: "sidebar.footer.action", id: "maoying-creator", order: 12, label: "毛颖创作台" }, Entry);
      });
      return typeof dispose === "function" ? dispose : function () {};
    }

    // 全页 overlay：容器 append 到会话中栏，createRoot 渲染 PageShell；懒挂载
    // （首次打开才建容器），被宿主挤掉时由 MutationObserver 重挂。互斥双通道：
    //  1) 打开时清掉四家旧面板的 active 属性（其属性观察者自行关闭）+ 广播
    //     dsh-panel-activate（新式 detail:{source:"maoying"}）；
    //  2) 监听同款事件：旧式字符串 detail 或新式对象 detail.source 非
    //     "maoying" → 关自己；点侧栏会话行等上下文自动关闭。
    var CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface';
    var ACTIVE_ATTR = "data-dsh-maoying-active";
    var OTHER_ACTIVE_ATTRS = ["data-dsh-mnemon-active", "data-dsh-taskboard-active", "data-dsh-ssh-active", "data-dsh-paoding-active"];
    var ACTIVATE_EVENT = "dsh-panel-activate";
    var SIDEBAR_CONTEXT_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="newSession"]';

    function mountPanel(controller) {
      if (typeof document === "undefined" || typeof window === "undefined" || !ReactDOMClient) {
        return function () {};
      }
      var root;
      var container;
      var ensure = function () {
        if (!controller.getSnapshot().open) return; // 懒挂载：只在打开态维护容器
        if (container && container.isConnected) return;
        if (container) {
          if (root) root.unmount();
          root = undefined;
          container = undefined;
        }
        var column = document.querySelector(CONVERSATION_COLUMN_SELECTOR);
        if (!column) return;
        container = document.createElement("div");
        container.dataset.dshMaoyingView = ""; // → data-dsh-maoying-view
        container.className = "myt-view";
        column.appendChild(container);
        root = ReactDOMClient.createRoot(container);
        root.render(h(PageShell, { onClose: function () { controller.close(); } }));
      };
      // 会话中栏晚于插件挂载 / 容器被挤掉时重挂
      var waitObserver = new MutationObserver(ensure);
      waitObserver.observe(document.body, { childList: true, subtree: true });

      var applyActive = function () {
        var html = document.documentElement;
        if (!controller.getSnapshot().open) {
          html.removeAttribute(ACTIVE_ATTR);
          return;
        }
        OTHER_ACTIVE_ATTRS.forEach(function (attr) { html.removeAttribute(attr); });
        html.setAttribute(ACTIVE_ATTR, "");
        ensure();
        // bubbles：document 级监听（含旧面板挂在 document 的）都能收到
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { bubbles: true, detail: { source: "maoying" } }));
      };
      var onOtherPanelActivate = function (event) {
        if (!controller.getSnapshot().open) return;
        var detail = event && event.detail;
        var source = detail && typeof detail === "object" ? detail.source : detail;
        if (source !== "maoying") controller.close();
      };
      var onSidebarContextClick = function (event) {
        if (!controller.getSnapshot().open) return;
        var target = event.target;
        if (target && typeof target.closest === "function" && target.closest(SIDEBAR_CONTEXT_SELECTOR)) {
          controller.close();
        }
      };
      // 属性兜底：自己 active 丢了、或别的面板 active 了 → 关闭
      var activeObserver = new MutationObserver(function () {
        if (!controller.getSnapshot().open) return;
        var html = document.documentElement;
        if (!html.hasAttribute(ACTIVE_ATTR) || OTHER_ACTIVE_ATTRS.some(function (a) { return html.hasAttribute(a); })) {
          controller.close();
        }
      });
      activeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [ACTIVE_ATTR].concat(OTHER_ACTIVE_ATTRS) });

      document.addEventListener("click", onSidebarContextClick, true);
      document.addEventListener(ACTIVATE_EVENT, onOtherPanelActivate);
      var unsubscribe = controller.subscribe(applyActive);
      applyActive();
      return function () {
        document.removeEventListener("click", onSidebarContextClick, true);
        document.removeEventListener(ACTIVATE_EVENT, onOtherPanelActivate);
        activeObserver.disconnect();
        waitObserver.disconnect();
        unsubscribe();
        document.documentElement.removeAttribute(ACTIVE_ATTR);
        if (root) root.unmount();
        root = undefined;
        if (container) container.remove();
        container = undefined;
      };
    }

    // ── 引导卡（无 novel 工作区 / 未初始化）：maoying init 提示 + 复制 ──────
    function GuideCard(props) {
      var title = props.title || tt("guide.defaultTitle");
      var desc = props.desc || tt("guide.defaultDesc");
      var _b = useState(false), busy = _b[0], setBusy = _b[1];
      function doCopy() {
        setBusy(true);
        copyText("maoying init").then(function (ok) {
          if (ok) toast.ok(tt("guide.copied"));
          else toast.warn(tt("guide.copyFailed"));
        }).finally(function () { setBusy(false); });
      }
      return h("div", { className: "myt-card myt-guide" },
        h("h2", { className: "myt-guideTitle" }, title),
        h("p", { className: "myt-guideText" }, desc),
        h("div", { className: "myt-guideCode" },
          h("code", { className: "myt-guideCodeText" }, "maoying init"),
          h("button", { type: "button", className: "myt-btn myt-copyBtn", disabled: busy, onClick: doCopy }, busy ? tt("guide.copying") : tt("guide.copyCmd"))));
    }

    // ── 骨架 / 错误 / 空态小件 ──────────────────────────────────────────────
    function SkelPage() {
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-skelCard" }, h("div", { className: "myt-skel myt-skelRow", style: { width: "40%" } }), h("div", { className: "myt-skel myt-skelRow", style: { width: "72%" } }), h("div", { className: "myt-skel myt-skelRow", style: { width: "56%" } })),
        h("div", { className: "myt-grid" }, h("div", { className: "myt-skelCard" }), h("div", { className: "myt-skelCard" })));
    }
    function ErrorStrip(props) {
      return h("div", { className: "myt-strip myt-stripError" },
        h("span", { className: "myt-stripIcon" }, ic("IconWarningOutlineRegular", 14)),
        h("span", { className: "myt-stripText" }, props.text),
        props.onRetry ? h("button", { type: "button", className: "myt-btn", style: { marginLeft: "auto" }, onClick: props.onRetry }, tt("common.retry")) : null);
    }
    function Empty(props) { return h("div", { className: "myt-empty" }, props.text || tt("common.empty")); }

    // tab 内容错误边界：任何 tab / 阅读页渲染抛错都降级为卡内错误态（错误摘要
    // + 重试按钮），不再把整个面板炸成白屏。错误边界只有 class 组件能做
    // （getDerivedStateFromError / componentDidCatch），此处破例用 class。
    class TabErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
        this.retry = this.retry.bind(this);
      }
      static getDerivedStateFromError(err) {
        return { err: err }; // 渲染抛错 → 下一次 render 走降级分支
      }
      componentDidCatch(err) {
        // 只记控制台：卡内已有降级 UI，toast 通道留给请求错误，不重复打扰。
        if (typeof console !== "undefined" && console.warn) console.warn("maoying: 分区渲染出错:", err);
      }
      retry() {
        this.setState({ err: null });
        if (typeof this.props.onRetry === "function") this.props.onRetry(); // 顺手重拉快照，坏数据一并刷掉
      }
      render() {
        var err = this.state.err;
        if (!err) return this.props.children;
        var msg = String((err && err.message) || err || tt("common.unknownErr"));
        return h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("errBoundary.title"))),
          h("div", { className: "myt-muted", style: { overflowWrap: "anywhere" } }, tf("errBoundary.summary", { msg: truncate(msg, 300) })),
          h("div", { className: "myt-heroMeta" },
            h("button", { type: "button", className: "myt-btn", onClick: this.retry }, tt("common.retry"))));
      }
    }

    // ── 页面骨架：顶栏（工作区下拉 + 刷新 + 关闭）+ tab 条 + 内容区 ─────────
    // 数据流：workspaces 每次打开面板都重拉（懒挂载下关闭不卸载，见下方
    // activate 监听）；state 跟随选中工作区；写操作 POST 成功后
    // 整份重拉 state（不乐观更新）。选择记 localStorage('maoying.workspace')。
    function PageShell(props) {
      var onClose = props.onClose;
      var _ws = useState(null), workspaces = _ws[0], setWorkspaces = _ws[1]; // null = 拉取中
      var _we = useState(""), wsErr = _we[0], setWsErr = _we[1];
      var _sel = useState(function () { return lsGet(WS_STORAGE_KEY) || ""; }), selWs = _sel[0], setSelWs = _sel[1];
      var _sn = useState(null), snap = _sn[0], setSnap = _sn[1];
      var _ld = useState(true), loading = _ld[0], setLoading = _ld[1];
      var _se = useState(""), stateErr = _se[0], setStateErr = _se[1];
      var _tb = useState("overview"), tab = _tb[0], setTab = _tb[1];
      // 章节阅读页（整页视图，替代原右侧抽屉）：null = 列表态。
      var _rd = useState(null), readerFile = _rd[0], setReaderFile = _rd[1];
      // 系统设置：字号档位持久化 + 面板整体缩放（portal 节点读同一 CSS 变量）。
      var _sm = useState(false), showSettings = _sm[0], setShowSettings = _sm[1];
      var _fs = useState(function () {
        var stored = lsGet(FONT_SCALE_KEY) || "1";
        return FONT_SCALES.some(function (o) { return o[0] === stored; }) ? stored : "1"; // 旧档位（1.8/2）回落 100%
      }), fontScale = _fs[0], setFontScale = _fs[1];
      var _lg = useState(function () {
        var stored = lsGet(LANG_KEY) || "zh";
        return UI_LANGS.some(function (o) { return o[0] === stored; }) ? stored : "zh";
      }), lang = _lg[0], setLang = _lg[1];
      useEffect(function () {
        UI_LANG = lang;
        lsSet(LANG_KEY, lang);
      }, [lang]);
      useEffect(function () {
        if (typeof document !== "undefined" && document.documentElement) {
          document.documentElement.style.setProperty("--myt-zoom", fontScale);
        }
        lsSet(FONT_SCALE_KEY, fontScale);
      }, [fontScale]);

      // 弹层锚区：弹层 portal 到 body 后 position:fixed 以全窗为居中基准，
      // 宿主右侧边栏一开，中栏变窄左移，弹窗仍按全窗居中，右半被侧边栏盖住。
      // 这里持续测量面板容器（data-dsh-maoying-view）的视口矩形写进 CSS 变量，
      // 弹层/Toast 改按锚区居中（base.css）；测量不到时移除变量回落全窗，行
      // 为与旧版一致。宿主侧边栏开合会改中栏宽度，ResizeObserver + resize 双
      // 通道跟随，rAF 合帧防抖。
      // 两组变量：--myt-anchor-* 视觉 px（Toast 未 zoom，直接用）；--myt-mask-*
      // 已除以面板 zoom 的 CSS px（mask 带 zoom，fixed 内 px 会被放大，须预
      // 除——JS 算好，避开 calc(px / var()) 的老 Chromium 兼容雷）。zoom 每次
      // 现读 computed style，字号换档自动跟随，无需额外依赖。
      useEffect(function () {
        if (typeof document === "undefined" || typeof window === "undefined") return undefined;
        var docEl = document.documentElement;
        if (!docEl || !docEl.style) return undefined;
        var ALL_VARS = [
          "--myt-anchor-left", "--myt-anchor-width", "--myt-anchor-bottom",
          "--myt-mask-top", "--myt-mask-right", "--myt-mask-bottom", "--myt-mask-left",
        ];
        var clear = function () {
          ALL_VARS.forEach(function (v) { docEl.style.removeProperty(v); });
        };
        var px = function (n) { return (Math.round(n * 100) / 100) + "px"; };
        var apply = function () {
          raf = 0;
          var el = document.querySelector("[data-dsh-maoying-view]");
          if (!el || !el.isConnected) { clear(); return; }
          var r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) { clear(); return; } // display:none 等异常态不锚定
          docEl.style.setProperty("--myt-anchor-left", px(r.left));
          docEl.style.setProperty("--myt-anchor-width", px(r.width));
          docEl.style.setProperty("--myt-anchor-bottom", px(Math.max(0, window.innerHeight - r.bottom)));
          var zoom = 1;
          try {
            var cs = window.getComputedStyle(el);
            var pz = cs && cs.zoom ? parseFloat(cs.zoom) : NaN;
            if (pz > 0) zoom = pz;
          } catch (err) { /* 老宿主无 computed zoom：按 1 处理 */ }
          docEl.style.setProperty("--myt-mask-top", px(r.top / zoom));
          docEl.style.setProperty("--myt-mask-right", px(Math.max(0, window.innerWidth - r.right) / zoom));
          docEl.style.setProperty("--myt-mask-bottom", px(Math.max(0, window.innerHeight - r.bottom) / zoom));
          docEl.style.setProperty("--myt-mask-left", px(r.left / zoom));
        };
        var raf = 0;
        var schedule = function () {
          if (raf) return;
          raf = window.requestAnimationFrame(apply);
        };
        apply();
        window.addEventListener("resize", schedule);
        var ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        var el = document.querySelector("[data-dsh-maoying-view]");
        if (ro && el) ro.observe(el);
        return function () {
          if (raf) window.cancelAnimationFrame(raf);
          window.removeEventListener("resize", schedule);
          if (ro) ro.disconnect();
          clear();
        };
      }, []);

      // 选中校正：记忆的工作区必须仍在列表且 hasNovel，否则落回首个 hasNovel。
      var effectiveWs = (function () {
        if (!workspaces) return "";
        var hit = null;
        for (var i = 0; i < workspaces.length; i++) {
          var w = workspaces[i];
          if (w.path === selWs && w.hasNovel) { hit = w; break; }
        }
        if (hit) return hit.path;
        for (var j = 0; j < workspaces.length; j++) {
          if (workspaces[j].hasNovel) return workspaces[j].path;
        }
        return "";
      })();

      var loadWorkspaces = useCallback(function () {
        setWsErr("");
        return apiGet("workspaces").then(function (d) {
          var list = Array.isArray(d && d.workspaces) ? d.workspaces : [];
          // hasNovel 排前，各自按 name 稳定排序（spec §4：hasNovel 排前）。
          list.sort(function (a, b) {
            if (!!a.hasNovel !== !!b.hasNovel) return a.hasNovel ? -1 : 1;
            return String(a.name || a.path || "").localeCompare(String(b.name || b.path || ""), "zh-CN");
          });
          setWorkspaces(list);
          return list;
        }).catch(function (err) {
          setWsErr(err.message);
          setWorkspaces([]);
        });
      }, []);
      var stateSeqRef = useRef(0); // state 请求序号：快速切工作区时丢弃过期响应
      var loadState = useCallback(function (root) {
        var seq = ++stateSeqRef.current; // 先自增再发请求；早退分支也作废在途旧响应
        if (!root) { setSnap(null); setStateErr(""); setLoading(false); return; }
        setLoading(true);
        setStateErr("");
        return apiGet("state", { path: root }).then(function (d) {
          if (seq !== stateSeqRef.current) return; // 过期响应：已有更新的请求在途，丢弃
          setSnap(d && d.ok ? d : null);
        }).catch(function (err) {
          if (seq !== stateSeqRef.current) return;
          setSnap(null);
          setStateErr(err.message);
        }).finally(function () {
          if (seq === stateSeqRef.current) setLoading(false); // 过期收尾不碰加载态
        });
      }, []);
      var reload = useCallback(function () {
        return effectiveWs ? loadState(effectiveWs) : Promise.resolve();
      }, [effectiveWs, loadState]);

      // 新版检测（模仿 dsh-paoding）：面板打开时拉一次（服务端有 1h 缓存），
      // updateAvailable 才渲染徽章；失败静默，不打扰任何主流程。
      var _ver = useState(null), ver = _ver[0], setVer = _ver[1];
      useEffect(function () {
        apiGet("update-check").then(function (d) {
          if (d && d.current) setVer(d); // 常态也显示当前版本号；有新版再亮徽章
        }).catch(function () {});
      }, []);
      // 一键升级状态机：""（可点）→ "installing"（安装中，按钮禁用）→
      // "installed"（已装完待重启，按钮永久禁用、新版徽章收起）。可预期失败
      // （dev-link / pnpm-missing / pnpm 出错）回落 "" 允许重试。
      var _up = useState(""), upState = _up[0], setUpState = _up[1];
      function runSelfUpdate() {
        if (upState !== "") return;
        setUpState("installing");
        // 不走 apiPost：成功提示要带新版本号、失败按 kind 分流文案，且超时
        // 单独放宽（服务端 pnpm 最长 180s，统一 60s 会先掐断，见常量处注释）。
        maoyingApi("self-update", {}, SELF_UPDATE_TIMEOUT_MS).then(function (d) {
          if (d && d.ok) {
            setUpState("installed");
            // 硬约束照实说：装完只是磁盘换新，运行中的进程仍是旧代码。
            toast.ok(tf("toast.selfUpdate.ok", { ver: (d && d.to) || "?" }));
          } else if (d && d.kind === "dev-link") {
            setUpState("");
            toast.warn(tt("toast.selfUpdate.devLink"));
          } else if (d && d.kind === "pnpm-missing") {
            setUpState("");
            toast.warn(tt("toast.selfUpdate.pnpmMissing"));
          } else {
            setUpState("");
            toast.err(tf("toast.prefix", { msg: (d && d.error) || tt("common.unknownErr") }));
          }
        }).catch(function (err) {
          setUpState("");
          toast.err(tf("toast.prefix", { msg: err.message }));
        });
      }
      useEffect(function () { loadWorkspaces(); }, [loadWorkspaces]);
      // 每次打开面板都重拉工作区列表：懒挂载下关闭只是摘掉 active 属性，
      // 组件不卸载，上面的 mount effect 整个页面生命周期只跑一次，期间外部
      // （CLI / 其他面板）新建或删除的工作区在重开时看不见。mountPanel 每次
      // 打开都会广播 dsh-panel-activate（source: "maoying"），借它触发重拉；
      // 首次打开的广播早于本组件挂载（render 异步调度），收不到也无妨——
      // mount effect 已覆盖首拉。其余面板的同名广播按 source 过滤掉。
      useEffect(function () {
        var onActivate = function (event) {
          var source = event && event.detail && event.detail.source;
          if (source === "maoying") loadWorkspaces();
        };
        document.addEventListener(ACTIVATE_EVENT, onActivate);
        return function () { document.removeEventListener(ACTIVATE_EVENT, onActivate); };
      }, [loadWorkspaces]);
      useEffect(function () { loadState(effectiveWs); }, [effectiveWs, loadState]);
      // 校正后的选择回写记忆（首次打开 / 记忆失效时自动落位）。
      useEffect(function () {
        if (effectiveWs && effectiveWs !== selWs) { setSelWs(effectiveWs); lsSet(WS_STORAGE_KEY, effectiveWs); }
      }, [effectiveWs, selWs]);

      function chooseWs(e) {
        var path = e && e.target ? e.target.value : "";
        if (path) lsSet(WS_STORAGE_KEY, path);
        setSelWs(path);
      }
      function gotoTab(next, chapterFile) {
        setTab(next);
        setReaderFile(next === "chapters" && chapterFile ? chapterFile : null);
      }

      var novelWorkspaces = (workspaces || []).filter(function (w) { return w.hasNovel; });
      var body = null;
      if (workspaces === null) {
        body = h(SkelPage); // 首拉未回：骨架，不闪引导卡
      } else if (!effectiveWs) {
        // 全无 novel 工作区：引导卡（maoying init + 复制）。
        body = h("div", { className: "myt-stack" },
          wsErr ? ErrorStrip({ text: tf("shell.wsListFailed", { msg: wsErr }), onRetry: loadWorkspaces }) : null,
          h(GuideCard, {
            title: tt("guide.noWsTitle"),
            desc: tt("guide.noWsDesc"),
          }));
      } else if (loading && !snap) {
        body = h(SkelPage);
      } else if (stateErr) {
        body = h(ErrorStrip, { text: tf("shell.stateFailed", { msg: stateErr }), onRetry: reload });
      } else if (snap && snap.found === false) {
        body = h(GuideCard, {
          title: tt("guide.notInitTitle"),
          desc: tt("guide.notInitDesc"),
        });
      } else if (snap) {
        var tabProps = { snap: snap, reload: reload, wsPath: effectiveWs };
        if (readerFile) body = h(ChapterReader, { file: readerFile, snap: snap, reload: reload, wsPath: effectiveWs, onBack: function () { setReaderFile(null); } });
        else if (tab === "chapters") body = h(ChaptersTab, Object.assign({ onOpenChapter: function (f) { setReaderFile(f); } }, tabProps));
        else if (tab === "characters") body = h(CharactersTab, tabProps);
        else if (tab === "foreshadows") body = h(ForeshadowsTab, tabProps);
        else if (tab === "relations") body = h(RelationsTab, tabProps);
        else if (tab === "timeline") body = h(TimelineTab, tabProps);
        else if (tab === "world") body = h(WorldTab, tabProps);
        else if (tab === "index") body = h(IndexTab, tabProps);
        else body = h(OverviewTab, Object.assign({ gotoTab: gotoTab }, tabProps));
      }

      return h("div", { className: "myt-shell" },
        h("header", { className: "myt-header" },
          h("div", null,
            h("h1", { className: "myt-title" }, "毛颖创作台",
              ver && ver.current ? h("span", { className: "myt-verTag", title: tt("header.curVerTitle") }, ver.current) : null,
              ver && ver.updateAvailable
                ? [
                    // 徽章（跳发布页）+「一键升级」按钮双元素；装完（installed）
                    // 徽章收起——磁盘已是新版，别再引导去发布页——按钮变
                    // 「已安装，待重启」保持禁用，重启 DeepSeek 换新进程后才消失。
                    upState !== "installed"
                      ? h("a", { key: "b", className: "myt-verBadge", href: ver.releaseUrl || "#", target: "_blank", rel: "noreferrer", title: tf("header.upgradeTip", { cur: ver.current }) },
                          tf("header.newVersion", { ver: ver.latest }))
                      : null,
                    h("button", {
                      key: "u", type: "button", className: "myt-verUpgrade",
                      disabled: upState !== "",
                      title: upState === "installed" ? tt("header.upgradedTitle") : tt("header.upgradeTitle"),
                      onClick: runSelfUpdate,
                    },
                      upState === "installing" ? tt("header.upgrading") : upState === "installed" ? tt("header.upgraded") : tt("header.upgradeBtn")),
                  ]
                : null),
            h("p", { className: "myt-subtitle" }, tt("header.subtitle"))),
          h("div", { className: "myt-headActions" },
            workspaces && novelWorkspaces.length
              ? [h("span", { className: "myt-wsLabel", key: "l" }, tt("header.workspace")),
                 h("select", { className: "myt-wsSelect", key: "s", value: effectiveWs, onChange: chooseWs, "aria-label": tt("header.wsAria") },
                   workspaces.map(function (w, i) {
                     return h("option", { key: w.path || i, value: w.path || "", disabled: !w.hasNovel },
                       (w.hasNovel ? "" : tt("header.noNovel")) + (w.name || w.path || tt("header.untitled")));
                   }))]
              : null,
            h("button", { type: "button", className: "myt-btn myt-btnIcon", title: tt("header.settings"), "aria-label": tt("header.settings"), onClick: function () { setShowSettings(true); } }, ic("IconSettingsOutlineRegular", 14)),
            h("button", { type: "button", className: "myt-btn myt-btnIcon", title: tt("header.refresh"), "aria-label": tt("header.refresh"), disabled: loading, onClick: reload }, ic("IconRefreshOutlineRegular", 14)),
            h("button", { type: "button", className: "myt-closeBtn", "aria-label": tt("header.closeAria"), title: tt("header.closeTitle"), onClick: onClose }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
        readerFile ? null : h("nav", { className: "myt-tabs", "aria-label": tt("tabs.aria") },
          TABS.map(function (t) {
            return h("button", {
              key: t[0], type: "button", className: "myt-tab", "data-active": tab === t[0] ? "true" : undefined,
              onClick: function () { gotoTab(t[0]); },
            }, tt(t[1]));
          })),
        h("div", { className: "myt-body" },
          h("div", { className: "myt-page" },
            snap && Array.isArray(snap.warnings) && snap.warnings.length ? WarningsStrip(snap.warnings) : null,
            // 错误边界包住 tab 内容：key 随 tab / 阅读页变化重挂，切分区自动清错误态。
            h(TabErrorBoundary, { key: readerFile ? "reader:" + readerFile : tab, onRetry: reload }, body))),
        showSettings ? h(SettingsModal, { scale: fontScale, onPick: setFontScale, lang: lang, onPickLang: setLang, onClose: function () { setShowSettings(false); } }) : null,
        h(ToastHost));
    }

    // warnings 黄条（坏文件清单，spec §3：面板顶部显示）。
    function WarningsStrip(warnings) {
      return h("div", { className: "myt-strip myt-stripWarn" },
        h("span", { className: "myt-stripIcon" }, ic("IconWarningOutlineRegular", 14)),
        h("span", { className: "myt-stripText" },
          h("div", null, h("strong", null, tt("warnings.title"))),
          warnings.map(function (w, i) { return h("div", { key: i }, "· " + String(w)); })));
    }

    // 静态体检黄条：checkProject 的原始问题清单（快照侧会把越枚举 status
    // 归一成 pending，人工改坏在快照里看不出来，这里照 CLI check 同源透出）。
    // 含 error 级问题时叠加强调 class（纯 CSS，见 base.css）。
    function CheckStrip(problems) {
      var errs = 0;
      for (var i = 0; i < problems.length; i++) { if (problems[i] && problems[i].level === "error") errs++; }
      return h("div", { className: "myt-strip myt-stripWarn" + (errs > 0 ? " myt-stripCheckErr" : "") },
        h("span", { className: "myt-stripIcon" }, ic("IconWarningOutlineRegular", 14)),
        h("span", { className: "myt-stripText" },
          h("div", null, h("strong", null, tf("check.title", { n: fmtNum(problems.length), err: fmtNum(errs), warn: fmtNum(problems.length - errs) }))),
          problems.slice(0, 8).map(function (p, i) {
            return h("div", { key: i }, "· [" + String((p && p.level) || "") + "] " + String((p && p.file) || "") + ": " + String((p && p.message) || ""));
          }),
          h("div", null, tt("check.fullHint"))));
    }

    // ── 概览 tab：project 卡（含「编辑」书稿元信息，原小说设置并入）+ 统计卡
    // + 最近更新 ─────────────────────────────────────────────────────────────
    function OverviewTab(props) {
      var snap = props.snap;
      var reload = props.reload;
      var gotoTab = props.gotoTab;
      var wsPath = props.wsPath;
      var project = snap.project || {};
      // 编辑态：true 时 hero 卡切换为书稿元信息表单（ProjectMetaForm）。
      var _ed = useState(false), editing = _ed[0], setEditing = _ed[1];
      var totals = snap.totals || {};
      var byStatus = totals.byStatus || {};
      var _b = useState(false), phaseBusy = _b[0], setPhaseBusy = _b[1];
      var phaseIdx = PHASES.indexOf(project.phase);
      var nextPhase = phaseIdx !== -1 && phaseIdx < PHASES.length - 1 ? PHASES[phaseIdx + 1] : null;
      // 静态体检黄条：仅 found 时拉 check 路由（未初始化没有可查的东西）。
      // 工作区切换与每次 reload 都换新 snap → effect 重跑即重查；请求序号防
      // 过期响应（快速切工作区时在途旧响应不得落进新工作区的黄条）。
      var _ck = useState(null), checkProblems = _ck[0], setCheckProblems = _ck[1];
      var checkSeqRef = useRef(0);
      useEffect(function () {
        if (!snap || !snap.found || !wsPath) { setCheckProblems(null); return; }
        var seq = ++checkSeqRef.current; // 先自增再发请求；早退分支也作废在途旧响应
        apiGet("check", { path: wsPath }).then(function (d) {
          if (seq !== checkSeqRef.current) return; // 过期响应：已有更新的请求在途，丢弃
          setCheckProblems(d && d.ok && Array.isArray(d.problems) ? d.problems : []);
        }).catch(function () {
          if (seq !== checkSeqRef.current) return;
          setCheckProblems(null); // 拉取失败不显示黄条（toast 已由 apiGet 统一提示）
        });
      }, [snap, wsPath]);
      function advancePhase() {
        if (!nextPhase || phaseBusy) return;
        setPhaseBusy(true);
        apiPost("phase", { path: props.wsPath, phase: nextPhase }).then(reload).catch(function () {}).finally(function () { setPhaseBusy(false); });
      }
      var recent = (snap.chapters || []).slice().sort(function (a, b) { return (b.num || 0) - (a.num || 0); }).slice(0, 5);
      var volumes = snap.volumes || [];
      return h("div", { className: "myt-stack" },
        checkProblems && checkProblems.length ? CheckStrip(checkProblems) : null,
        editing
          // 编辑态：hero 卡整体换成元信息表单（保存/取消在表单卡内）。
          ? h(ProjectMetaForm, { snap: snap, wsPath: wsPath, reload: reload, onDone: function () { setEditing(false); } })
          : h("div", { className: "myt-card myt-hero" },
              [
                h("div", { className: "myt-heroMeta", key: "meta" },
                  project.author ? h("span", { className: "myt-muted" }, tf("overview.author", { name: project.author })) : null,
                  project.genre ? h("span", { className: "myt-badge" }, project.genre) : null,
                  project.length ? h("span", { className: "myt-badge" }, project.length) : null,
                  project.language ? h("span", { className: "myt-badge" }, project.language) : null,
                  h("button", { type: "button", className: "myt-btn myt-heroEdit", title: tt("overview.editTip"), "aria-label": tt("overview.editTip"), onClick: function () { setEditing(true); } },
                    ic("IconEditOutlineRegular", 13), tt("overview.edit"))),
                h("h2", { className: "myt-heroTitle", key: "title" }, orDash(project.title)),
                h("div", { className: "myt-heroMeta", key: "phase" },
                  phasePill(project.phase),
                  nextPhase ? h("button", { type: "button", className: "myt-btn", disabled: phaseBusy, onClick: advancePhase, title: tf("phase.advanceTitle", { next: tt("phase." + nextPhase) }) }, phaseBusy ? tt("phase.advancing") : tt("phase.advance")) : h("span", { className: "myt-muted" }, project.phase ? tt("phase.final") : null)),
                project.description ? h("p", { className: "myt-heroDesc", key: "desc" }, project.description) : null,
              ]),
        h("div", { className: "myt-statRow" },
          h("div", { className: "myt-card myt-stat" }, h("span", { className: "myt-statNum" }, fmtNum(totals.words)), h("span", { className: "myt-statLabel" }, tt("overview.totalWords"))),
          h("div", { className: "myt-card myt-stat" }, h("span", { className: "myt-statNum" }, fmtNum(totals.chapters)), h("span", { className: "myt-statLabel" }, tt("overview.totalChapters"))),
          h("div", { className: "myt-card myt-stat" },
            h("span", { className: "myt-statNum" }, fmtNum((snap.characters || []).length)),
            h("span", { className: "myt-statLabel" }, tt("overview.characters"))),
          h("div", { className: "myt-card myt-stat" },
            h("span", { className: "myt-statNum" }, fmtNum((snap.foreshadows || []).filter(function (f) { return f.status === "planted" || f.status === "progressing"; }).length)),
            h("span", { className: "myt-statLabel" }, tt("overview.openForeshadows")))),
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("overview.statusDist"))),
          h("div", { className: "myt-distBar", "aria-hidden": "true" }, STATUS_FLOW.map(function (s) {
            var n = byStatus[s] || 0;
            return n > 0 ? h("div", { key: s, className: "myt-distSeg", "data-status": s, style: { flexGrow: n } }) : null;
          })),
          h("div", { className: "myt-heroMeta" }, STATUS_FLOW.map(function (s) {
            return h("span", { key: s, className: "myt-muted" }, tt("status." + s) + " " + (byStatus[s] || 0));
          }))),
        volumes.length ? h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("overview.volumes")),
            h("span", { className: "myt-boardCount" }, volumes.length)),
          h("div", { className: "myt-stack" }, volumes.map(function (v, i) {
            return h("div", { key: v.id || i, className: "myt-worldGroup" },
              h("div", { className: "myt-listHead" },
                h("span", { className: "myt-worldName" }, (v.id ? v.id + " · " : "") + orDash(v.title)),
                v.chapters ? h("span", { className: "myt-tag" }, v.chapters) : null),
              v.summary ? h("div", { className: "myt-worldDesc" }, v.summary) : null);
          }))) : null,
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("overview.recent"))),
          recent.length
            ? h("div", { className: "myt-recentList" }, recent.map(function (ch) {
                return h("button", { key: ch.file, type: "button", className: "myt-recentRow", onClick: function () { gotoTab("chapters", ch.file); } },
                  statusBadge(ch.status),
                  h("span", { className: "myt-chTitle" }, orDash(ch.title)),
                  h("span", { className: "myt-chPath" }, chWhere(ch)),
                  h("span", { className: "myt-wordsCell" }, tf("common.charCount", { n: fmtNum(ch.words) })));
              }))
            : h(Empty, { text: tt("chapters.empty") })));
    }

    // ── 轻量 Markdown 渲染（零依赖）：先整体 HTML 转义再施加 md 变换，杜绝
    // 注入；支持标题/加粗/斜体/删除线/行内码/围栏码/引用/有序无序列表/分隔线/
    // 链接/段落换行。供章纲、世界观条目等 md 阅读位使用，正文手稿仍走 pre。 ──
    function escapeHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    // 链接 scheme 白名单：仅放行 http/https 绝对地址与无 scheme 的相对路径 /
    // 锚点 / //协议相对；javascript:/data:/vbscript: 等一律拒绝（调用方落纯文本）。
    function isSafeLinkUrl(url) {
      var m = String(url || "").match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
      return !m || /^https?$/i.test(m[1]);
    }
    function inlineMd(s) {
      // 行内码占位保护：先抽出 `code` 区间换成哨兵占位符，加粗/斜体/删除线/
      // 链接不再命中码内文本（否则 `*x*` 会被二次加格式），最后回填。
      // 哨兵用 NUL 控制符 + 固定前缀：正文已过 escapeHtml，不可能出现该序列。
      var codes = [];
      var out = String(s).replace(/`([^`]+)`/g, function (_m, code) {
        codes.push("<code>" + code + "</code>");
        return "\u0000MYTCODE" + (codes.length - 1) + "\u0000";
      })
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, txt, url) {
          if (!isSafeLinkUrl(url)) return _m; // 白名单外：原样落纯文本，不生成 href
          return '<a href="' + url + '" target="_blank" rel="noreferrer">' + txt + "</a>";
        });
      return out.replace(/\u0000MYTCODE(\d+)\u0000/g, function (_m, i) { return codes[Number(i)] || ""; });
    }
    function renderMd(src) {
      var lines = escapeHtml(src).split(/\r?\n/);
      var html = [];
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        if (/^```/.test(line)) {
          var code = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
          i++; // 吃掉收尾 ```（缺失也吞到尾）
          html.push('<pre class="myt-mdCode"><code>' + code.join("\n") + "</code></pre>");
          continue;
        }
        if (/^\s*$/.test(line)) { i++; continue; }
        var h2 = line.match(/^(#{1,6})\s+(.*)$/);
        if (h2) {
          var lv = h2[1].length;
          html.push('<h' + lv + ' class="myt-mdH">' + inlineMd(h2[2]) + "</h" + lv + ">");
          i++; continue;
        }
        if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html.push('<hr class="myt-mdHr">'); i++; continue; }
        if (/^\s*&gt;\s?/.test(line)) {
          var quote = [];
          while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { quote.push(inlineMd(lines[i].replace(/^\s*&gt;\s?/, ""))); i++; }
          html.push('<blockquote class="myt-mdQuote">' + quote.join("<br>") + "</blockquote>");
          continue;
        }
        var ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
          var items = [];
          while (i < lines.length) {
            var m1 = lines[i].match(/^\s*[-*+]\s+(.*)$/);
            if (!m1) break;
            items.push("<li>" + inlineMd(m1[1]) + "</li>");
            i++;
          }
          html.push('<ul class="myt-mdList">' + items.join("") + "</ul>");
          continue;
        }
        var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ol) {
          var oitems = [];
          while (i < lines.length) {
            var m2 = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
            if (!m2) break;
            oitems.push("<li>" + inlineMd(m2[1]) + "</li>");
            i++;
          }
          html.push('<ol class="myt-mdList">' + oitems.join("") + "</ol>");
          continue;
        }
        var para = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```|^\s*&gt;|^\s*[-*+]\s|^\s*\d+[.)]\s|^#{1,6}\s/.test(lines[i])) {
          para.push(lines[i]); i++;
        }
        html.push('<p class="myt-mdP">' + inlineMd(para.join("<br>")) + "</p>");
      }
      // 块间直接相连不补 "\n"：落点容器（.myt-outlineBody / .myt-worldDesc）是
      // white-space:pre-wrap，块间再塞换行会渲染成额外空行 → 双倍间距；
      // 块间距已由 .myt-md* 各自 margin 承担。
      return html.join("");
    }
    function MdView(props) {
      return h("div", {
        className: "myt-md" + (props.className ? " " + props.className : ""),
        dangerouslySetInnerHTML: { __html: renderMd(props.text || "") },
      });
    }

    // ── 系统设置：字号五档（面板整体 zoom，抽屉/弹层 portal 节点同缩放）──────
    var FONT_SCALE_KEY = "maoying.fontScale";
    var FONT_SCALES = [["1", "100%"], ["1.1", "110%"], ["1.2", "120%"], ["1.3", "130%"], ["1.4", "140%"], ["1.5", "150%"]];
    // ── 界面语言（系统设置可选中文/English）：UI_LANG 为模块级当前语言，
    // PageShell 在 lang state 变化时改写它并整树重渲。tt/tf 是唯一取词口：
    // zh 词典的值必须与历史硬编码文案逐字一致（中文界面零回归），en 词典
    // 不留中文；词典缺键回落 key 本身（便于渐进迁移，一眼看出漏网串）。 ──
    var LANG_KEY = "maoying.lang";
    var UI_LANGS = [["zh", "中文"], ["en", "English"]];
    var UI_LANG = "zh";
    var I18N = {
      zh: {
        "shell.title": "毛颖创作台", "header.subtitle": "网文项目可视化与状态流转 · 只读正文，写状态",
        "header.curVerTitle": "当前版本", "header.upgradeTip": "当前 {cur}，点击打开新版发布页", "header.newVersion": "有新版 {ver} ↗",
        "header.upgradeBtn": "一键升级", "header.upgrading": "安装中…", "header.upgraded": "已安装，待重启",
        "header.upgradeTitle": "用 pnpm 安装 npm 最新版（最长约 3 分钟），装完需重启 DeepSeek 生效",
        "header.upgradedTitle": "已安装新版，重启 DeepSeek 后生效",
        "toast.selfUpdate.ok": "已安装 {ver}，重启 DeepSeek 后生效",
        "toast.selfUpdate.devLink": "开发目录安装，请 git pull 更新", "toast.selfUpdate.pnpmMissing": "未找到 pnpm，请手动安装",
        "header.workspace": "工作区", "header.wsAria": "选择工作区", "header.noNovel": "（无 novel）", "header.untitled": "未命名",
        "header.settings": "系统设置", "header.refresh": "重新拉取", "header.closeAria": "关闭创作台", "header.closeTitle": "关闭",
        "tabs.aria": "创作台分区",
        "tabs.overview": "概览", "tabs.chapters": "章节", "tabs.characters": "角色", "tabs.foreshadows": "伏笔", "tabs.relations": "关系图",
        "tabs.timeline": "时间线", "tabs.world": "设定", "tabs.index": "索引板",
        "shell.wsListFailed": "工作区列表拉取失败：{msg}", "shell.stateFailed": "快照拉取失败：{msg}",
        "guide.noWsTitle": "还没有可用的小说工作区", "guide.noWsDesc": "任一工作区根目录下出现 novel/project.yml 即自动入选；先用命令初始化目录骨架：",
        "guide.notInitTitle": "该工作区尚未初始化小说项目", "guide.notInitDesc": "工作区根目录下没有 novel/project.yml。在该工作区根目录执行：",
        "guide.defaultTitle": "该工作区还没有小说项目", "guide.defaultDesc": "在下面给出的命令里初始化目录骨架（或把已有 novel 目录放进工作区根），然后刷新本面板。",
        "guide.copied": "已复制 maoying init", "guide.copyFailed": "复制失败，请手动选择命令文本", "guide.copying": "复制中…", "guide.copyCmd": "复制命令",
        "common.retry": "重试", "common.empty": "暂无数据", "common.uncategorized": "未分类", "common.charCount": "{n} 字",
        "common.closeTip": "关闭提示", "common.unknownErr": "未知错误", "common.priorityTitle": "优先级：{pri}", "common.priorityAria": "优先级{pri}",
        "common.chapterNum": "第 {n} 章", "pri.high": "高", "pri.normal": "中", "pri.low": "低",
        "toast.prefix": "毛颖创作台：{msg}", "toast.success": "操作成功", "toast.indexRebuilt": "索引已重建（{n} 章）",
        "toast.chapterStatus": "章节状态已更新", "toast.chapterCreated": "已从章纲建章「{title}」（待写）", "toast.foreshadowStatus": "伏笔状态已更新", "toast.phaseAdvanced": "阶段已推进到「{phase}」",
        "api.notJson": "响应不是 JSON（HTTP {code}）", "api.timeout": "请求超时（{s} 秒）",
        "status.pending": "待写", "status.writing": "写作中", "status.review": "审校中", "status.accepted": "已定稿", "status.rawSuffix": "（{raw}）",
        "phase.idea": "立意", "phase.setting": "设定", "phase.outline": "大纲", "phase.writing": "写作", "phase.review": "审校",
        "phase.consistency": "一致性", "phase.export": "导出", "phase.unset": "未设阶段",
        "phase.advanceTitle": "推进到「{next}」", "phase.advance": "推进阶段", "phase.advancing": "推进中…", "phase.final": "已是最终阶段",
        "foreshadow.planted": "埋设", "foreshadow.progressing": "推进中", "foreshadow.resolved": "已回收", "foreshadow.abandoned": "已弃用",
        "foreshadow.advance": "推进", "foreshadow.resolve": "回收", "foreshadow.abandon": "弃用", "foreshadow.advancing": "推进中…",
        "foreshadow.plantedUnmarked": "埋设章未标", "foreshadow.resolvedAt": "回收于 {ch}", "foreshadow.priorityLabel": "优先级 {pri}",
        "foreshadow.backfill": "回填", "foreshadow.backfillTip": "从作者正文回填", "foreshadow.missingStatus": "缺 status",
        "foreshadow.noIdTip": "该条目缺 id，无法写状态",
        "foreshadow.noStatusTip": "该条目缺 status 行，服务端会拒绝流转（409）；请先在 foreshadows.yml 补上 status",
        "foreshadow.empty": "foreshadows.yml 还没有伏笔条目", "foreshadow.colEmpty": "空",
        "clue.clue": "线索", "clue.redHerring": "红鲱鱼", "clue.inference": "推理", "clue.question": "疑问",
        "sci.known": "已确证", "sci.extrapolation": "推演", "sci.hypothesis": "假说", "world.unlabeled": "未标级",
        "warnings.title": "部分文件解析异常（已跳过）：",
        "check.title": "静态体检：{n} 项（错误 {err} / 警告 {warn}）", "check.fullHint": "全量结果请在终端运行 maoying check 查看",
        "index.title": "索引板（clue-board / memories）", "index.rebuild": "重建索引", "index.rebuilding": "重建中…",
        "index.rebuildTip": "按 CLI index 同一逻辑重建 index.yml", "index.clueBoard": "线索板", "index.clueEmpty": "clue-board.yml 还没有条目",
        "index.memBoard": "记忆板", "index.memEmpty": "memories.yml 还没有条目", "index.promise": "承诺线",
        "timeline.empty": "timeline.yml 还没有时间线条目", "timeline.importance": "重要度 {n}", "timeline.linkedChapter": "关联章节：{ch}",
        "world.title": "世界观条目", "world.empty": "world/ 目录还没有设定条目", "world.science": "科学设定",
        "world.scienceEmpty": "science/ 目录还没有科学设定", "world.research": "资料检索", "world.ref": "参考 {n}：{r}",
        "relations.title": "角色关系图", "relations.counts": "{n} 节点 · {m} 关系",
        "relations.help": "拖节点固定位置 · 滚轮缩放 · 双击复位 · 悬停边看关系描述",
        "relations.unlinkedTitle": "未入图角色（无关系边）", "relations.noData": "没有角色或关系数据，无法绘图",
        "relations.edgeTipPrefix": "{type}：", "relations.noDesc": "（无描述）",
        "char.empty": "characters/ 目录还没有角色卡",
        "role.protagonist": "主角", "role.antagonist": "反派", "role.supporting": "配角", "role.minor": "龙套",
        "char.field.age": "年龄", "char.field.gender": "性别", "char.field.appearance": "外貌", "char.field.personality": "性格",
        "char.field.background": "背景", "char.field.motivation": "动机", "char.field.arc": "成长弧",
        "char.years": "{n} 岁", "char.linePersonality": "性格 ", "char.lineMotivation": "动机 ",
        "char.modalAria": "角色详情", "char.closeAria": "关闭角色卡", "char.markers": "标记", "char.file": "文件",
        "overview.author": "作者：{name}", "overview.totalWords": "总字数（CJK）", "overview.totalChapters": "章节总数",
        "overview.characters": "角色数", "overview.openForeshadows": "未回收伏笔", "overview.statusDist": "章节状态分布", "overview.recent": "最近章节",
        "overview.volumes": "分卷规划",
        "overview.edit": "编辑", "overview.editTip": "编辑书稿元信息",
        "chapters.empty": "chapters/ 目录还没有章节文件", "chapters.writeQueue": "按单写作", "chapters.rowTip": "点击打开该章",
        "chapters.outlineWords": "章纲 {n} 字", "chapters.all": "全部", "chapters.thVolume": "卷 · 章", "chapters.thTitle": "标题",
        "chapters.thStatus": "状态", "chapters.thWords": "字数", "chapters.thSummary": "梗概", "chapters.rowReadTip": "点击阅读正文",
        "chapters.emptyFiltered": "该状态下没有章节",
        "chapters.outlineRowTip": "点击查看章纲全文", "chapters.noChapter": "未建章", "chapters.createBtn": "建章", "chapters.creating": "建章中…",
        "chapters.createTip": "在 chapters/ 下按章纲建一章（status=pending，正文待写）",
        "chapters.emptyWithOutlines": "chapters/ 目录还没有章节文件；下方「按单写作」已列出未建章章纲",
        "reader.back": "返回", "reader.backTip": "返回章节列表", "reader.copyPath": "复制路径", "reader.copyPathTip": "复制章节文件路径",
        "reader.copied": "已复制章节文件路径", "reader.copyFailed": "复制失败，请手动选择路径文本", "reader.loadFailed": "正文读取失败：{msg}",
        "reader.noOutline": "暂无章纲", "reader.emptyBody": "（空章节）", "reader.finalState": "已定稿（终态）", "reader.statusFlow": "状态流转：",
        "reader.flowing": "流转中…", "reader.advanceTo": "推进到「{next}」",
        "outline.title": "章纲对照", "outline.empty": "（章纲为空）", "outline.collapseTip": "收起章纲", "outline.expandTip": "展开章纲",
        "outline.modalAria": "章纲全文", "outline.closeAria": "关闭章纲", "outline.loading": "章纲加载中…", "outline.loadFailed": "章纲读取失败：{msg}",
        "novel.metaTitle": "书稿元信息", "novel.metaNote": "对应 novel/project.yml · 行尾注释会原样保留",
        "novel.fTitle": "书名", "novel.titlePh": "如：长夜余火", "novel.fAuthor": "作者", "novel.authorPh": "笔名",
        "novel.fGenre": "题材", "novel.genrePh": "如：东方玄幻 / 都市异能 / 历史架空", "novel.fLength": "预期篇幅",
        "novel.lengthPh": "如：约100万字 / 300章", "novel.fLanguage": "正文语言", "novel.fPhase": "工作流阶段", "novel.fMode": "共创模式",
        "novel.fDesc": "一句话简介", "novel.descPh": "写封面文案时可直接引用", "novel.titleRequired": "书名不能为空",
        "mode.aiDraft": "AI 代笔（AI 写正文）", "mode.coWrite": "逐章共创（按章指派谁写）", "mode.authorDraft": "作者亲笔（AI 只备料审稿）",
        "novel.saving": "保存中…", "novel.save": "保存设置", "novel.cancel": "取消",
        "settings.title": "系统设置", "settings.closeAria": "关闭设置", "settings.language": "语言",
        "settings.languageHint": "界面文字随语言选项切换，立即生效并记忆。", "settings.fontScale": "字号",
        "settings.fontScaleHint": "按当前字号的百分比缩放整个创作台，立即生效并记忆。",
        "errBoundary.title": "该分区渲染出错", "errBoundary.summary": "错误摘要：{msg}",
        "dim.cognitiveFrame": "认知框架", "dim.emotionalAnchor": "情感锚点", "dim.worldTexture": "世界质感",
        "dim.suspense": "悬念", "dim.interpersonalTension": "人际张力",
      },
      en: {
        "shell.title": "Maoying Studio", "header.subtitle": "Web-novel project dashboard & status flow · read-only text, writable status",
        "header.curVerTitle": "Current version", "header.upgradeTip": "Current {cur} — click to open the release page", "header.newVersion": "New version {ver} ↗",
        "header.upgradeBtn": "Upgrade now", "header.upgrading": "Installing…", "header.upgraded": "Installed — restart pending",
        "header.upgradeTitle": "Install the latest npm release with pnpm (up to ~3 min); takes effect after restarting DeepSeek",
        "header.upgradedTitle": "New version installed — takes effect after restarting DeepSeek",
        "toast.selfUpdate.ok": "Installed {ver} — takes effect after restarting DeepSeek",
        "toast.selfUpdate.devLink": "Installed from a dev directory — update with git pull", "toast.selfUpdate.pnpmMissing": "pnpm not found — install it manually",
        "header.workspace": "Workspace", "header.wsAria": "Select workspace", "header.noNovel": "(no novel)", "header.untitled": "Untitled",
        "header.settings": "Settings", "header.refresh": "Refresh", "header.closeAria": "Close Maoying Studio", "header.closeTitle": "Close",
        "tabs.aria": "Studio sections",
        "tabs.overview": "Overview", "tabs.chapters": "Chapters", "tabs.characters": "Characters", "tabs.foreshadows": "Foreshadowing", "tabs.relations": "Relations",
        "tabs.timeline": "Timeline", "tabs.world": "Worldbuilding", "tabs.index": "Index Board",
        "shell.wsListFailed": "Failed to load workspace list: {msg}", "shell.stateFailed": "Failed to load snapshot: {msg}",
        "guide.noWsTitle": "No novel workspace available yet", "guide.noWsDesc": "A workspace is picked up automatically once novel/project.yml exists at its root; initialize the directory scaffold with this command first:",
        "guide.notInitTitle": "No novel project in this workspace yet", "guide.notInitDesc": "novel/project.yml is missing at the workspace root. Run this at the workspace root:",
        "guide.defaultTitle": "No novel project in this workspace yet", "guide.defaultDesc": "Initialize the directory scaffold with the command below (or drop an existing novel/ directory into the workspace root), then refresh this panel.",
        "guide.copied": "Copied maoying init", "guide.copyFailed": "Copy failed — select the command text manually", "guide.copying": "Copying…", "guide.copyCmd": "Copy command",
        "common.retry": "Retry", "common.empty": "No data", "common.uncategorized": "Uncategorized", "common.charCount": "{n} chars",
        "common.closeTip": "Dismiss notification", "common.unknownErr": "Unknown error", "common.priorityTitle": "Priority: {pri}", "common.priorityAria": "Priority {pri}",
        "common.chapterNum": "Ch. {n}", "pri.high": "High", "pri.normal": "Normal", "pri.low": "Low",
        "toast.prefix": "Maoying Studio: {msg}", "toast.success": "Success", "toast.indexRebuilt": "Index rebuilt ({n} chapters)",
        "toast.chapterStatus": "Chapter status updated", "toast.chapterCreated": "Created chapter \"{title}\" from the outline (pending)", "toast.foreshadowStatus": "Foreshadowing status updated", "toast.phaseAdvanced": "Phase advanced to {phase}",
        "api.notJson": "Response is not JSON (HTTP {code})", "api.timeout": "Request timed out ({s} s)",
        "status.pending": "Pending", "status.writing": "Writing", "status.review": "Review", "status.accepted": "Accepted", "status.rawSuffix": "({raw})",
        "phase.idea": "Idea", "phase.setting": "Setting", "phase.outline": "Outline", "phase.writing": "Writing", "phase.review": "Review",
        "phase.consistency": "Consistency", "phase.export": "Export", "phase.unset": "No phase",
        "phase.advanceTitle": "Advance to {next}", "phase.advance": "Advance phase", "phase.advancing": "Advancing…", "phase.final": "Final phase",
        "foreshadow.planted": "Planted", "foreshadow.progressing": "In Progress", "foreshadow.resolved": "Resolved", "foreshadow.abandoned": "Abandoned",
        "foreshadow.advance": "Advance", "foreshadow.resolve": "Resolve", "foreshadow.abandon": "Abandon", "foreshadow.advancing": "Advancing…",
        "foreshadow.plantedUnmarked": "Planting chapter unmarked", "foreshadow.resolvedAt": "Resolved in {ch}", "foreshadow.priorityLabel": "Priority {pri}",
        "foreshadow.backfill": "Backfill", "foreshadow.backfillTip": "Backfilled from the author's manuscript", "foreshadow.missingStatus": "missing status",
        "foreshadow.noIdTip": "This entry has no id — its status cannot be written",
        "foreshadow.noStatusTip": "This entry has no status line, the server will reject the transition (409); add a status in foreshadows.yml first",
        "foreshadow.empty": "No entries in foreshadows.yml yet", "foreshadow.colEmpty": "Empty",
        "clue.clue": "Clue", "clue.redHerring": "Red herring", "clue.inference": "Inference", "clue.question": "Question",
        "sci.known": "Confirmed", "sci.extrapolation": "Extrapolation", "sci.hypothesis": "Hypothesis", "world.unlabeled": "Unrated",
        "warnings.title": "Some files failed to parse (skipped):",
        "check.title": "Static check: {n} issue(s) ({err} errors / {warn} warnings)", "check.fullHint": "Run maoying check in a terminal for the full report",
        "index.title": "Index Board (clue-board / memories)", "index.rebuild": "Rebuild index", "index.rebuilding": "Rebuilding…",
        "index.rebuildTip": "Rebuild index.yml with the same logic as the CLI index command", "index.clueBoard": "Clue board", "index.clueEmpty": "No entries in clue-board.yml yet",
        "index.memBoard": "Memory board", "index.memEmpty": "No entries in memories.yml yet", "index.promise": "Promise thread",
        "timeline.empty": "No entries in timeline.yml yet", "timeline.importance": "Importance {n}", "timeline.linkedChapter": "Related chapter: {ch}",
        "world.title": "Worldbuilding entries", "world.empty": "No worldbuilding entries in world/ yet", "world.science": "Science settings",
        "world.scienceEmpty": "No science entries in science/ yet", "world.research": "Research", "world.ref": "Ref {n}: {r}",
        "relations.title": "Character relations", "relations.counts": "{n} nodes · {m} relations",
        "relations.help": "Drag a node to pin it · scroll to zoom · double-click to reset · hover an edge for its description",
        "relations.unlinkedTitle": "Unlinked characters (no relation edges)", "relations.noData": "No character or relation data to draw",
        "relations.edgeTipPrefix": "{type}: ", "relations.noDesc": "(no description)",
        "char.empty": "No character cards in characters/ yet",
        "role.protagonist": "Protagonist", "role.antagonist": "Antagonist", "role.supporting": "Supporting", "role.minor": "Minor",
        "char.field.age": "Age", "char.field.gender": "Gender", "char.field.appearance": "Appearance", "char.field.personality": "Personality",
        "char.field.background": "Background", "char.field.motivation": "Motivation", "char.field.arc": "Character arc",
        "char.years": "Age {n}", "char.linePersonality": "Personality ", "char.lineMotivation": "Motivation ",
        "char.modalAria": "Character details", "char.closeAria": "Close character card", "char.markers": "Tags", "char.file": "File",
        "overview.author": "Author: {name}", "overview.totalWords": "Total characters (CJK)", "overview.totalChapters": "Chapters",
        "overview.characters": "Characters", "overview.openForeshadows": "Unresolved foreshadowing", "overview.statusDist": "Chapter status breakdown", "overview.recent": "Recent chapters",
        "overview.volumes": "Volume plan",
        "overview.edit": "Edit", "overview.editTip": "Edit manuscript metadata",
        "chapters.empty": "No chapter files in chapters/ yet", "chapters.writeQueue": "Writing Queue", "chapters.rowTip": "Click to open this chapter",
        "chapters.outlineWords": "Outline {n} chars", "chapters.all": "All", "chapters.thVolume": "Vol · Ch", "chapters.thTitle": "Title",
        "chapters.thStatus": "Status", "chapters.thWords": "Words", "chapters.thSummary": "Summary", "chapters.rowReadTip": "Click to read",
        "chapters.emptyFiltered": "No chapters with this status",
        "chapters.outlineRowTip": "Click to view the full outline", "chapters.noChapter": "No chapter", "chapters.createBtn": "Create", "chapters.creating": "Creating…",
        "chapters.createTip": "Create a pending chapter in chapters/ from this outline (body to be written)",
        "chapters.emptyWithOutlines": "No chapter files in chapters/ yet — the Writing Queue below lists outlines without chapters",
        "reader.back": "Back", "reader.backTip": "Back to chapter list", "reader.copyPath": "Copy path", "reader.copyPathTip": "Copy chapter file path",
        "reader.copied": "Copied chapter file path", "reader.copyFailed": "Copy failed — select the path text manually", "reader.loadFailed": "Failed to load chapter text: {msg}",
        "reader.noOutline": "No chapter outline", "reader.emptyBody": "(empty chapter)", "reader.finalState": "Accepted (final)", "reader.statusFlow": "Status:",
        "reader.flowing": "Transitioning…", "reader.advanceTo": "Advance to {next}",
        "outline.title": "Outline", "outline.empty": "(outline is empty)", "outline.collapseTip": "Collapse outline", "outline.expandTip": "Expand outline",
        "outline.modalAria": "Chapter outline", "outline.closeAria": "Close outline", "outline.loading": "Loading outline…", "outline.loadFailed": "Failed to load outline: {msg}",
        "novel.metaTitle": "Manuscript metadata", "novel.metaNote": "Maps to novel/project.yml · trailing comments are preserved",
        "novel.fTitle": "Title", "novel.titlePh": "e.g. The Long Night", "novel.fAuthor": "Author", "novel.authorPh": "Pen name",
        "novel.fGenre": "Genre", "novel.genrePh": "e.g. Eastern fantasy / Urban powers / Alternate history", "novel.fLength": "Planned length",
        "novel.lengthPh": "e.g. ~1M characters / 300 chapters", "novel.fLanguage": "Text language", "novel.fPhase": "Workflow phase", "novel.fMode": "Co-writing mode",
        "novel.fDesc": "One-line synopsis", "novel.descPh": "Can be quoted directly in cover copy", "novel.titleRequired": "Title is required",
        "mode.aiDraft": "AI ghostwriting (AI drafts the prose)", "mode.coWrite": "Chapter-by-chapter co-writing (assign a writer per chapter)", "mode.authorDraft": "Author writes (AI only preps and reviews)",
        "novel.saving": "Saving…", "novel.save": "Save", "novel.cancel": "Cancel",
        "settings.title": "Settings", "settings.closeAria": "Close settings", "settings.language": "Language",
        "settings.languageHint": "UI text follows the language option; it applies immediately and is remembered.", "settings.fontScale": "Font size",
        "settings.fontScaleHint": "Scales the whole studio as a percentage of the current font size; applies immediately and is remembered.",
        "errBoundary.title": "This section failed to render", "errBoundary.summary": "Error summary: {msg}",
        "dim.cognitiveFrame": "Cognitive Frame", "dim.emotionalAnchor": "Emotional Anchor", "dim.worldTexture": "World Texture",
        "dim.suspense": "Suspense", "dim.interpersonalTension": "Interpersonal Tension",
      },
    };
    function tt(key) {
      var d = I18N[UI_LANG] || I18N.zh;
      var v = d[key];
      if (v === undefined) v = I18N.zh[key];
      return v === undefined ? key : v;
    }
    function tf(key, vars) {
      var s = tt(key);
      if (vars) for (var k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
      return s;
    }
    function SettingsModal(props) {
      var scale = props.scale;
      var onPick = props.onPick;
      var lang = props.lang;
      var onPickLang = props.onPickLang;
      var onClose = props.onClose;
      return h(MaskPortal, {
        className: "myt-settingsMask",
        onMouseDown: function (e) { if (e.target === e.currentTarget) onClose(); },
      },
        h("div", { className: "myt-settings", role: "dialog", "aria-modal": "true", "aria-label": tt("settings.title") },
          h("div", { className: "myt-settingsHead" },
            h("h3", { className: "myt-settingsTitle" }, tt("settings.title")),
            h("button", { type: "button", className: "myt-closeBtn", "aria-label": tt("settings.closeAria"), onClick: onClose }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×"))),
          h("div", { className: "myt-settingsBody" },
            h("div", { className: "myt-settingsLabel" }, tt("settings.language")),
            h("div", { className: "myt-setRow" }, UI_LANGS.map(function (o) {
              return h("button", {
                key: o[0], type: "button", className: "myt-setOpt", "data-active": lang === o[0] ? "true" : undefined,
                onClick: function () { onPickLang(o[0]); },
              }, o[1]);
            })),
            h("div", { className: "myt-settingsHint" }, tt("settings.languageHint")),
            h("div", { className: "myt-settingsLabel" }, tt("settings.fontScale")),
            h("div", { className: "myt-setRow" }, FONT_SCALES.map(function (o) {
              return h("button", {
                key: o[0], type: "button", className: "myt-setOpt", "data-active": scale === o[0] ? "true" : undefined,
                onClick: function () { onPick(o[0]); },
              }, o[1]);
            })),
            h("div", { className: "myt-settingsHint" }, tt("settings.fontScaleHint")))));
    }

    // ── 章节阅读页（整页视图，替代右侧抽屉）：返回按钮 + 章纲对照 + 正文 +
    // 五维 + 状态流转。原抽屉是 position:fixed 侧弹层，在桌面端会被侧边栏
    // 遮挡；整页视图天然在面板文档流内，无遮挡问题。 ──
    function ChapterReader(props) {
      var file = props.file;
      var wsPath = props.wsPath;
      var snap = props.snap;
      var reload = props.reload;
      var onBack = props.onBack;
      var _d = useState(null), detail = _d[0], setDetail = _d[1]; // {loading, data, err}
      var _b = useState(false), flowBusy = _b[0], setFlowBusy = _b[1];
      var detailSeqRef = useRef(0); // chapter 请求序号：快速切章时丢弃过期响应
      var loadDetail = useCallback(function (f) {
        var seq = ++detailSeqRef.current;
        if (!f) { setDetail(null); return; }
        setDetail({ loading: true, data: null, err: "" });
        apiGet("chapter", { path: wsPath, file: f }).then(function (d) {
          if (seq !== detailSeqRef.current) return; // 过期响应：已在看另一章，丢弃
          setDetail({ loading: false, data: d, err: "" });
        }).catch(function (err) {
          if (seq !== detailSeqRef.current) return;
          setDetail({ loading: false, data: null, err: err.message });
        });
      }, [wsPath]);
      useEffect(function () { loadDetail(file); }, [file, loadDetail]);
      var ch = null;
      var chapters = (snap && snap.chapters) || [];
      for (var i = 0; i < chapters.length; i++) { if (chapters[i].file === file) { ch = chapters[i]; break; } }
      function advance() {
        if (!ch) return;
        var idx = STATUS_FLOW.indexOf(ch.status);
        var next = idx !== -1 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
        if (!next || flowBusy) return;
        setFlowBusy(true);
        apiPost("chapter-status", { path: wsPath, file: ch.file, status: next })
          .then(function () { return reload(); })
          .then(function () { return loadDetail(ch.file); })
          .catch(function () {}).finally(function () { setFlowBusy(false); });
      }
      function copyChapterPath() {
        copyText(chapterAbsPath(snap && snap.novelDir, file)).then(function (ok) {
          if (ok) toast.ok(tt("reader.copied"));
          else toast.warn(tt("reader.copyFailed"));
        });
      }
      return h("div", { className: "myt-reader" },
        h("div", { className: "myt-readerBar" },
          h("button", { type: "button", className: "myt-btn", onClick: onBack, title: tt("reader.backTip") },
            ic("IconChevronRightOutlineRegular", 13), tt("reader.back")),
          h("h2", { className: "myt-readerTitle" }, ch ? chFullTitle(ch) : file),
          ch ? statusBadge(ch.status) : null,
          h("div", { className: "myt-readerBarActions" },
            h("button", {
              type: "button", className: "myt-btn myt-copyBtn",
              title: tt("reader.copyPathTip"), "aria-label": tt("reader.copyPathTip"),
              onClick: copyChapterPath,
            }, ic("IconCopyOutlineRegular", 13), tt("reader.copyPath")))),
        h("div", { className: "myt-readerBody" },
          !detail || detail.loading ? h("div", { className: "myt-stack" }, h("div", { className: "myt-skel myt-skelRow" }), h("div", { className: "myt-skel myt-skelRow", style: { width: "80%" } }), h("div", { className: "myt-skel myt-skelRow", style: { width: "64%" } }))
            : detail.err ? h(ErrorStrip, { text: tf("reader.loadFailed", { msg: detail.err }), onRetry: function () { loadDetail(file); } })
              : [
                  (function () {
                    var ol = detail.data && detail.data.outline;
                    return ol ? h(OutlinePanel, { key: "outline", outline: ol })
                      : h("div", { key: "outline-none", className: "myt-outlineEmpty" }, tt("reader.noOutline"));
                  })(),
                  h("pre", { key: "body", className: "myt-chapterBody" }, (detail.data && detail.data.body) || tt("reader.emptyBody")),
                ],
          ch ? h("div", { className: "myt-dimGrid" }, FIVE_DIMS.map(function (dim) {
            return h("div", { key: dim[0], className: "myt-dim" },
              h("div", { className: "myt-dimLabel" }, dim[1]),
              h("div", { className: "myt-dimText" }, orDash(ch[dim[0]])));
          })) : null),
        ch ? h("div", { className: "myt-readerFoot" },
          (function () {
            var idx = STATUS_FLOW.indexOf(ch.status);
            var next = idx !== -1 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
            if (!next) return h("span", { className: "myt-muted" }, tt("reader.finalState"));
            return [h("span", { className: "myt-muted", key: "t" }, tt("reader.statusFlow")),
              h("button", { key: "b", type: "button", className: "myt-btn myt-btnPrimary", disabled: flowBusy, onClick: advance },
                flowBusy ? tt("reader.flowing") : tf("reader.advanceTo", { next: tt("status." + next) }))];
          })()) : null);
    }

    // ── 书稿元信息编辑表单（概览「编辑」按钮展开）：可视化 project.yml 平
    // 键并保存。mode/phase 走枚举下拉，自由文本走输入框；保存走 project-save
    // 路由（服务端校验 + 保注释改写），成功后重拉快照并经 onDone 退出编辑态。
    // 表单初值（与磁盘真值同源）：首次载入与 409 重置共用同一形状。
    function settingsFormOf(project) {
      project = project || {};
      return {
        title: project.title || "", author: project.author || "", genre: project.genre || "",
        length: project.length || "", language: project.language || "zh",
        phase: PHASES.indexOf(project.phase) !== -1 ? project.phase : "idea",
        mode: project.mode || "ai-draft",
        description: project.description || "",
      };
    }
    // 快照 root 与工作区 path 同源但形态可能有差（尾斜杠等），比对前归一。
    function normRoot(s) { return String(s || "").replace(/[\\/]+$/, ""); }
    function ProjectMetaForm(props) {
      var snap = props.snap;
      var wsPath = props.wsPath;
      var reload = props.reload;
      var onDone = props.onDone;
      var project = snap.project || {};
      var _f = useState(function () { return settingsFormOf(project); }), form = _f[0], setForm = _f[1];
      // 保存基线：表单载入时的 project.yml 指纹（snap.project_hash）。服务端
      // 拿它检测表单载入后的外部改动（作者手改 / agent 推进 phase），命中即
      // 409 拒写——没有它，保存会静默覆盖同名键、丢掉人工改动。
      var baseHashRef = useRef(snap && typeof snap.project_hash === "string" ? snap.project_hash : null);
      // 409 后的一次性重置标记：reload 带回新快照时把表单与基线放回磁盘真值。
      // 只在保存失败路径置位——顶栏刷新等其他 reload 不碰正在编辑的表单。
      var pendingResetRef = useRef(false);
      useEffect(function () {
        var hash = snap && typeof snap.project_hash === "string" ? snap.project_hash : null;
        if (pendingResetRef.current) {
          pendingResetRef.current = false;
          setForm(settingsFormOf(snap && snap.project));
          baseHashRef.current = hash;
          return;
        }
        // 空闲跟随：快照确属当前工作区（root 对得上，跨工作区切换的在途旧
        // 快照不认）且表单未被用户动过（与磁盘逐键同值）时，把基线对齐本快照
        // ——本组件不随工作区切换重挂，基线若还攥着旧工作区的 hash，保存必被
        // 自家 409 拦住（假冲突）。用户已编辑则不打扰，外部改动由保存 409 兜底。
        if (!snap || !snap.found || normRoot(snap.root) !== normRoot(wsPath)) return;
        var disk = settingsFormOf(snap.project);
        for (var k in disk) {
          if (String(form[k]) !== String(disk[k])) return;
        }
        baseHashRef.current = hash;
      }, [snap, wsPath]);
      var _b = useState(false), busy = _b[0], setBusy = _b[1];
      var _e = useState(""), saveErr = _e[0], setSaveErr = _e[1];
      function set(k, v) { setForm(Object.assign({}, form, (function () { var o = {}; o[k] = v; return o; })())); }
      function save() {
        if (busy) return;
        if (!String(form.title || "").trim()) { setSaveErr(tt("novel.titleRequired")); return; }
        setBusy(true); setSaveErr("");
        // 成败提示统一走 apiPost 的 toast 通道（这里不再另弹，避免双 toast）；
        // 卡内 saveErr 只承担表单旁的错误态。
        apiPost("project-save", { path: wsPath, values: form, base_hash: baseHashRef.current }).then(function (res) {
          // 写后指纹即下一轮基线：不等 reload 快照就先接住——连续两次保存时
          // 第二次若还回传载入时的旧指纹，会被自家 409 拦住（假冲突）。
          if (res && typeof res.project_hash === "string") baseHashRef.current = res.project_hash;
          return reload();
        }).catch(function (err) {
          setSaveErr(err.message);
          // 409 = project.yml 在表单载入后被外部改过：重拉快照并一次性把表单
          // 放回磁盘真值，别让用户在过期基线上继续盲改。其他失败（网络抖动
          // 等）不动表单，保留正在编辑的内容。
          if (err && err.status === 409) {
            pendingResetRef.current = true;
            reload();
          }
        }).finally(function () { setBusy(false); });
      }
      function field(label, key, placeholder, textarea) {
        var value = form[key] || "";
        return h("label", { className: "myt-setField" },
          h("span", { className: "myt-setFieldLabel" }, label),
          textarea
            ? h("textarea", { className: "myt-setInput myt-setArea", rows: 3, placeholder: placeholder, value: value,
                onChange: function (e) { set(key, e.target.value); } })
            : h("input", { type: "text", className: "myt-setInput", placeholder: placeholder, value: value,
                onChange: function (e) { set(key, e.target.value); } }));
      }
      function picker(label, key, opts) {
        var value = form[key] || "";
        return h("label", { className: "myt-setField" },
          h("span", { className: "myt-setFieldLabel" }, label),
          h("select", { className: "myt-setInput myt-setSelect", value: value, onChange: function (e) { set(key, e.target.value); } },
            opts.map(function (o) { return h("option", { key: o[0], value: o[0] }, o[1]); })));
      }
      function cancel() {
        if (busy) return; // 保存在途不许退出：避免卸载后 setState
        onDone();
      }
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" },
            h("h3", { className: "myt-cardTitle" }, tt("novel.metaTitle")),
            h("span", { className: "myt-muted" }, tt("novel.metaNote"))),
          h("div", { className: "myt-setGrid" },
            field(tt("novel.fTitle"), "title", tt("novel.titlePh")),
            field(tt("novel.fAuthor"), "author", tt("novel.authorPh")),
            field(tt("novel.fGenre"), "genre", tt("novel.genrePh")),
            field(tt("novel.fLength"), "length", tt("novel.lengthPh")),
            picker(tt("novel.fLanguage"), "language", [["zh", "中文"], ["en", "English"], ["ja", "日本語"]]),
            picker(tt("novel.fPhase"), "phase", PHASES.map(function (p) { return [p, tt("phase." + p)]; })),
            picker(tt("novel.fMode"), "mode", [["ai-draft", tt("mode.aiDraft")], ["co-write", tt("mode.coWrite")], ["author-draft", tt("mode.authorDraft")]]),
            field(tt("novel.fDesc"), "description", tt("novel.descPh"), true))),
        saveErr ? h(ErrorStrip, { text: saveErr }) : null,
        h("div", { className: "myt-setActions" },
          h("button", { type: "button", className: "myt-btn", disabled: busy, onClick: cancel },
            tt("novel.cancel")),
          h("button", { type: "button", className: "myt-btn myt-btnPrimary", disabled: busy, onClick: save },
            busy ? tt("novel.saving") : tt("novel.save"))));
    }

    // ── 章节 tab：状态筛选 pills + 表格 + 行抽屉（只读正文 + 五维 + 流转）────
    var FIVE_DIMS = [
      ["cognitive_frame", tt("dim.cognitiveFrame")], ["emotional_anchor", tt("dim.emotionalAnchor")], ["world_texture", tt("dim.worldTexture")],
      ["suspense", tt("dim.suspense")], ["interpersonal_tension", tt("dim.interpersonalTension")],
    ];
    // 章纲对照栏（五期）：outline 非空时渲染可折叠原文（默认展开，只读，样式
    // 与正文区分）；共享常量避免重渲染时折叠态意外重置——组件随抽屉挂载，
    // 切章即重挂回默认展开。
    function OutlinePanel(props) {
      var outline = props.outline;
      var _op = useState(true), open = _op[0], setOpen = _op[1];
      var body = outline && typeof outline.body === "string" && outline.body.trim() !== "" ? outline.body : tt("outline.empty");
      return h("div", { className: "myt-outlinePanel" },
        h("button", {
          type: "button", className: "myt-outlineHead",
          "aria-expanded": open ? "true" : "false",
          title: open ? tt("outline.collapseTip") : tt("outline.expandTip"),
          onClick: function () { setOpen(!open); },
        },
          h("span", { className: "myt-outlineTitle" }, tt("outline.title")),
          typeof (outline && outline.words) === "number" ? h("span", { className: "myt-outlineWords" }, tf("common.charCount", { n: fmtNum(outline.words) })) : null,
          h("span", { className: "myt-outlineChevron", "aria-hidden": "true" },
            ic(open ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", 14))),
        open ? h(MdView, { text: body, className: "myt-outlineBody" }) : null);
    }
    // 抽屉/弹层专用 Portal：面板容器挂在宿主会话中栏里，中栏的 transform/
    // overflow 会把 position:fixed 劫持成相对自身并连同裁剪——抽屉渲染了也
    // 看不见（桌面端「点了没反应」实测病灶）。挂 document.body 后 fixed 恒
    // 等于视口、z-index 直接对齐文档层。老宿主无 createPortal 退回原地渲染。
    function MaskPortal(props) {
      var node = h("div", props);
      if (ReactDOMClient && typeof ReactDOMClient.createPortal === "function" && typeof document !== "undefined" && document.body) {
        return ReactDOMClient.createPortal(node, document.body);
      }
      return node;
    }

    // ── 章纲全文弹层（0.1.15）：按单写作的孤儿章纲行点击展开——GET outline
    // 路由取全文，MdView 渲染，words 一并显示；加载中/失败给简单文案，失败
    // 态可重试。请求序号防快速开关弹层时的过期响应（对照 ChapterReader）。──
    function OutlineModal(props) {
      var wsPath = props.wsPath;
      var file = props.file;
      var onClose = props.onClose;
      var _d = useState(null), detail = _d[0], setDetail = _d[1]; // {loading, data, err}
      var seqRef = useRef(0);
      var load = useCallback(function (f) {
        var seq = ++seqRef.current;
        if (!f) { setDetail(null); return; }
        setDetail({ loading: true, data: null, err: "" });
        apiGet("outline", { path: wsPath, file: f }).then(function (d) {
          if (seq !== seqRef.current) return; // 过期响应：弹层已换文件/关闭，丢弃
          setDetail({ loading: false, data: d, err: "" });
        }).catch(function (err) {
          if (seq !== seqRef.current) return;
          setDetail({ loading: false, data: null, err: err.message });
        });
      }, [wsPath]);
      useEffect(function () { load(file); }, [file, load]);
      var words = detail && detail.data && typeof detail.data.words === "number" ? detail.data.words : null;
      return h(MaskPortal, {
        className: "myt-modalMask",
        onMouseDown: function (e) { if (e.target === e.currentTarget) onClose(); },
      },
        h("div", { className: "myt-modalCard", role: "dialog", "aria-modal": "true", "aria-label": tt("outline.modalAria") },
          h("div", { className: "myt-modalHead" },
            h("h2", { className: "myt-modalTitle" }, props.title || file),
            h("div", { className: "myt-heroMeta" },
              words !== null ? h("span", { className: "myt-outlineWords" }, tf("common.charCount", { n: fmtNum(words) })) : null,
              h("button", { type: "button", className: "myt-closeBtn", "aria-label": tt("outline.closeAria"), onClick: onClose }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
          h("div", { className: "myt-modalBody" },
            !detail || detail.loading ? h("div", { className: "myt-muted" }, tt("outline.loading"))
              : detail.err ? h(ErrorStrip, { text: tf("outline.loadFailed", { msg: detail.err }), onRetry: function () { load(file); } })
                : h(MdView, { text: (detail.data && detail.data.body) || tt("outline.empty"), className: "myt-outlineBody" }))));
    }

    function ChaptersTab(props) {
      var snap = props.snap;
      var wsPath = props.wsPath;
      var reload = props.reload;
      var onOpen = props.onOpenChapter; // 行点击 → 整页阅读（PageShell.readerFile）
      var _f = useState("all"), filter = _f[0], setFilter = _f[1];
      var chapters = snap.chapters || [];
      var rows = filter === "all" ? chapters : chapters.filter(function (c) { return c.status === filter; });
      var counts = snap.totals && snap.totals.byStatus ? snap.totals.byStatus : {};
      // 「按单写作」（五期）：state.outlines 与 chapters 联交——有章纲且
      // status=pending 的章，按章纲（卷-章号）序列出，共创模式的主工作清单。
      // 孤儿章纲（chapter 无对应章节文件）照列（0.1.15）：章纲先于正文是共
      // 创常态，未建章行挂「未建章」徽章，行点击看章纲全文、卡上「建章」一
      // 键落 pending 空章（建后走既有 pending 流转）。outlines 快照已按卷-章
      // 号升序，孤儿行与待写章直接保序混排。
      var outlines = snap.outlines || [];
      var chapterByFile = {};
      chapters.forEach(function (c) { chapterByFile[c.file] = c; });
      var writeOrder = [];
      outlines.forEach(function (ol) {
        var ch = ol && ol.chapter ? chapterByFile[ol.chapter] : null;
        if (ch && (ch.status || "pending") === "pending") writeOrder.push({ ch: ch, ol: ol });
        else if (!ch) writeOrder.push({ ol: ol }); // 孤儿章纲：正文未建也入清单
      });
      // 章纲全文弹层：outline 文件名，null 不渲染；建章 in-flight 的文件名。
      var _mo = useState(null), outlineModalFile = _mo[0], setOutlineModalFile = _mo[1];
      var _busy = useState(null), creatingFile = _busy[0], setCreatingFile = _busy[1];
      function createFromOutline(ol, e) {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation(); // 别触发行的弹层
        if (!ol || !ol.file || creatingFile) return;
        setCreatingFile(ol.file);
        // 成败提示走 apiPost 的 toast 通道；成功后重拉快照——新章节进表格、
        // 孤儿行按快照最新联交结果自然消失（与 chapter-status 流转同一模式）。
        apiPost("chapter-create", { path: wsPath, file: ol.file })
          .then(function () { return reload(); })
          .catch(function () {})
          .finally(function () { setCreatingFile(null); });
      }
      return h("div", { className: "myt-stack" },
        writeOrder.length ? h("div", { className: "myt-card myt-writeOrder" },
          h("div", { className: "myt-cardHead" },
            h("h3", { className: "myt-cardTitle" }, tt("chapters.writeQueue")),
            h("span", { className: "myt-boardCount" }, writeOrder.length)),
          h("div", { className: "myt-writeOrderList" }, writeOrder.map(function (item) {
            var ch = item.ch;
            var ol = item.ol;
            if (!ch) {
              // 孤儿章纲行：div 承担行点击（button 里不能再嵌 button），键盘
              // Enter/Space 与 role/tabIndex 补齐可达性。
              var busy = creatingFile === ol.file;
              return h("div", {
                key: "ol:" + ol.file, className: "myt-writeOrderRow", role: "button", tabIndex: 0,
                title: tt("chapters.outlineRowTip"),
                onClick: function () { setOutlineModalFile(ol.file); },
                onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOutlineModalFile(ol.file); } },
              },
                h("span", { className: "myt-chPath" }, olWhere(ol) || ol.file),
                h("span", { className: "myt-noChapterBadge", title: tt("chapters.createTip") }, tt("chapters.noChapter")),
                ol && typeof ol.excerpt === "string" && ol.excerpt !== ""
                  ? h("span", { className: "myt-writeOrderExcerpt", title: ol.excerpt }, truncate(ol.excerpt, 60)) : null,
                ol && ol.words ? h("span", { className: "myt-wordsCell" }, tf("chapters.outlineWords", { n: fmtNum(ol.words) })) : null,
                h("button", {
                  type: "button", className: "myt-btn", disabled: creatingFile !== null,
                  title: tt("chapters.createTip"),
                  onClick: function (e) { createFromOutline(ol, e); },
                }, busy ? tt("chapters.creating") : tt("chapters.createBtn")));
            }
            return h("button", {
              key: ch.file, type: "button", className: "myt-writeOrderRow",
              title: tt("chapters.rowTip"),
              onClick: function () { onOpen(ch.file); },
            },
              h("span", { className: "myt-chPath" }, chWhere(ch) || ch.file),
              h("span", { className: "myt-chTitle" }, orDash(ch.title)),
              statusBadge(ch.status),
              ol && typeof ol.excerpt === "string" && ol.excerpt !== ""
                ? h("span", { className: "myt-writeOrderExcerpt", title: ol.excerpt }, truncate(ol.excerpt, 60)) : null,
              ol && ol.words ? h("span", { className: "myt-wordsCell" }, tf("chapters.outlineWords", { n: fmtNum(ol.words) })) : null);
          }))) : null,
        h("div", { className: "myt-filterRow" },
          [{ k: "all", label: tt("chapters.all"), n: chapters.length }].concat(STATUS_FLOW.map(function (s) {
            return { k: s, label: tt("status." + s), n: counts[s] || 0 };
          })).map(function (f) {
            return h("button", {
              key: f.k, type: "button", className: "myt-filterPill",
              "data-active": filter === f.k ? "true" : undefined,
              onClick: function () { setFilter(f.k); },
            }, f.label + " " + f.n);
          })),
        rows.length ? h("div", { className: "myt-tableWrap" },
          h("table", { className: "myt-table" },
            h("thead", null, h("tr", null,
              h("th", null, tt("chapters.thVolume")), h("th", null, tt("chapters.thTitle")), h("th", null, tt("chapters.thStatus")), h("th", null, tt("chapters.thWords")), h("th", null, tt("chapters.thSummary")))),
            h("tbody", null, rows.map(function (ch) {
              return h("tr", { key: ch.file, onClick: function () { onOpen(ch.file); }, title: tt("chapters.rowReadTip") },
                h("td", null, h("span", { className: "myt-chPath" }, chWhere(ch) || "—")),
                h("td", null, h("span", { className: "myt-chTitle" }, orDash(ch.title))),
                h("td", null, statusBadge(ch.status)),
                h("td", null, h("span", { className: "myt-wordsCell" }, fmtNum(ch.words))),
                h("td", null, h("div", { className: "myt-summaryCell myt-muted" }, orDash(ch.summary))));
            }))))
          : (chapters.length ? h(Empty, { text: tt("chapters.emptyFiltered") }) : h(Empty, { text: outlines.length ? tt("chapters.emptyWithOutlines") : tt("chapters.empty") })),
        outlineModalFile ? h(OutlineModal, {
          wsPath: wsPath,
          file: outlineModalFile,
          // 弹层标题用「卷-章」定位（对照 olWhere 显示格式），解析不了退文件名
          title: (function () {
            for (var i = 0; i < outlines.length; i++) { if (outlines[i].file === outlineModalFile) return olWhere(outlines[i]) || outlines[i].file; }
            return outlineModalFile;
          })(),
          onClose: function () { setOutlineModalFile(null); },
        }) : null);
    }

    // ── 角色 tab：卡墙 + 全卡弹层 ───────────────────────────────────────────
    var CHAR_FULL_ROWS = [
      ["age", tt("char.field.age")], ["gender", tt("char.field.gender")], ["appearance", tt("char.field.appearance")], ["personality", tt("char.field.personality")],
      ["background", tt("char.field.background")], ["motivation", tt("char.field.motivation")], ["arc", tt("char.field.arc")],
    ];
    function CharactersTab(props) {
      var characters = props.snap.characters || [];
      var _m = useState(null), modalFile = _m[0], setModalFile = _m[1];
      var modal = null;
      for (var i = 0; i < characters.length; i++) { if (characters[i].file === modalFile) { modal = characters[i]; break; } }
      return h("div", { className: "myt-stack" },
        characters.length ? h("div", { className: "myt-charWall" }, characters.map(function (c) {
          return h("button", { key: c.file, type: "button", className: "myt-card myt-charCard", onClick: function () { setModalFile(c.file); } },
            h("div", { className: "myt-charHead" },
              h("span", { className: "myt-charName" }, orDash(c.name)),
              roleBadge(c.role)),
            h("div", { className: "myt-charMeta" },
              [c.age !== null && c.age !== undefined ? tf("char.years", { n: c.age }) : null, c.gender || null].filter(Boolean).join(" · ") || "—"),
            c.personality ? h("div", { className: "myt-charLine" }, h("span", { className: "myt-charLabel" }, tt("char.linePersonality")), truncate(c.personality, 60)) : null,
            c.motivation ? h("div", { className: "myt-charLine" }, h("span", { className: "myt-charLabel" }, tt("char.lineMotivation")), truncate(c.motivation, 60)) : null);
        })) : h(Empty, { text: tt("char.empty") }),
        modal ? h(MaskPortal, {
          className: "myt-modalMask",
          onMouseDown: function (e) { if (e.target === e.currentTarget) setModalFile(null); },
        },
          h("div", { className: "myt-modalCard", role: "dialog", "aria-modal": "true", "aria-label": tt("char.modalAria") },
            h("div", { className: "myt-modalHead" },
              h("h2", { className: "myt-modalTitle" }, orDash(modal.name)),
              h("div", { className: "myt-heroMeta" },
                roleBadge(modal.role),
                h("button", { type: "button", className: "myt-closeBtn", "aria-label": tt("char.closeAria"), onClick: function () { setModalFile(null); } }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
            h("div", { className: "myt-modalBody" },
              CHAR_FULL_ROWS.map(function (row) {
                return h("div", { key: row[0], className: "myt-kvRow" },
                  h("span", { className: "myt-kvKey" }, row[1]),
                  h("span", { className: "myt-kvVal" }, orDash(modal[row[0]])));
              }),
              h("div", { className: "myt-kvRow" },
                h("span", { className: "myt-kvKey" }, tt("char.markers")),
                h("span", { className: "myt-kvVal myt-tagRow" },
                  (modal.markers || []).length
                    ? modal.markers.map(function (m, i) { return h("span", { key: i, className: "myt-markerTag" }, m); })
                    : "—")),
              h("div", { className: "myt-kvRow" },
                h("span", { className: "myt-kvKey" }, tt("char.file")),
                h("span", { className: "myt-kvVal" }, modal.file || "—"))))) : null);
    }

    // ── 伏笔 tab：四列看板（列头计数 + 推进按钮 + priority 色点）────────────
    function ForeshadowsTab(props) {
      var snap = props.snap;
      var reload = props.reload;
      var wsPath = props.wsPath;
      var _b = useState(null), busyId = _b[0], setBusyId = _b[1]; // 在途伏笔 id
      function setStatus(fs, status) {
        if (busyId) return;
        setBusyId(fs.id);
        apiPost("foreshadow-status", { path: wsPath, id: fs.id, status: status })
          .then(reload).catch(function () {}).finally(function () { setBusyId(null); });
      }
      var list = snap.foreshadows || [];
      return h("div", { className: "myt-stack" },
        list.length ? h("div", { className: "myt-board" }, FS_ORDER.map(function (col) {
          var items = list.filter(function (f) { return (f.status || "planted") === col; });
          return h("div", { key: col, className: "myt-boardCol" },
            h("div", { className: "myt-boardHead" },
              h("span", { className: "myt-boardTitle" }, tt("foreshadow." + col)),
              h("span", { className: "myt-boardCount" }, items.length)),
            items.map(function (fs) {
              var next = FS_FLOW[col] || null;
              var busy = busyId === fs.id;
              // status 行缺失（服务端要求每条恰一处 status，写必 409）：禁用流
              // 转/弃用按钮，降级为只读展示并给提示，避免「可点但必失败」。
              var noStatus = !fs.status;
              var noWrite = !fs.id || noStatus;
              var noWriteTip = !fs.id
                ? tt("foreshadow.noIdTip")
                : tt("foreshadow.noStatusTip");
              var chRange = [fs.planted_chapter || tt("foreshadow.plantedUnmarked"), fs.expected_resolve].filter(Boolean).join(" → ");
              return h("div", { key: fs.id || fs.title, className: "myt-fsCard" },
                h("div", { className: "myt-fsTitle" },
                  priDot(fs.priority), h("span", null, orDash(fs.title) || orDash(fs.id)),
                  // 回填徽章（五期账本回填）：区别于写前规划条目，悬浮见来源。
                  fs.source === "backfill" ? h("span", { className: "myt-backfillBadge", title: tt("foreshadow.backfillTip") }, tt("foreshadow.backfill")) : null,
                  noStatus ? h("span", { className: "myt-fsNoStatus", title: noWriteTip }, tt("foreshadow.missingStatus")) : null),
                h("div", { className: "myt-fsMeta" },
                  h("span", null, col === "resolved" && fs.resolved_chapter ? tf("foreshadow.resolvedAt", { ch: fs.resolved_chapter }) : chRange),
                  fs.priority && fs.priority !== "normal" ? h("span", null, tf("foreshadow.priorityLabel", { pri: ["high", "low", "normal"].indexOf(fs.priority) !== -1 ? tt("pri." + fs.priority) : fs.priority })) : null),
                fs.notes ? h("div", { className: "myt-fsNotes", title: fs.notes }, fs.notes) : null,
                h("div", { className: "myt-fsActions" },
                  next ? h("button", { type: "button", className: "myt-btn", disabled: busy || noWrite, title: noWriteTip, onClick: function () { setStatus(fs, next); } }, busy ? tt("foreshadow.advancing") : (col === "planted" ? tt("foreshadow.advance") : tt("foreshadow.resolve"))) : null,
                  col !== "resolved" && col !== "abandoned"
                    ? h("button", { type: "button", className: "myt-btn myt-btnDanger", disabled: busy || noWrite, title: noWriteTip, onClick: function () { setStatus(fs, "abandoned"); } }, tt("foreshadow.abandon")) : null));
            }),
            items.length ? null : h("div", { className: "myt-muted" }, tt("foreshadow.colEmpty")));
        })) : h(Empty, { text: tt("foreshadow.empty") }));
    }

    // ── 时间线 tab：垂直轴 + importance 点位（1-5 → 大小/深浅）──────────────
    function TimelineTab(props) {
      var items = (props.snap.timeline || []).slice();
      if (items.length) {
        items.sort(function (a, b) { return String(a.year || "").localeCompare(String(b.year || ""), "zh-CN", { numeric: true }); });
      }
      if (!items.length) return h(Empty, { text: tt("timeline.empty") });
      return h("div", { className: "myt-card" },
        h("div", { className: "myt-timeline" }, items.map(function (t, i) {
          var imp = Math.min(5, Math.max(1, typeof t.importance === "number" ? t.importance : 3));
          return h("div", { key: i, className: "myt-tlRow" },
            h("div", { className: "myt-tlYear" }, orDash(t.year)),
            h("div", { className: "myt-tlAxis" }, h("span", { className: "myt-tlDot", "data-imp": String(imp), title: tf("timeline.importance", { n: imp }) })),
            h("div", { className: "myt-tlCard" },
              h("div", { className: "myt-tlTitle" }, orDash(t.title)),
              t.description ? h("div", { className: "myt-tlDesc" }, t.description) : null,
              t.chapter ? h("div", { className: "myt-tlChapter" }, tf("timeline.linkedChapter", { ch: t.chapter })) : null));
        })));
    }

    // ── 设定 tab：world 按 category 分组 + science 三色标签 ─────────────────
    function WorldTab(props) {
      var snap = props.snap;
      var world = snap.world || [];
      var science = snap.science || [];
      var research = snap.research || [];
      // 无原型容器：key 来自数据文件的自由文本（category），值为
      // constructor/__proto__/toString 等时若用普通 {} 会命中 Object.prototype
      // 真值 → TypeError → 整面板白屏；Object.create(null) 杜绝。
      var groups = Object.create(null);
      world.forEach(function (w) {
        var key = w.category || tt("common.uncategorized");
        if (!groups[key]) groups[key] = [];
        groups[key].push(w);
      });
      var groupKeys = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("world.title"))),
          groupKeys.length ? h("div", { className: "myt-stack" }, groupKeys.map(function (key) {
            return h("div", { key: key, className: "myt-worldGroup" },
              h("div", { className: "myt-listHead" }, key, h("span", { className: "myt-boardCount" }, groups[key].length)),
              groups[key].map(function (w, i) {
                return h("div", { key: w.file || i, className: "myt-worldItem" },
                  h("div", { className: "myt-worldHead" },
                    h("span", { className: "myt-worldName" }, orDash(w.name)),
                    (w.tags || []).length ? h("span", { className: "myt-tagRow" }, w.tags.map(function (t, j) { return h("span", { key: j, className: "myt-tag" }, t); })) : null),
                  w.description ? h(MdView, { text: w.description, className: "myt-worldDesc" }) : null);
              }));
          })) : h(Empty, { text: tt("world.empty") })),
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("world.science")),
            h("span", { className: "myt-boardCount" }, science.length)),
          science.length ? h("div", { className: "myt-stack" }, science.map(function (s, i) {
            var label = ["known", "extrapolation", "hypothesis"].indexOf(s.label) !== -1 ? s.label : null;
            return h("div", { key: s.file || i, className: "myt-worldItem" },
              h("div", { className: "myt-worldHead" },
                h("span", { className: "myt-worldName" }, orDash(s.name)),
                h("span", { className: "myt-badge myt-sciTag", "data-label": label || "hypothesis", title: s.label && !label ? s.label : undefined },
                  label ? tt("sci." + label) : (s.label || tt("world.unlabeled")))),
              s.description ? h(MdView, { text: s.description, className: "myt-worldDesc" }) : null,
              (s.references || []).length ? h("div", { className: "myt-refList" },
                s.references.map(function (r, j) { return h("span", { key: j, className: "myt-refItem" }, tf("world.ref", { n: j + 1, r: r })); })) : null);
          })) : h(Empty, { text: tt("world.scienceEmpty") })),
        research.length ? h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("world.research")),
            h("span", { className: "myt-boardCount" }, research.length)),
          h("div", { className: "myt-stack" }, research.map(function (r, i) {
            return h("div", { key: r.file || i, className: "myt-worldGroup" },
              h("div", { className: "myt-listHead" },
                h("span", { className: "myt-worldName", title: r.file || "" }, orDash(r.topic) || r.file)),
              r.description ? h(MdView, { text: r.description, className: "myt-worldDesc" }) : null,
              (r.sources || []).length ? h("div", { className: "myt-refList" },
                r.sources.map(function (s, j) { return h("span", { key: j, className: "myt-refItem", title: s }, tf("world.ref", { n: j + 1, r: s })); })) : null);
          }))) : null);
    }

    // ── 索引板 tab：clues 按 kind 分组（resolved 划线）+ memories 按 category
    // 分组（promise 类高亮）；头部「重建索引」POST rebuild-index 后重拉。───
    function IndexTab(props) {
      var snap = props.snap;
      var reload = props.reload;
      var wsPath = props.wsPath;
      var _b = useState(false), rebuildBusy = _b[0], setRebuildBusy = _b[1];
      function rebuild() {
        if (rebuildBusy) return;
        setRebuildBusy(true);
        apiPost("rebuild-index", { path: wsPath }).then(reload).catch(function () {}).finally(function () { setRebuildBusy(false); });
      }
      var clues = snap.clues || [];
      var memories = snap.memories || [];
      // 无原型容器：kind/category 是数据文件自由文本，见 WorldTab 处说明。
      var clueGroups = Object.create(null);
      clues.forEach(function (c) {
        var key = c.kind || tt("common.uncategorized");
        if (!clueGroups[key]) clueGroups[key] = [];
        clueGroups[key].push(c);
      });
      var memGroups = Object.create(null);
      memories.forEach(function (m) {
        var key = m.category || tt("common.uncategorized");
        if (!memGroups[key]) memGroups[key] = [];
        memGroups[key].push(m);
      });
      function groupKey(a, b) { return a.localeCompare(b, "zh-CN"); }
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-cardHead" },
          h("h3", { className: "myt-cardTitle" }, tt("index.title")),
          h("button", { type: "button", className: "myt-btn", disabled: rebuildBusy, onClick: rebuild, title: tt("index.rebuildTip") },
            rebuildBusy ? tt("index.rebuilding") : tt("index.rebuild"))),
        h("div", { className: "myt-indexCols" },
          h("div", { className: "myt-card" },
            h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("index.clueBoard")), h("span", { className: "myt-boardCount" }, clues.length)),
            clues.length ? Object.keys(clueGroups).sort(groupKey).map(function (kind) {
              var ck = CLUE_KIND_KEYS[kind];
              var label = ck ? tt("clue." + ck) : kind;
              return h("div", { key: kind, className: "myt-worldGroup" },
                h("div", { className: "myt-listHead" }, label, h("span", { className: "myt-boardCount" }, clueGroups[kind].length)),
                clueGroups[kind].map(function (c, i) {
                  return h("div", { key: i, className: "myt-clueItem", "data-resolved": c.resolved ? "true" : undefined },
                    h("span", { className: "myt-clueText" }, orDash(c.content)),
                    c.related_chapter ? h("span", { className: "myt-clueChapter" }, c.related_chapter) : null);
                }));
            }) : h(Empty, { text: tt("index.clueEmpty") })),
          h("div", { className: "myt-card" },
            h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("index.memBoard")), h("span", { className: "myt-boardCount" }, memories.length)),
            memories.length ? Object.keys(memGroups).sort(groupKey).map(function (cat) {
              var isPromise = /promise|承诺/i.test(cat);
              return h("div", { key: cat, className: "myt-worldGroup" },
                h("div", { className: "myt-listHead" },
                  cat, isPromise ? h("span", { className: "myt-markerTag" }, tt("index.promise")) : null,
                  h("span", { className: "myt-boardCount" }, memGroups[cat].length)),
                memGroups[cat].map(function (m, i) {
                  return h("div", { key: i, className: "myt-memItem", "data-promise": isPromise ? "true" : undefined },
                    h("span", { className: "myt-clueText" }, orDash(m.content)),
                    m.source_chapter ? h("span", { className: "myt-memChapter" }, m.source_chapter) : null);
                }));
            }) : h(Empty, { text: tt("index.memEmpty") }))));
    }

    // ── 关系图 tab：canvas 力导向（斥力 + 弹簧 + 中心引力，rAF 循环）─────────
    // 节点固定 18px、名字 label 下方；边宽 = intensity 1-5 → 1-4px（缺省 3），
    // type 标在边中点、hover 显示 description；拖拽固定、滚轮缩放、双击复位；
    // 角色多于 30 个时只画 relations 相关节点，其余进「未入图」。
    function edgeWidth(intensity) {
      var n = typeof intensity === "number" && isFinite(intensity) ? Math.round(intensity) : 3;
      n = Math.min(5, Math.max(1, n));
      return 1 + ((n - 1) * 3) / 4; // 1..4px
    }
    function RelationsTab(props) {
      var snap = props.snap;
      var chars = snap.characters || [];
      var rels = (snap.relations || []).filter(function (r) { return r && r.a && r.b && r.a !== r.b; });
      var _tip = useState(null), tip = _tip[0], setTip = _tip[1]; // {x, y, text}
      var wrapRef = useRef(null);
      var canvasRef = useRef(null);
      var tipRafRef = useRef(0); // hover 提示 rAF 句柄：卸载/换图时取消在途合帧
      // 数据准备：>30 角色只留 relations 相关节点；角色空时退化为关系端点名。
      // useMemo 缓存：hover 提示等重渲染不再重复建图（原渲染体内 IIFE 每帧重建）。
      // 容器用无原型对象：角色名/关系端点是数据文件自由文本，见 WorldTab 处说明。
      var graph = useMemo(function () {
        var byName = Object.create(null);
        chars.forEach(function (c) { if (c && c.name && !byName[c.name]) byName[c.name] = c; });
        var deg = Object.create(null);
        rels.forEach(function (r) { deg[r.a] = (deg[r.a] || 0) + 1; deg[r.b] = (deg[r.b] || 0) + 1; });
        var names = chars.length ? chars.map(function (c) { return c.name; }) : Object.keys(deg);
        var linked = names.filter(function (n) { return deg[n]; });
        var drawNames = names.length > 30 ? linked : names;
        var unlinked = names.filter(function (n) { return drawNames.indexOf(n) === -1; });
        var nodes = drawNames.map(function (n) { return { id: n, role: byName[n] ? byName[n].role : null, x: 0, y: 0, vx: 0, vy: 0, fixed: false }; });
        var idx = Object.create(null);
        nodes.forEach(function (nd, i) { idx[nd.id] = i; });
        var edges = rels.filter(function (r) { return idx[r.a] !== undefined && idx[r.b] !== undefined; })
          .map(function (r) { return { a: idx[r.a], b: idx[r.b], type: r.type || "", desc: r.description || "", w: edgeWidth(r.intensity) }; });
        return { nodes: nodes, edges: edges, unlinked: unlinked };
      }, [snap]); // chars/rels 均由 snap 派生，snap 不变则图不变
      useEffect(function () {
        var wrap = wrapRef.current;
        var canvas = canvasRef.current;
        if (!wrap || !canvas || !graph.nodes.length) return undefined;
        var ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        var dpr = (window.devicePixelRatio || 1) > 0 ? window.devicePixelRatio || 1 : 1;
        var sim = { zoom: 1, drag: null, raf: 0, frame: 0, w: 0, h: 0, tokens: null };
        // 令牌缓存：每 30 帧重读 computed style，浅/深色切换约半秒内跟上。
        function readTokens() {
          var cs = getComputedStyle(document.body);
          function tok(name, fallback) { return String(cs.getPropertyValue(name) || "").trim() || fallback; }
          return {
            accent: tok("--dsw-alias-state-business-primary", "#4c7dff"),
            label: tok("--dsw-alias-label-primary", "#333"),
            faint: tok("--dsw-alias-label-tertiary", "#999"),
            line: tok("--dsw-alias-border-l4", tok("--dsw-alias-label-tertiary", "#bbb")),
            card: tok("--dsw-alias-bg-layer-2", "#fff"),
          };
        }
        function resize() {
          sim.w = wrap.clientWidth || 640;
          sim.h = wrap.clientHeight || 480;
          canvas.width = Math.max(1, Math.round(sim.w * dpr));
          canvas.height = Math.max(1, Math.round(sim.h * dpr));
        }
        // 初始摆在同心圆上，交给力导向收敛。
        var R = Math.max(90, Math.min(sim.w, sim.h) / 3);
        graph.nodes.forEach(function (nd, i) {
          var ang = (i / graph.nodes.length) * Math.PI * 2;
          nd.x = Math.cos(ang) * R;
          nd.y = Math.sin(ang) * R;
          nd.vx = nd.vy = 0;
        });
        function toWorld(sx, sy) { return { x: (sx - sim.w / 2) / sim.zoom, y: (sy - sim.h / 2) / sim.zoom }; }
        function toScreen(x, y) { return { x: sim.w / 2 + x * sim.zoom, y: sim.h / 2 + y * sim.zoom }; }
        function hitNode(sx, sy) {
          var p = toWorld(sx, sy);
          for (var i = graph.nodes.length - 1; i >= 0; i--) {
            var nd = graph.nodes[i];
            var dx = p.x - nd.x, dy = p.y - nd.y;
            if (dx * dx + dy * dy <= 18 * 18) return nd;
          }
          return null;
        }
        function hitEdge(sx, sy) {
          var p = toWorld(sx, sy);
          var best = null, bestD = 10;
          graph.edges.forEach(function (e) {
            var a = graph.nodes[e.a], b = graph.nodes[e.b];
            var ax = a.x, ay = a.y, bx = b.x - a.x, by = b.y - a.y;
            var len2 = bx * bx + by * by || 1;
            var t = Math.min(1, Math.max(0, ((p.x - ax) * bx + (p.y - ay) * by) / len2));
            var dx = p.x - (ax + bx * t), dy = p.y - (ay + by * t);
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) { bestD = d; best = e; }
          });
          return best;
        }
        function step() {
          var nodes = graph.nodes, edges = graph.edges, n = nodes.length;
          for (var i = 0; i < n; i++) {
            for (var j = i + 1; j < n; j++) {
              var a = nodes[i], b = nodes[j];
              var dx = a.x - b.x, dy = a.y - b.y;
              var d2 = dx * dx + dy * dy;
              if (d2 < 1) { dx = (i % 2 ? 1 : -1) * 0.5; dy = (j % 2 ? 1 : -1) * 0.5; d2 = 1; }
              var f = Math.min(2400 / d2, 4); // 斥力，封顶防炸
              var d = Math.sqrt(d2);
              var fx = (dx / d) * f, fy = (dy / d) * f;
              a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
            }
          }
          edges.forEach(function (e) {
            var a = nodes[e.a], b = nodes[e.b];
            var dx = b.x - a.x, dy = b.y - a.y;
            var d = Math.sqrt(dx * dx + dy * dy) || 1;
            var f = (d - 120) * 0.02; // 弹簧，rest 120
            var fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          });
          nodes.forEach(function (nd) {
            nd.vx -= nd.x * 0.01; nd.vy -= nd.y * 0.01; // 中心引力
            if (nd === (sim.drag && sim.drag.node)) { nd.vx = nd.vy = 0; return; }
            if (nd.fixed) { nd.vx = nd.vy = 0; return; }
            nd.vx *= 0.85; nd.vy *= 0.85;
            nd.x += Math.max(-8, Math.min(8, nd.vx));
            nd.y += Math.max(-8, Math.min(8, nd.vy));
          });
        }
        function draw() {
          if (sim.frame % 30 === 0 || !sim.tokens) sim.tokens = readTokens();
          var tk = sim.tokens;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, sim.w, sim.h);
          ctx.save();
          ctx.translate(sim.w / 2, sim.h / 2);
          ctx.scale(sim.zoom, sim.zoom);
          graph.edges.forEach(function (e) {
            var a = graph.nodes[e.a], b = graph.nodes[e.b];
            ctx.strokeStyle = tk.line;
            ctx.globalAlpha = 0.8;
            ctx.lineWidth = e.w;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            if (e.type && sim.zoom >= 0.7) {
              ctx.globalAlpha = 1;
              ctx.fillStyle = tk.faint;
              ctx.font = "10px sans-serif";
              ctx.textAlign = "center";
              ctx.fillText(e.type, (a.x + b.x) / 2, (a.y + b.y) / 2 - 3);
            }
          });
          ctx.globalAlpha = 1;
          graph.nodes.forEach(function (nd) {
            var s = toScreen(nd.x, nd.y);
            var r = 18; // 世界坐标画：半径随 zoom 缩放
            ctx.beginPath();
            ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
            ctx.fillStyle = nd.fixed ? tk.accent : tk.card;
            ctx.globalAlpha = nd.fixed ? 0.25 : 1;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = tk.accent;
            ctx.stroke();
            ctx.fillStyle = tk.label;
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(nd.id, nd.x, nd.y + r + 13);
          });
          ctx.restore();
        }
        function loop() {
          step();
          draw();
          sim.frame++;
          sim.raf = requestAnimationFrame(loop);
        }
        resize();
        sim.raf = requestAnimationFrame(loop);
        var ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
        if (ro) ro.observe(wrap);
        function localXY(e) {
          var rect = canvas.getBoundingClientRect();
          return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }
        function onDown(e) {
          var p = localXY(e);
          var nd = hitNode(p.x, p.y);
          if (nd) {
            sim.drag = { node: nd };
            nd.fixed = true; // 拖拽固定
            canvas.dataset.dragging = "true";
            e.preventDefault();
          }
        }
        function onMove(e) {
          var p = localXY(e);
          if (sim.drag) {
            var w = toWorld(p.x, p.y);
            sim.drag.node.x = w.x; sim.drag.node.y = w.y;
            return;
          }
          // hover 提示 rAF 节流：mousemove 高频触发，合帧后再命中检测 + setTip，
          // 避免逐事件整 tab 重渲染（建图已 useMemo，这里再省掉无效重绘）。
          if (tipRafRef.current) cancelAnimationFrame(tipRafRef.current);
          tipRafRef.current = requestAnimationFrame(function () {
            tipRafRef.current = 0;
            var e2 = hitEdge(p.x, p.y);
            if (e2) {
              setTip({ x: p.x, y: p.y, text: (e2.type ? e2.type + "：" : "") + (e2.desc || tt("relations.noDesc")) });
            } else {
              setTip(function (prev) { return prev ? null : prev; });
            }
          });
        }
        function onUp() { sim.drag = null; canvas.dataset.dragging = "false"; }
        function onWheel(e) {
          e.preventDefault();
          var next = sim.zoom * Math.exp(-e.deltaY * 0.0012);
          sim.zoom = Math.min(2.5, Math.max(0.4, next));
        }
        function onDbl() {
          sim.zoom = 1; // 复位：缩放回 1、释放全部拖拽固定
          graph.nodes.forEach(function (nd) { nd.fixed = false; });
          setTip(null);
        }
        canvas.addEventListener("mousedown", onDown);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("dblclick", onDbl);
        return function () {
          cancelAnimationFrame(sim.raf);
          if (tipRafRef.current) { cancelAnimationFrame(tipRafRef.current); tipRafRef.current = 0; }
          if (ro) ro.disconnect();
          canvas.removeEventListener("mousedown", onDown);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          canvas.removeEventListener("wheel", onWheel);
          canvas.removeEventListener("dblclick", onDbl);
        };
      }, [snap]);
      if (!graph.nodes.length) return h(Empty, { text: tt("relations.noData") });
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" },
            h("h3", { className: "myt-cardTitle" }, tt("relations.title")),
            h("span", { className: "myt-muted" }, tf("relations.counts", { n: graph.nodes.length, m: graph.edges.length }))),
          h("div", { className: "myt-graphWrap", ref: wrapRef },
            h("canvas", { className: "myt-graphCanvas", ref: canvasRef, "data-dragging": "false" }),
            tip ? h("div", { className: "myt-graphTip", style: { left: Math.min(tip.x + 12, 320) + "px", top: Math.max(tip.y - 34, 4) + "px" } }, tip.text) : null),
          h("div", { className: "myt-graphFoot" }, tt("relations.help"))),
        graph.unlinked.length ? h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, tt("relations.unlinkedTitle"))),
          h("div", { className: "myt-unlinked" }, graph.unlinked.map(function (n, i) {
            return h("span", { key: n || i, className: "myt-unlinkedTag" }, n);
          }))) : null);
    }

    // ── cordis client 插件入口 ──────────────────────────────────────────────
    // 依赖声明：底部入口走宿主 slots 键控槽，须声明 slots 服务（护栏下未声明
    // 的 ctx.slots 取不到，槽口挂载会静默折返）。挂载内部自捕：单个失败只
    // warn，不拖垮其余（单步自捕）。
    var inject = ["slots"];

    function apply(ctx) {
      var controller = createPanelController();
      var manual = []; // ctx.effect 不可用时的保底清理函数
      function track(mount, label) {
        if (ctx && typeof ctx.effect === "function") {
          try { ctx.effect(mount, label); return; } catch (err) { /* 落入手动路径 */ }
        }
        try {
          var dispose = mount();
          if (typeof dispose === "function") manual.push(dispose);
        } catch (err) {
          if (ctx && ctx.logger && typeof ctx.logger.warn === "function") {
            ctx.logger.warn("dsh-maoying: " + label + " mount failed: " + String((err && err.message) || err));
          }
        }
      }
      track(function () { return mountFooterEntry(ctx, controller); }, "dsh-maoying: footer entry");
      track(function () { return mountPanel(controller); }, "dsh-maoying: panel overlay");
      return function () {
        manual.forEach(function (dispose) {
          try { dispose(); } catch (err) { /* 单个清理失败不阻断其余 */ }
        });
      };
    }

    exports.inject = inject;
    exports.apply = apply;

    return module.exports;
  },
});
