import { JSDOM } from 'jsdom';

export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.Event = dom.window.Event;
  if (dom.window.File) globalThis.File = dom.window.File;
  globalThis.CSS = dom.window.CSS || { escape: (value) => String(value) };
  if (!globalThis.CSS.escape) globalThis.CSS.escape = (value) => String(value);
  return dom;
}

export function removeDom(dom) {
  dom.window.close();
  for (const key of ['window', 'document', 'localStorage', 'Event', 'File', 'CSS']) {
    delete globalThis[key];
  }
}
