const funcs = {
  // todo: error/not found handling
  'document.querySelector': ({ selector }, send, doc) => {
    const el = doc.querySelector(selector);
    send({ ptr: el?.ptr });
  },

  'document.getElementById': ({ id }, send, doc) => {
    const el = doc.allChildren().find(x => x.id === id);
    send({ ptr: el?.ptr });
  },

  'Element.getClassName': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    send({ value: el.className });
  },

  'Element.setClassName': ({ value, ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.className = value;
    send({ value: el.className });
  },

  'Element.getTextContent': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    send({ value: el.textContent });
  },

  'Element.setTextContent': ({ value, ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.textContent = value;
    send({ value: el.textContent });
  },

  'Element.getInnerHTML': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    send({ value: el.innerHTML });
  },

  'Element.setInnerHTML': ({ value, ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.innerHTML = value;
    send({});
    // send({ value: el.innerHTML });
  },

  'Element.getContentDocument': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    send({ ptr: el.contentDocument.ptr });
  },

  // todo: ensure document only, return values?
  'Document.open': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.open();
    send({});
  },

  'Document.write': ({ value, ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.write(value);
    send({});
  },

  'Document.close': ({ ptr }, send, doc) => {
    const el = doc.getFromPtr(ptr);
    el.close();
    send({});
  },

  'parent': async ({ prop, args }, send, doc) => {
    const parentInstance = instances[doc.parentDocument?.ptr];
    if (!parentInstance) return send({});

    const value = await run(parentInstance.name, doc.parentDocument, `${prop}(${args.join(',')})`);

    send({ value });
  },

  // todo: this is not subframe friendly and hacky global
  'location.getHref': ({}, send) => {
    send({ value: window._location.url });
  },

  'location.setHref': ({ value }, send, doc) => {
    const href = doc.page.resolve(value).toString();
    window.load(href);
    send({});
  },

  'alert': ({ msg }, send) => {
    alert(msg);
    send({});
  }
};

const backends = {
  kiesel: 'engine/js/backends/kiesel.js',
  spidermonkey: 'engine/js/backends/spidermonkey.js',
  host: 'engine/js/backends/host.js'
};

const instances = {};

const SERIAL_RES_SIZE = 1024 * 1024 * 10;

export const stopAll = () => {
  for (const x in instances) {
    if (x.worker) {
      x.worker.onmessage = () => {};
      x.worker.terminate();
    }

    delete instances[x];
  }
};

export const stop = doc => {
  let backend = instances[doc.ptr];

  console.log('stop backend', doc.ptr);

  if (backend) {
    backend.worker.onmessage = () => {};
    backend.worker.terminate();
  }

  delete instances[doc.ptr];
};

export const run = (backendName, doc, _js) => new Promise(async resolve => {
  if (backendName === null || !_js) return resolve(null);

  if (window.crossOriginIsolated === false) {
    alert(`due to browser restrictions, shadow has to use a service worker and reload once to be able to use some JS features which it requires for running JS (SharedArrayBuffer). try reloading`);
    return resolve(null);
  }

  let backend = instances[doc.ptr];

  if (!backend || backend.name !== backendName) {
    console.log('new backend', doc.ptr, backendName, Object.keys(instances).length);
    if (backend) {
      backend.worker.onmessage = () => {};
      backend.worker.terminate();
    }

    backend = {
      name: backendName,
      handlers: {}
    };

    instances[doc.ptr] = backend;

    backend.worker = new Worker(backends[backendName], { type: 'module' });

    const lengthBuffer = new SharedArrayBuffer(4);
    const lengthTyped = new Int32Array(lengthBuffer);
    lengthTyped[0] = 0;

    const valueBuffer = new SharedArrayBuffer(SERIAL_RES_SIZE);
    const valueTyped = new Uint8Array(valueBuffer);

    const encoder = new TextEncoder('utf8');

    backend.worker.postMessage({ lengthBuffer, valueBuffer });

    backend.worker.onmessage = e => {
      const msg = e.data;
      // if (msg.type !== 'wait') console.log('main recv', msg);
      if (backend.handlers[msg.type]) {
        backend.handlers[msg.type](msg);
      } else if (msg.f) {
        funcs[msg.f](msg, backend.send, doc);
      } else backend.send({});
    };

    backend.send = msg => {
      // if (msg.type) console.log('main send', msg);

      // const encodeBuffer = new Uint8Array(SERIAL_RES_SIZE);

      const json = JSON.stringify(msg);
      // encoder.encodeInto(json, encodeBuffer);

      const encodeBuffer = encoder.encode(json);

      for (let i = 0; i < encodeBuffer.length; i++) {
        Atomics.store(valueTyped, i, encodeBuffer[i]);
      }

      Atomics.store(lengthTyped, 0, encodeBuffer.length);
      Atomics.notify(lengthTyped, 0);
    };

    backend.on = (type, handler) => backend.handlers[type] = handler;

    await new Promise(res => backend.on('ready', () => {
      backend.send({});
      res();
    }));
  }

  const js = _js.slice().trim();
  // console.log({ js });

  backend.on('wait', () => {
    backend.send({ type: 'eval', js });

    backend.handlers.wait = null;
  });

  backend.on('done', () => {
    backend.send({});
    backend.handlers.done = null;

    resolve();
  });
});