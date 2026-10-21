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
    var useState = React.useState, useEffect = React.useEffect, useCallback = React.useCallback, useRef = React.useRef;
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

    var STATUS_FLOW = ["pending", "writing", "review", "accepted"];
    var STATUS_LABEL = { pending: "待写", writing: "写作中", review: "审校中", accepted: "已定稿" };
    var FS_ORDER = ["planted", "progressing", "resolved", "abandoned"];
    var FS_FLOW = { planted: "progressing", progressing: "resolved" };
    var FS_LABEL = { planted: "埋设", progressing: "推进中", resolved: "已回收", abandoned: "已弃用" };
    var PRI_LABEL = { high: "高", normal: "中", low: "低" };
    var PHASES = ["idea", "setting", "outline", "writing", "review", "consistency", "export"];
    var PHASE_LABEL = { idea: "立意", setting: "设定", outline: "大纲", writing: "写作", review: "审校", consistency: "一致性", export: "导出" };
    var SCI_LABEL = { known: "已确证", extrapolation: "推演", hypothesis: "假说" };
    var CLUE_KIND_LABEL = { clue: "线索", red_herring: "红鲱鱼", inference: "推理", question: "疑问" };
    var TABS = [
      ["overview", "概览"], ["chapters", "章节"], ["characters", "角色"],
      ["foreshadows", "伏笔"], ["relations", "关系图"], ["timeline", "时间线"],
      ["world", "设定"], ["index", "索引板"],
    ];

    // 角色徽章四色（role 是自由文本）：按关键词归 tone，命中即返。
    function roleTone(role) {
      var r = String(role || "");
      if (/主角|protagonist|男主|女主/i.test(r)) return "a";
      if (/反派|对立|antagonist|敌/i.test(r)) return "b";
      if (/配角|支持|盟友|friend|ally/i.test(r)) return "c";
      return "d";
    }
    function roleBadge(role) {
      var text = String(role || "").trim();
      if (!text) return null;
      return h("span", { className: "myt-badge myt-roleBadge", "data-tone": roleTone(text) }, text);
    }
    function statusBadge(status) {
      var s = STATUS_FLOW.indexOf(status) !== -1 ? status : "pending";
      return h("span", { className: "myt-badge", "data-status": s }, STATUS_LABEL[s] + (status && s !== status ? "（" + status + "）" : ""));
    }
    function phasePill(phase) {
      var p = PHASES.indexOf(phase) !== -1 ? phase : null;
      if (!p) return h("span", { className: "myt-phase", "data-phase": "idea", title: phase || "" }, phase ? String(phase) : "未设阶段");
      return h("span", { className: "myt-phase", "data-phase": p }, PHASE_LABEL[p]);
    }
    function priDot(pri) {
      var p = pri === "high" || pri === "low" ? pri : "normal";
      return h("span", { className: "myt-priDot", "data-pri": p, title: "优先级：" + (PRI_LABEL[p] || pri || "中"), "aria-label": "优先级" + (PRI_LABEL[p] || "") });
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
      var num = typeof ch.num === "number" ? "第 " + ch.num + " 章" : "";
      return ch.volume ? String(ch.volume) + " · " + num : num;
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
    function maoyingApi(path, body) {
      var opts = body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = null;
      if (ctrl) {
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS);
      }
      return fetch(API_BASE + path, opts).then(function (r) {
        // 先取全文再 JSON.parse：代理错误页 / 空体不再抛 SyntaxError。
        return r.text().then(function (raw) {
          var d = null;
          try { d = raw ? JSON.parse(raw) : null; } catch (err) { d = null; }
          if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
          if (!d) throw new Error("响应不是 JSON（HTTP " + r.status + "）");
          return d;
        });
      }).catch(function (err) {
        if (ctrl && err && err.name === "AbortError") throw new Error("请求超时（" + API_TIMEOUT_MS / 1000 + " 秒）");
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
        toast.err("毛颖创作台：" + err.message);
        throw err;
      });
    }
    function apiPost(path, body) {
      return maoyingApi(path, body || {}).then(function (d) {
        toast.ok(apiPostOkText(path, d));
        return d;
      }, function (err) {
        toast.err("毛颖创作台：" + err.message);
        throw err;
      });
    }
    // 写操作成功提示按路由分流（server 返回 chapters 计数时带上）。
    function apiPostOkText(path, d) {
      if (path === "rebuild-index") return "索引已重建（" + fmtNum(d && d.chapters) + " 章）";
      if (path === "chapter-status") return "章节状态已更新";
      if (path === "foreshadow-status") return "伏笔状态已更新";
      if (path === "phase") return "阶段已推进到「" + (PHASE_LABEL[d && d.phase] || (d && d.phase) || "—") + "」";
      return "操作成功";
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
      return h("div", { className: "myt-toastHost", "aria-live": "polite" },
        items.map(function (it) {
          return h("div", {
            key: it.id,
            className: "myt-toast myt-toast" + it.kind.charAt(0).toUpperCase() + it.kind.slice(1),
            role: it.kind === "err" ? "alert" : "status",
          },
            h("div", { className: "myt-toastText" }, it.text),
            h("button", {
              type: "button", className: "myt-toastClose", "aria-label": "关闭提示",
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
      var title = props.title || "该工作区还没有小说项目";
      var desc = props.desc || "在下面给出的命令里初始化目录骨架（或把已有 novel 目录放进工作区根），然后刷新本面板。";
      var _b = useState(false), busy = _b[0], setBusy = _b[1];
      function doCopy() {
        setBusy(true);
        copyText("maoying init").then(function (ok) {
          if (ok) toast.ok("已复制 maoying init");
          else toast.warn("复制失败，请手动选择命令文本");
        }).finally(function () { setBusy(false); });
      }
      return h("div", { className: "myt-card myt-guide" },
        h("h2", { className: "myt-guideTitle" }, title),
        h("p", { className: "myt-guideText" }, desc),
        h("div", { className: "myt-guideCode" },
          h("code", { className: "myt-guideCodeText" }, "maoying init"),
          h("button", { type: "button", className: "myt-btn myt-copyBtn", disabled: busy, onClick: doCopy }, busy ? "复制中…" : "复制命令")));
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
        props.onRetry ? h("button", { type: "button", className: "myt-btn", style: { marginLeft: "auto" }, onClick: props.onRetry }, "重试") : null);
    }
    function Empty(props) { return h("div", { className: "myt-empty" }, props.text || "暂无数据"); }

    // ── 页面骨架：顶栏（工作区下拉 + 刷新 + 关闭）+ tab 条 + 内容区 ─────────
    // 数据流：workspaces 一次拉取；state 跟随选中工作区；写操作 POST 成功后
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
      var _pc = useState(null), pendingChapter = _pc[0], setPendingChapter = _pc[1];

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
      var loadState = useCallback(function (root) {
        if (!root) { setSnap(null); setStateErr(""); setLoading(false); return; }
        setLoading(true);
        setStateErr("");
        return apiGet("state", { path: root }).then(function (d) {
          setSnap(d && d.ok ? d : null);
        }).catch(function (err) {
          setSnap(null);
          setStateErr(err.message);
        }).finally(function () { setLoading(false); });
      }, []);
      var reload = useCallback(function () {
        return effectiveWs ? loadState(effectiveWs) : Promise.resolve();
      }, [effectiveWs, loadState]);

      // 新版检测（模仿 dsh-paoding）：面板打开时拉一次（服务端有 1h 缓存），
      // updateAvailable 才渲染徽章；失败静默，不打扰任何主流程。
      var _ver = useState(null), ver = _ver[0], setVer = _ver[1];
      useEffect(function () {
        apiGet("update-check").then(function (d) {
          if (d && d.updateAvailable) setVer(d);
        }).catch(function () {});
      }, []);
      useEffect(function () { loadWorkspaces(); }, [loadWorkspaces]);
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
        if (next === "chapters") setPendingChapter(chapterFile || null);
      }

      var novelWorkspaces = (workspaces || []).filter(function (w) { return w.hasNovel; });
      var body = null;
      if (workspaces === null) {
        body = h(SkelPage); // 首拉未回：骨架，不闪引导卡
      } else if (!effectiveWs) {
        // 全无 novel 工作区：引导卡（maoying init + 复制）。
        body = h("div", { className: "myt-stack" },
          wsErr ? ErrorStrip({ text: "工作区列表拉取失败：" + wsErr, onRetry: loadWorkspaces }) : null,
          h(GuideCard, {
            title: "还没有可用的小说工作区",
            desc: "任一工作区根目录下出现 novel/project.yml 即自动入选；先用命令初始化目录骨架：",
          }));
      } else if (loading && !snap) {
        body = h(SkelPage);
      } else if (stateErr) {
        body = h(ErrorStrip, { text: "快照拉取失败：" + stateErr, onRetry: reload });
      } else if (snap && snap.found === false) {
        body = h(GuideCard, {
          title: "该工作区尚未初始化小说项目",
          desc: "工作区根目录下没有 novel/project.yml。在该工作区根目录执行：",
        });
      } else if (snap) {
        var tabProps = { snap: snap, reload: reload, wsPath: effectiveWs };
        if (tab === "chapters") body = h(ChaptersTab, Object.assign({ initialFile: pendingChapter, onConsumeInitial: function () { setPendingChapter(null); } }, tabProps));
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
              ver && ver.updateAvailable
                ? h("a", { className: "myt-verBadge", href: ver.releaseUrl || "#", target: "_blank", rel: "noreferrer", title: "当前 " + ver.current + "，点击打开新版发布页" },
                    "有新版 " + ver.latest + " ↗")
                : null),
            h("p", { className: "myt-subtitle" }, "网文项目可视化与状态流转 · 只读正文，写状态")),
          h("div", { className: "myt-headActions" },
            workspaces && novelWorkspaces.length
              ? [h("span", { className: "myt-wsLabel", key: "l" }, "工作区"),
                 h("select", { className: "myt-wsSelect", key: "s", value: effectiveWs, onChange: chooseWs, "aria-label": "选择工作区" },
                   workspaces.map(function (w, i) {
                     return h("option", { key: w.path || i, value: w.path || "", disabled: !w.hasNovel },
                       (w.hasNovel ? "" : "（无 novel）") + (w.name || w.path || "未命名"));
                   }))]
              : null,
            h("button", { type: "button", className: "myt-btn myt-btnIcon", title: "重新拉取", "aria-label": "重新拉取", disabled: loading, onClick: reload }, ic("IconRefreshOutlineRegular", 14)),
            h("button", { type: "button", className: "myt-closeBtn", "aria-label": "关闭创作台", title: "关闭", onClick: onClose }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
        h("nav", { className: "myt-tabs", "aria-label": "创作台分区" },
          TABS.map(function (t) {
            return h("button", {
              key: t[0], type: "button", className: "myt-tab", "data-active": tab === t[0] ? "true" : undefined,
              onClick: function () { gotoTab(t[0]); },
            }, t[1]);
          })),
        h("div", { className: "myt-body" },
          h("div", { className: "myt-page" },
            snap && Array.isArray(snap.warnings) && snap.warnings.length ? WarningsStrip(snap.warnings) : null,
            body)),
        h(ToastHost));
    }

    // warnings 黄条（坏文件清单，spec §3：面板顶部显示）。
    function WarningsStrip(warnings) {
      return h("div", { className: "myt-strip myt-stripWarn" },
        h("span", { className: "myt-stripIcon" }, ic("IconWarningOutlineRegular", 14)),
        h("span", { className: "myt-stripText" },
          h("div", null, h("strong", null, "部分文件解析异常（已跳过）：")),
          warnings.map(function (w, i) { return h("div", { key: i }, "· " + String(w)); })));
    }

    // ── 概览 tab：project 卡 + 统计卡 + 最近更新 ───────────────────────────
    function OverviewTab(props) {
      var snap = props.snap;
      var reload = props.reload;
      var gotoTab = props.gotoTab;
      var project = snap.project || {};
      var totals = snap.totals || {};
      var byStatus = totals.byStatus || {};
      var _b = useState(false), phaseBusy = _b[0], setPhaseBusy = _b[1];
      var phaseIdx = PHASES.indexOf(project.phase);
      var nextPhase = phaseIdx !== -1 && phaseIdx < PHASES.length - 1 ? PHASES[phaseIdx + 1] : null;
      function advancePhase() {
        if (!nextPhase || phaseBusy) return;
        setPhaseBusy(true);
        apiPost("phase", { path: props.wsPath, phase: nextPhase }).then(reload).catch(function () {}).finally(function () { setPhaseBusy(false); });
      }
      var recent = (snap.chapters || []).slice().sort(function (a, b) { return (b.num || 0) - (a.num || 0); }).slice(0, 5);
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card myt-hero" },
          h("div", { className: "myt-heroMeta" },
            project.author ? h("span", { className: "myt-muted" }, "作者：" + project.author) : null,
            project.genre ? h("span", { className: "myt-badge" }, project.genre) : null,
            project.length ? h("span", { className: "myt-badge" }, project.length) : null,
            project.language ? h("span", { className: "myt-badge" }, project.language) : null),
          h("h2", { className: "myt-heroTitle" }, orDash(project.title)),
          h("div", { className: "myt-heroMeta" },
            phasePill(project.phase),
            nextPhase ? h("button", { type: "button", className: "myt-btn", disabled: phaseBusy, onClick: advancePhase, title: "推进到「" + PHASE_LABEL[nextPhase] + "」" }, phaseBusy ? "推进中…" : "推进阶段") : h("span", { className: "myt-muted" }, project.phase ? "已是最终阶段" : null)),
          project.description ? h("p", { className: "myt-heroDesc" }, project.description) : null),
        h("div", { className: "myt-statRow" },
          h("div", { className: "myt-card myt-stat" }, h("span", { className: "myt-statNum" }, fmtNum(totals.words)), h("span", { className: "myt-statLabel" }, "总字数（CJK）")),
          h("div", { className: "myt-card myt-stat" }, h("span", { className: "myt-statNum" }, fmtNum(totals.chapters)), h("span", { className: "myt-statLabel" }, "章节总数")),
          h("div", { className: "myt-card myt-stat" },
            h("span", { className: "myt-statNum" }, fmtNum((snap.characters || []).length)),
            h("span", { className: "myt-statLabel" }, "角色数")),
          h("div", { className: "myt-card myt-stat" },
            h("span", { className: "myt-statNum" }, fmtNum((snap.foreshadows || []).filter(function (f) { return f.status === "planted" || f.status === "progressing"; }).length)),
            h("span", { className: "myt-statLabel" }, "未回收伏笔"))),
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "章节状态分布")),
          h("div", { className: "myt-distBar", "aria-hidden": "true" }, STATUS_FLOW.map(function (s) {
            var n = byStatus[s] || 0;
            return n > 0 ? h("div", { key: s, className: "myt-distSeg", "data-status": s, style: { flexGrow: n } }) : null;
          })),
          h("div", { className: "myt-heroMeta" }, STATUS_FLOW.map(function (s) {
            return h("span", { key: s, className: "myt-muted" }, STATUS_LABEL[s] + " " + (byStatus[s] || 0));
          }))),
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "最近章节")),
          recent.length
            ? h("div", { className: "myt-recentList" }, recent.map(function (ch) {
                return h("button", { key: ch.file, type: "button", className: "myt-recentRow", onClick: function () { gotoTab("chapters", ch.file); } },
                  statusBadge(ch.status),
                  h("span", { className: "myt-chTitle" }, orDash(ch.title)),
                  h("span", { className: "myt-chPath" }, chWhere(ch)),
                  h("span", { className: "myt-wordsCell" }, fmtNum(ch.words) + " 字"));
              }))
            : h(Empty, { text: "chapters/ 目录还没有章节文件" })));
    }

    // ── 章节 tab：状态筛选 pills + 表格 + 行抽屉（只读正文 + 五维 + 流转）────
    var FIVE_DIMS = [
      ["cognitive_frame", "认知框架"], ["emotional_anchor", "情感锚点"], ["world_texture", "世界质感"],
      ["suspense", "悬念"], ["interpersonal_tension", "人际张力"],
    ];
    // 章纲对照栏（五期）：outline 非空时渲染可折叠原文（默认展开，只读，样式
    // 与正文区分）；共享常量避免重渲染时折叠态意外重置——组件随抽屉挂载，
    // 切章即重挂回默认展开。
    function OutlinePanel(props) {
      var outline = props.outline;
      var _op = useState(true), open = _op[0], setOpen = _op[1];
      var body = outline && typeof outline.body === "string" && outline.body.trim() !== "" ? outline.body : "（章纲为空）";
      return h("div", { className: "myt-outlinePanel" },
        h("button", {
          type: "button", className: "myt-outlineHead",
          "aria-expanded": open ? "true" : "false",
          title: open ? "收起章纲" : "展开章纲",
          onClick: function () { setOpen(!open); },
        },
          h("span", { className: "myt-outlineTitle" }, "章纲对照"),
          typeof (outline && outline.words) === "number" ? h("span", { className: "myt-outlineWords" }, fmtNum(outline.words) + " 字") : null,
          h("span", { className: "myt-outlineChevron", "aria-hidden": "true" },
            ic(open ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", 14))),
        open ? h("pre", { className: "myt-outlineBody" }, body) : null);
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

    function ChaptersTab(props) {
      var snap = props.snap;
      var reload = props.reload;
      var wsPath = props.wsPath;
      var _f = useState("all"), filter = _f[0], setFilter = _f[1];
      var _o = useState(null), openFile = _o[0], setOpenFile = _o[1];
      var _d = useState(null), detail = _d[0], setDetail = _d[1]; // {loading, data, err}
      var _b = useState(false), flowBusy = _b[0], setFlowBusy = _b[1];
      // 概览「最近章节」点进来：initialFile 只消费一次（吃掉后回置空，防止
      // 下次进 tab 时把旧抽屉又顶开）。
      useEffect(function () {
        if (props.initialFile) {
          setOpenFile(props.initialFile);
          if (typeof props.onConsumeInitial === "function") props.onConsumeInitial();
        }
      }, [props.initialFile]);
      var loadDetail = useCallback(function (file) {
        if (!file) { setDetail(null); return; }
        setDetail({ loading: true, data: null, err: "" });
        apiGet("chapter", { path: wsPath, file: file }).then(function (d) {
          setDetail({ loading: false, data: d, err: "" });
        }).catch(function (err) {
          setDetail({ loading: false, data: null, err: err.message });
        });
      }, [wsPath]);
      useEffect(function () { loadDetail(openFile); }, [openFile, loadDetail]);
      function advance(ch) {
        var idx = STATUS_FLOW.indexOf(ch.status);
        var next = idx !== -1 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
        if (!next || flowBusy) return;
        setFlowBusy(true);
        apiPost("chapter-status", { path: wsPath, file: ch.file, status: next })
          .then(function () { return reload(); })
          .then(function () { if (openFile === ch.file) return loadDetail(ch.file); })
          .catch(function () {}).finally(function () { setFlowBusy(false); });
      }
      var chapters = snap.chapters || [];
      var rows = filter === "all" ? chapters : chapters.filter(function (c) { return c.status === filter; });
      var counts = snap.totals && snap.totals.byStatus ? snap.totals.byStatus : {};
      var openCh = null;
      for (var i = 0; i < chapters.length; i++) { if (chapters[i].file === openFile) { openCh = chapters[i]; break; } }
      // 「按单写作」（五期）：state.outlines 与 chapters 联交——有章纲且
      // status=pending 的章，按章纲（卷-章号）序列出，共创模式的主工作清单；
      // 空块（无待写章纲章）整块不渲染。孤儿章纲（chapter 无对应章节）联交
      // 不中，自然落榜。
      var outlines = snap.outlines || [];
      var chapterByFile = {};
      chapters.forEach(function (c) { chapterByFile[c.file] = c; });
      var writeOrder = [];
      outlines.forEach(function (ol) {
        var ch = ol && ol.chapter ? chapterByFile[ol.chapter] : null;
        if (ch && (ch.status || "pending") === "pending") writeOrder.push({ ch: ch, ol: ol });
      });
      function copyChapterPath() {
        copyText(chapterAbsPath(snap && snap.novelDir, openFile)).then(function (ok) {
          if (ok) toast.ok("已复制章节文件路径");
          else toast.warn("复制失败，请手动选择路径文本");
        });
      }
      return h("div", { className: "myt-stack" },
        writeOrder.length ? h("div", { className: "myt-card myt-writeOrder" },
          h("div", { className: "myt-cardHead" },
            h("h3", { className: "myt-cardTitle" }, "按单写作"),
            h("span", { className: "myt-boardCount" }, writeOrder.length)),
          h("div", { className: "myt-writeOrderList" }, writeOrder.map(function (item) {
            var ch = item.ch;
            var ol = item.ol;
            return h("button", {
              key: ch.file, type: "button", className: "myt-writeOrderRow",
              title: "点击打开该章抽屉",
              onClick: function () { setOpenFile(ch.file); },
            },
              h("span", { className: "myt-chPath" }, chWhere(ch) || ch.file),
              h("span", { className: "myt-chTitle" }, orDash(ch.title)),
              statusBadge(ch.status),
              ol && typeof ol.excerpt === "string" && ol.excerpt !== ""
                ? h("span", { className: "myt-writeOrderExcerpt", title: ol.excerpt }, truncate(ol.excerpt, 60)) : null,
              ol && ol.words ? h("span", { className: "myt-wordsCell" }, "章纲 " + fmtNum(ol.words) + " 字") : null);
          }))) : null,
        h("div", { className: "myt-filterRow" },
          [{ k: "all", label: "全部", n: chapters.length }].concat(STATUS_FLOW.map(function (s) {
            return { k: s, label: STATUS_LABEL[s], n: counts[s] || 0 };
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
              h("th", null, "卷 · 章"), h("th", null, "标题"), h("th", null, "状态"), h("th", null, "字数"), h("th", null, "梗概"))),
            h("tbody", null, rows.map(function (ch) {
              return h("tr", { key: ch.file, onClick: function () { setOpenFile(ch.file); }, title: "点击查看正文" },
                h("td", null, h("span", { className: "myt-chPath" }, chWhere(ch) || "—")),
                h("td", null, h("span", { className: "myt-chTitle" }, orDash(ch.title))),
                h("td", null, statusBadge(ch.status)),
                h("td", null, h("span", { className: "myt-wordsCell" }, fmtNum(ch.words))),
                h("td", null, h("div", { className: "myt-summaryCell myt-muted" }, orDash(ch.summary))));
            }))))
          : (chapters.length ? h(Empty, { text: "该状态下没有章节" }) : h(Empty, { text: "chapters/ 目录还没有章节文件" })),
        openFile ? h(MaskPortal, {
          className: "myt-drawerMask",
          onMouseDown: function (e) { if (e.target === e.currentTarget) setOpenFile(null); },
        },
          h("aside", { className: "myt-drawer", role: "dialog", "aria-modal": "true", "aria-label": "章节详情" },
            h("div", { className: "myt-drawerHead" },
              h("h2", { className: "myt-drawerTitle" }, openCh ? chFullTitle(openCh) : openFile),
              h("div", { className: "myt-heroMeta" }, openCh ? statusBadge(openCh.status) : null,
                h("button", {
                  type: "button", className: "myt-btn myt-copyBtn",
                  title: "复制章节文件路径", "aria-label": "复制章节文件路径",
                  onClick: copyChapterPath,
                }, ic("IconCopyOutlineRegular", 13), "复制路径"),
                h("button", { type: "button", className: "myt-closeBtn", "aria-label": "关闭抽屉", onClick: function () { setOpenFile(null); } }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
            h("div", { className: "myt-drawerBody" },
              !detail || detail.loading ? h("div", { className: "myt-stack" }, h("div", { className: "myt-skel myt-skelRow" }), h("div", { className: "myt-skel myt-skelRow", style: { width: "80%" } }), h("div", { className: "myt-skel myt-skelRow", style: { width: "64%" } }))
                : detail.err ? h(ErrorStrip, { text: "正文读取失败：" + detail.err, onRetry: function () { loadDetail(openFile); } })
                  : [
                      (function () {
                        var ol = detail.data && detail.data.outline;
                        // 有章纲：对照栏置顶（可折叠，默认展开）；无章纲：一行
                        // 淡字提示——共创模式下这是「先要章纲」的信号。
                        return ol ? h(OutlinePanel, { key: "outline", outline: ol })
                          : h("div", { key: "outline-none", className: "myt-outlineEmpty" }, "暂无章纲");
                      })(),
                      h("pre", { key: "body", className: "myt-chapterBody" }, (detail.data && detail.data.body) || "（空章节）"),
                    ],
              openCh ? h("div", { className: "myt-dimGrid" }, FIVE_DIMS.map(function (dim) {
                return h("div", { key: dim[0], className: "myt-dim" },
                  h("div", { className: "myt-dimLabel" }, dim[1]),
                  h("div", { className: "myt-dimText" }, orDash(openCh[dim[0]])));
              })) : null),
            openCh ? h("div", { className: "myt-drawerFoot" },
              (function () {
                var idx = STATUS_FLOW.indexOf(openCh.status);
                var next = idx !== -1 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
                if (!next) return h("span", { className: "myt-muted" }, "已定稿（终态）");
                return [h("span", { className: "myt-muted", key: "t" }, "状态流转："),
                  h("button", { key: "b", type: "button", className: "myt-btn myt-btnPrimary", disabled: flowBusy, onClick: function () { advance(openCh); } },
                    flowBusy ? "流转中…" : "推进到「" + STATUS_LABEL[next] + "」")];
              })()) : null)) : null);
    }

    // ── 角色 tab：卡墙 + 全卡弹层 ───────────────────────────────────────────
    var CHAR_FULL_ROWS = [
      ["age", "年龄"], ["gender", "性别"], ["appearance", "外貌"], ["personality", "性格"],
      ["background", "背景"], ["motivation", "动机"], ["arc", "成长弧"],
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
              [c.age !== null && c.age !== undefined ? c.age + " 岁" : null, c.gender || null].filter(Boolean).join(" · ") || "—"),
            c.personality ? h("div", { className: "myt-charLine" }, h("span", { className: "myt-charLabel" }, "性格 "), truncate(c.personality, 60)) : null,
            c.motivation ? h("div", { className: "myt-charLine" }, h("span", { className: "myt-charLabel" }, "动机 "), truncate(c.motivation, 60)) : null);
        })) : h(Empty, { text: "characters/ 目录还没有角色卡" }),
        modal ? h(MaskPortal, {
          className: "myt-modalMask",
          onMouseDown: function (e) { if (e.target === e.currentTarget) setModalFile(null); },
        },
          h("div", { className: "myt-modalCard", role: "dialog", "aria-modal": "true", "aria-label": "角色详情" },
            h("div", { className: "myt-modalHead" },
              h("h2", { className: "myt-modalTitle" }, orDash(modal.name)),
              h("div", { className: "myt-heroMeta" },
                roleBadge(modal.role),
                h("button", { type: "button", className: "myt-closeBtn", "aria-label": "关闭角色卡", onClick: function () { setModalFile(null); } }, h("span", { className: "myt-closeGlyph", "aria-hidden": "true" }, "×")))),
            h("div", { className: "myt-modalBody" },
              CHAR_FULL_ROWS.map(function (row) {
                return h("div", { key: row[0], className: "myt-kvRow" },
                  h("span", { className: "myt-kvKey" }, row[1]),
                  h("span", { className: "myt-kvVal" }, orDash(modal[row[0]])));
              }),
              h("div", { className: "myt-kvRow" },
                h("span", { className: "myt-kvKey" }, "标记"),
                h("span", { className: "myt-kvVal myt-tagRow" },
                  (modal.markers || []).length
                    ? modal.markers.map(function (m, i) { return h("span", { key: i, className: "myt-markerTag" }, m); })
                    : "—")),
              h("div", { className: "myt-kvRow" },
                h("span", { className: "myt-kvKey" }, "文件"),
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
              h("span", { className: "myt-boardTitle" }, FS_LABEL[col]),
              h("span", { className: "myt-boardCount" }, items.length)),
            items.map(function (fs) {
              var next = FS_FLOW[col] || null;
              var busy = busyId === fs.id;
              var chRange = [fs.planted_chapter || "埋设章未标", fs.expected_resolve].filter(Boolean).join(" → ");
              return h("div", { key: fs.id || fs.title, className: "myt-fsCard" },
                h("div", { className: "myt-fsTitle" },
                  priDot(fs.priority), h("span", null, orDash(fs.title) || orDash(fs.id)),
                  // 回填徽章（五期账本回填）：区别于写前规划条目，悬浮见来源。
                  fs.source === "backfill" ? h("span", { className: "myt-backfillBadge", title: "从作者正文回填" }, "回填") : null),
                h("div", { className: "myt-fsMeta" },
                  h("span", null, col === "resolved" && fs.resolved_chapter ? "回收于 " + fs.resolved_chapter : chRange),
                  fs.priority && fs.priority !== "normal" ? h("span", null, "优先级 " + (PRI_LABEL[fs.priority] || fs.priority)) : null),
                fs.notes ? h("div", { className: "myt-fsNotes", title: fs.notes }, fs.notes) : null,
                h("div", { className: "myt-fsActions" },
                  next ? h("button", { type: "button", className: "myt-btn", disabled: busy || !fs.id, title: fs.id ? undefined : "该条目缺 id，无法写状态", onClick: function () { setStatus(fs, next); } }, busy ? "推进中…" : (col === "planted" ? "推进" : "回收")) : null,
                  col !== "resolved" && col !== "abandoned"
                    ? h("button", { type: "button", className: "myt-btn myt-btnDanger", disabled: busy || !fs.id, onClick: function () { setStatus(fs, "abandoned"); } }, "弃用") : null));
            }),
            items.length ? null : h("div", { className: "myt-muted" }, "空"));
        })) : h(Empty, { text: "foreshadows.yml 还没有伏笔条目" }));
    }

    // ── 时间线 tab：垂直轴 + importance 点位（1-5 → 大小/深浅）──────────────
    function TimelineTab(props) {
      var items = (props.snap.timeline || []).slice();
      if (items.length) {
        items.sort(function (a, b) { return String(a.year || "").localeCompare(String(b.year || ""), "zh-CN", { numeric: true }); });
      }
      if (!items.length) return h(Empty, { text: "timeline.yml 还没有时间线条目" });
      return h("div", { className: "myt-card" },
        h("div", { className: "myt-timeline" }, items.map(function (t, i) {
          var imp = Math.min(5, Math.max(1, typeof t.importance === "number" ? t.importance : 3));
          return h("div", { key: i, className: "myt-tlRow" },
            h("div", { className: "myt-tlYear" }, orDash(t.year)),
            h("div", { className: "myt-tlAxis" }, h("span", { className: "myt-tlDot", "data-imp": String(imp), title: "重要度 " + imp })),
            h("div", { className: "myt-tlCard" },
              h("div", { className: "myt-tlTitle" }, orDash(t.title)),
              t.description ? h("div", { className: "myt-tlDesc" }, t.description) : null,
              t.chapter ? h("div", { className: "myt-tlChapter" }, "关联章节：" + t.chapter) : null));
        })));
    }

    // ── 设定 tab：world 按 category 分组 + science 三色标签 ─────────────────
    function WorldTab(props) {
      var snap = props.snap;
      var world = snap.world || [];
      var science = snap.science || [];
      var research = snap.research || [];
      var groups = {};
      world.forEach(function (w) {
        var key = w.category || "未分类";
        if (!groups[key]) groups[key] = [];
        groups[key].push(w);
      });
      var groupKeys = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "世界观条目")),
          groupKeys.length ? h("div", { className: "myt-stack" }, groupKeys.map(function (key) {
            return h("div", { key: key, className: "myt-worldGroup" },
              h("div", { className: "myt-listHead" }, key, h("span", { className: "myt-boardCount" }, groups[key].length)),
              groups[key].map(function (w, i) {
                return h("div", { key: w.file || i, className: "myt-worldItem" },
                  h("div", { className: "myt-worldHead" },
                    h("span", { className: "myt-worldName" }, orDash(w.name)),
                    (w.tags || []).length ? h("span", { className: "myt-tagRow" }, w.tags.map(function (t, j) { return h("span", { key: j, className: "myt-tag" }, t); })) : null),
                  w.description ? h("div", { className: "myt-worldDesc" }, w.description) : null);
              }));
          })) : h(Empty, { text: "world/ 目录还没有设定条目" })),
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "科学设定"),
            h("span", { className: "myt-boardCount" }, science.length)),
          science.length ? h("div", { className: "myt-stack" }, science.map(function (s, i) {
            var label = SCI_LABEL[s.label] ? s.label : null;
            return h("div", { key: s.file || i, className: "myt-worldItem" },
              h("div", { className: "myt-worldHead" },
                h("span", { className: "myt-worldName" }, orDash(s.name)),
                h("span", { className: "myt-badge myt-sciTag", "data-label": label || "hypothesis", title: s.label && !label ? s.label : undefined },
                  label ? SCI_LABEL[label] : (s.label || "未标级"))),
              s.description ? h("div", { className: "myt-worldDesc" }, s.description) : null,
              (s.references || []).length ? h("div", { className: "myt-refList" },
                s.references.map(function (r, j) { return h("span", { key: j, className: "myt-refItem" }, "参考 " + (j + 1) + "：" + r); })) : null);
          })) : h(Empty, { text: "science/ 目录还没有科学设定" })),
        research.length ? h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "资料检索"),
            h("span", { className: "myt-boardCount" }, research.length)),
          h("div", { className: "myt-tagRow" }, research.map(function (r, i) {
            return h("span", { key: r.file || i, className: "myt-tag", title: r.file || "" }, orDash(r.topic) || r.file);
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
      var clueGroups = {};
      clues.forEach(function (c) {
        var key = c.kind || "未分类";
        if (!clueGroups[key]) clueGroups[key] = [];
        clueGroups[key].push(c);
      });
      var memGroups = {};
      memories.forEach(function (m) {
        var key = m.category || "未分类";
        if (!memGroups[key]) memGroups[key] = [];
        memGroups[key].push(m);
      });
      function groupKey(a, b) { return a.localeCompare(b, "zh-CN"); }
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-cardHead" },
          h("h3", { className: "myt-cardTitle" }, "索引板（clue-board / memories）"),
          h("button", { type: "button", className: "myt-btn", disabled: rebuildBusy, onClick: rebuild, title: "按 CLI index 同一逻辑重建 index.yml" },
            rebuildBusy ? "重建中…" : "重建索引")),
        h("div", { className: "myt-indexCols" },
          h("div", { className: "myt-card" },
            h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "线索板"), h("span", { className: "myt-boardCount" }, clues.length)),
            clues.length ? Object.keys(clueGroups).sort(groupKey).map(function (kind) {
              var label = CLUE_KIND_LABEL[kind] || kind;
              return h("div", { key: kind, className: "myt-worldGroup" },
                h("div", { className: "myt-listHead" }, label, h("span", { className: "myt-boardCount" }, clueGroups[kind].length)),
                clueGroups[kind].map(function (c, i) {
                  return h("div", { key: i, className: "myt-clueItem", "data-resolved": c.resolved ? "true" : undefined },
                    h("span", { className: "myt-clueText" }, orDash(c.content)),
                    c.related_chapter ? h("span", { className: "myt-clueChapter" }, c.related_chapter) : null);
                }));
            }) : h(Empty, { text: "clue-board.yml 还没有条目" })),
          h("div", { className: "myt-card" },
            h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "记忆板"), h("span", { className: "myt-boardCount" }, memories.length)),
            memories.length ? Object.keys(memGroups).sort(groupKey).map(function (cat) {
              var isPromise = /promise|承诺/i.test(cat);
              return h("div", { key: cat, className: "myt-worldGroup" },
                h("div", { className: "myt-listHead" },
                  cat, isPromise ? h("span", { className: "myt-markerTag" }, "承诺线") : null,
                  h("span", { className: "myt-boardCount" }, memGroups[cat].length)),
                memGroups[cat].map(function (m, i) {
                  return h("div", { key: i, className: "myt-memItem", "data-promise": isPromise ? "true" : undefined },
                    h("span", { className: "myt-clueText" }, orDash(m.content)),
                    m.source_chapter ? h("span", { className: "myt-memChapter" }, m.source_chapter) : null);
                }));
            }) : h(Empty, { text: "memories.yml 还没有条目" }))));
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
      var simRef = useRef(null);
      // 数据准备：>30 角色只留 relations 相关节点；角色空时退化为关系端点名。
      var graph = (function () {
        var byName = {};
        chars.forEach(function (c) { if (c && c.name && !byName[c.name]) byName[c.name] = c; });
        var deg = {};
        rels.forEach(function (r) { deg[r.a] = (deg[r.a] || 0) + 1; deg[r.b] = (deg[r.b] || 0) + 1; });
        var names = chars.length ? chars.map(function (c) { return c.name; }) : Object.keys(deg);
        var linked = names.filter(function (n) { return deg[n]; });
        var drawNames = names.length > 30 ? linked : names;
        var unlinked = names.filter(function (n) { return drawNames.indexOf(n) === -1; });
        var nodes = drawNames.map(function (n) { return { id: n, role: byName[n] ? byName[n].role : null, x: 0, y: 0, vx: 0, vy: 0, fixed: false }; });
        var idx = {};
        nodes.forEach(function (nd, i) { idx[nd.id] = i; });
        var edges = rels.filter(function (r) { return idx[r.a] !== undefined && idx[r.b] !== undefined; })
          .map(function (r) { return { a: idx[r.a], b: idx[r.b], type: r.type || "", desc: r.description || "", w: edgeWidth(r.intensity) }; });
        return { nodes: nodes, edges: edges, unlinked: unlinked };
      })();
      useEffect(function () {
        var wrap = wrapRef.current;
        var canvas = canvasRef.current;
        if (!wrap || !canvas || !graph.nodes.length) return undefined;
        var ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        var dpr = (window.devicePixelRatio || 1) > 0 ? window.devicePixelRatio || 1 : 1;
        var sim = { zoom: 1, drag: null, raf: 0, frame: 0, w: 0, h: 0, tokens: null, mx: -1, my: -1 };
        simRef.current = sim;
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
          sim.mx = p.x; sim.my = p.y;
          if (sim.drag) {
            var w = toWorld(p.x, p.y);
            sim.drag.node.x = w.x; sim.drag.node.y = w.y;
            return;
          }
          var e2 = hitEdge(p.x, p.y);
          if (e2) {
            setTip({ x: p.x, y: p.y, text: (e2.type ? e2.type + "：" : "") + (e2.desc || "（无描述）") });
          } else {
            setTip(function (prev) { return prev ? null : prev; });
          }
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
          if (ro) ro.disconnect();
          canvas.removeEventListener("mousedown", onDown);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          canvas.removeEventListener("wheel", onWheel);
          canvas.removeEventListener("dblclick", onDbl);
          simRef.current = null;
        };
      }, [snap]);
      if (!graph.nodes.length) return h(Empty, { text: "没有角色或关系数据，无法绘图" });
      return h("div", { className: "myt-stack" },
        h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" },
            h("h3", { className: "myt-cardTitle" }, "角色关系图"),
            h("span", { className: "myt-muted" }, graph.nodes.length + " 节点 · " + graph.edges.length + " 关系")),
          h("div", { className: "myt-graphWrap", ref: wrapRef },
            h("canvas", { className: "myt-graphCanvas", ref: canvasRef, "data-dragging": "false" }),
            tip ? h("div", { className: "myt-graphTip", style: { left: Math.min(tip.x + 12, 320) + "px", top: Math.max(tip.y - 34, 4) + "px" } }, tip.text) : null),
          h("div", { className: "myt-graphFoot" }, "拖节点固定位置 · 滚轮缩放 · 双击复位 · 悬停边看关系描述")),
        graph.unlinked.length ? h("div", { className: "myt-card" },
          h("div", { className: "myt-cardHead" }, h("h3", { className: "myt-cardTitle" }, "未入图角色（无关系边）")),
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
