/*
 * fake-dom.mjs - the smallest DOM that content/panel.js needs.
 *
 * It exists so the panel's rendering, error handling and SPA navigation logic
 * can be executed in plain Node. It is not a browser: it implements only the
 * surface panel.js touches, and it throws loudly if the panel reaches for
 * something it does not provide.
 */

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  contains(name) {
    return String(this.el.className).split(/\s+/).includes(name);
  }
}

function rootOf(node) {
  let n = node;
  for (;;) {
    while (n.parentNode) n = n.parentNode;
    if (n.__shadowHost) {
      n = n.__shadowHost;
      continue;
    }
    return n;
  }
}

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.id = "";
    this.shadowRoot = null;
    this.clicked = 0;
    this.disabled = false;
    this._text = "";
    this.style = {
      _props: {},
      setProperty(k, v) {
        this._props[k] = v;
      },
      get display() {
        return this._props.display || "";
      },
      set display(v) {
        this._props.display = v;
      }
    };
    this.classList = new FakeClassList(this);
  }

  get isConnected() {
    return rootOf(this).tagName === "HTML";
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  attachShadow() {
    const shadow = new FakeNode("#shadow-root", this.ownerDocument);
    shadow.__shadowHost = this;
    this.shadowRoot = shadow;
    return shadow;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, event) {
    const ev = Object.assign(
      { type, target: this, preventDefault() {}, stopPropagation() {} },
      event
    );
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
  }

  click() {
    this.clicked += 1;
    this.dispatch("click", {});
  }

  set textContent(value) {
    this.children = [];
    this._text = value == null ? "" : String(value);
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }

  get innerText() {
    return this.textContent;
  }

  /* ---- test helpers ---- */

  find(predicate) {
    if (predicate(this)) return this;
    for (const c of this.children) {
      const hit = c.find(predicate);
      if (hit) return hit;
    }
    return null;
  }

  findAll(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const c of this.children) c.findAll(predicate, out);
    return out;
  }

  byClass(name) {
    return this.findAll((el) => el.classList.contains(name));
  }
}

export function makeDom({ href = "https://www.tuneps.tn/", fetchImpl } = {}) {
  const doc = {};

  doc.documentElement = new FakeNode("html", doc);
  doc.body = new FakeNode("body", doc);
  doc.documentElement.appendChild(doc.body);
  doc.readyState = "complete";
  doc.listeners = {};

  doc.createElement = (tag) => new FakeNode(tag, doc);
  doc.createTextNode = (text) => {
    const n = new FakeNode("#text", doc);
    n.textContent = text;
    return n;
  };
  doc.getElementById = (id) => doc.documentElement.find((el) => el.id === id);
  doc.addEventListener = (type, fn) => {
    (doc.listeners[type] = doc.listeners[type] || []).push(fn);
  };

  const location = { href };
  const intervals = [];
  const objectUrls = [];

  const win = { console, addEventListener() {}, location };

  const urlProxy = new Proxy(URL, {
    get(target, prop) {
      if (prop === "createObjectURL") {
        return (blob) => {
          const u = "blob:fake/" + objectUrls.length;
          objectUrls.push({ url: u, blob });
          return u;
        };
      }
      if (prop === "revokeObjectURL") return () => {};
      return Reflect.get(target, prop);
    }
  });

  const sandbox = {
    document: doc,
    window: win,
    location,
    console,
    fetch: fetchImpl,
    AbortController,
    Blob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
    URL: urlProxy,
    URLSearchParams,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  return {
    sandbox,
    doc,
    location,
    objectUrls,
    /** Run the poll callback panel.js registered with setInterval. */
    tick: () => intervals.forEach((fn) => fn()),
    shadow: () => {
      const host = doc.getElementById("tuneps-document-downloader-root");
      return host ? host.shadowRoot : null;
    }
  };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
