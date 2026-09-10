var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = /* @__PURE__ */ __name((arrayBuffer, contentType) => {
  const response = new Response(arrayBuffer, {
    headers: {
      // Normalize the media type (case-insensitive) while keeping parameters like the boundary
      "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase())
    }
  });
  return response.formData();
}, "bufferToFormData");

// node_modules/hono/dist/utils/body.js
var isRawRequest = /* @__PURE__ */ __name((request) => "headers" in request, "isRawRequest");
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const contentType = headers.get("Content-Type");
  const mediaType = contentType?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return parseFormData(request, { all, dot });
  }
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) {
    return convertFormDataToBodyData(
      await request.bodyCache.formData,
      options
    );
  }
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) {
    request.bodyCache.formData = formDataPromise;
  }
  const formData = await formDataPromise;
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");

// node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var tryDecodeURI = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURI), "tryDecodeURI");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (segment.charCodeAt(segment.length - 1) === 63) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.slice(0, -1);
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var tryDecodeURIComponent = /* @__PURE__ */ __name((str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str, "tryDecodeURIComponent");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return tryDecodeURIComponent(value);
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  let encoded;
  if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = /* @__PURE__ */ __name(class {
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = tryDecodeURIComponent(value);
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    for (const anyCachedKey in bodyCache) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  };
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    ;
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
}, "HonoRequest");

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
}, "resolveCallback");

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = /* @__PURE__ */ __name(class {
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = (layout) => this.#layout = layout;
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = () => this.#layout;
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) {
        if (key === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) {
          if (++count > 1 || typeof headers[k] !== "string") {
            responseHeaders = new Headers();
            break;
          }
        }
      }
      if (responseHeaders) {
        for (const k in headers) {
          const v = headers[k];
          if (typeof v === "string") {
            responseHeaders.set(k, v);
          } else {
            responseHeaders.delete(k);
            for (const v2 of v) {
              responseHeaders.append(k, v2);
            }
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  };
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = (object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  };
  html = (html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  };
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
}, "Context");

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch", "query"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = /* @__PURE__ */ __name(class extends Error {
}, "UnsupportedPathError");

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = /* @__PURE__ */ __name(class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    }, "handler");
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} env - env Object
   * @param {ExecutionContext} executionCtx - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  };
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
}, "_Hono");

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }, "match2");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return b === TAIL_WILDCARD_REG_EXP_STR ? -1 : 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = /* @__PURE__ */ __name(class _Node {
  // handler index of a dynamic path, or -1 for a static path terminal
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, isStatic) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : null : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
        if (name && pattern[2]) {
          if (regexpStr === ".*") {
            throw PATH_ERROR;
          }
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) {
            throw PATH_ERROR;
          }
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) {
            throw PATH_ERROR;
          }
        }
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== ONLY_WILDCARD_REG_EXP_STR && regexpStr !== TAIL_WILDCARD_REG_EXP_STR) {
            for (const k in node.#children) {
              if (
                // a single-char pattern coexists with single-char literals as a literal does
                (regexpStr.length > 1 || k.length > 1) && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
              ) {
                throw PATH_ERROR;
              }
            }
          }
          nextNode = node.#children[regexpStr] = new _Node();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) {
            if (k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR) {
              throw PATH_ERROR;
            }
          }
          nextNode = node.#children[token] = new _Node();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) {
      throw PATH_ERROR;
    }
    node.#index = isStatic ? -1 : index;
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
}, "_Node");

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = /* @__PURE__ */ __name(class {
  #context = { varIndex: 0 };
  #root = new Node();
  #index = 0;
  // dynamic path -> [handler index, param assoc]; static paths are not registered
  paths = /* @__PURE__ */ Object.create(null);
  insert(path, isStatic) {
    if (isStatic) {
      this.#root.insert(path.split(""), 0, [], this.#context, true);
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
    this.paths[path] = [this.#index++, paramAssoc];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
}, "Trie");

// node_modules/hono/dist/router/reg-exp-router/router.js
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
__name(buildWildcardRegExp, "buildWildcardRegExp");
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
__name(clearWildcardRegExpCache, "clearWildcardRegExpCache");
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
__name(findMiddleware, "findMiddleware");
var RegExpRouter = /* @__PURE__ */ __name(class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  #tries;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#tries = { [METHOD_NAME_ALL]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      this.#tries[method] = new Trie();
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
          this.#insertPath(method, p);
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      Object.keys(middleware).forEach((m) => {
        if ((method === METHOD_NAME_ALL || method === m) && !middleware[m][path]) {
          this.#insertPath(m, path);
          middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        }
      });
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          if (!routes[m][path2]) {
            this.#insertPath(m, path2);
            routes[m][path2] = [
              ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
            ];
          }
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = this.#tries = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const middleware = this.#middleware[method];
    const routes = this.#routes[method];
    const trie = this.#tries[method];
    const staticMap = /* @__PURE__ */ Object.create(null);
    const handlerData = [];
    [middleware, routes].forEach((r) => {
      for (const path in r) {
        const handlers = r[path];
        const pathData = trie.paths[path];
        if (!pathData) {
          staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
          continue;
        }
        const paramAssoc = pathData[1];
        handlerData[pathData[0]] = handlers.map(([h, paramCount]) => {
          const paramIndexMap = /* @__PURE__ */ Object.create(null);
          paramCount -= 1;
          for (; paramCount >= 0; paramCount--) {
            const [key, value] = paramAssoc[paramCount];
            paramIndexMap[key] = value;
          }
          return [h, paramIndexMap];
        });
      }
    });
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    for (let i = 0, len = handlerData.length; i < len; i++) {
      for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
        const map = handlerData[i][j]?.[1];
        if (!map) {
          continue;
        }
        const keys = Object.keys(map);
        for (let k = 0, len3 = keys.length; k < len3; k++) {
          map[keys[k]] = paramReplacementMap[map[keys[k]]];
        }
      }
    }
    const handlerMap = [];
    for (const i in indexReplacementMap) {
      handlerMap[i] = handlerData[indexReplacementMap[i]];
    }
    return [regexp, handlerMap, staticMap];
  }
}, "RegExpRouter");

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = /* @__PURE__ */ __name(class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
}, "SmartRouter");

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = /* @__PURE__ */ __name((children) => {
  for (const _ in children) {
    return true;
  }
  return false;
}, "hasChildren");
var Node2 = /* @__PURE__ */ __name(class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  node.#params,
                  params
                );
              }
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
}, "_Node");

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = /* @__PURE__ */ __name(class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
}, "TrieRouter");

// node_modules/hono/dist/hono.js
var Hono2 = /* @__PURE__ */ __name(class extends Hono {
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
}, "Hono");

// node_modules/hono/dist/middleware/cors/index.js
var cors = /* @__PURE__ */ __name((options) => {
  const opts = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "QUERY"],
    allowHeaders: [],
    exposeHeaders: [],
    ...options
  };
  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(",") : void 0;
  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(",") : void 0;
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") {
        return () => optsOrigin;
      } else {
        return (origin) => optsOrigin === origin ? origin : null;
      }
    } else if (typeof optsOrigin === "function") {
      return optsOrigin;
    } else {
      return (origin) => optsOrigin.includes(origin) ? origin : null;
    }
  })(opts.origin);
  const findAllowMethods = ((optsAllowMethods) => {
    if (typeof optsAllowMethods === "function") {
      return async (origin, c) => (await optsAllowMethods(origin, c)).join(",");
    } else if (Array.isArray(optsAllowMethods)) {
      const methodsStr = optsAllowMethods.join(",");
      return () => methodsStr;
    } else {
      return () => "";
    }
  })(opts.allowMethods);
  return /* @__PURE__ */ __name(async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    __name(set, "set");
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) {
      set("Access-Control-Allow-Origin", allowOrigin);
    }
    if (opts.credentials) {
      set("Access-Control-Allow-Credentials", "true");
    }
    if (exposeHeadersStr) {
      set("Access-Control-Expose-Headers", exposeHeadersStr);
    }
    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*") {
        set("Vary", "Origin");
      }
      if (opts.maxAge != null) {
        set("Access-Control-Max-Age", opts.maxAge.toString());
      }
      const allowMethods = await findAllowMethods(c.req.header("origin") || "", c);
      if (allowMethods) {
        set("Access-Control-Allow-Methods", allowMethods);
      }
      let headersStr = allowHeadersStr;
      if (!headersStr) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) {
          headersStr = requestHeaders.split(",").map((h) => h.trim()).join(",");
        }
      }
      if (headersStr) {
        set("Access-Control-Allow-Headers", headersStr);
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content"
      });
    }
    await next();
    if (opts.origin !== "*") {
      c.header("Vary", "Origin", { append: true });
    }
  }, "cors2");
}, "cors");

// src/uae-time.js
var UAE_TIME_ZONE = "Asia/Dubai";
function parsedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("valid UAE date required");
  return date;
}
__name(parsedDate, "parsedDate");
function isoToUaeLocalInput(value) {
  if (!value)
    return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: UAE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(parsedDate(value));
  const get = /* @__PURE__ */ __name((type) => parts.find((part) => part.type === type)?.value, "get");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
__name(isoToUaeLocalInput, "isoToUaeLocalInput");
function uaeLocalInputToIso(value) {
  const text = String(value || "").trim();
  if (!text)
    return null;
  const match2 = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match2)
    throw new Error("valid UAE date required");
  const [, year, month, day, hour, minute] = match2.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour - 4, minute));
  if (isoToUaeLocalInput(date.toISOString()) !== text)
    throw new Error("valid UAE date required");
  return date.toISOString();
}
__name(uaeLocalInputToIso, "uaeLocalInputToIso");
function formatUaeTime(value) {
  if (!value)
    return "\u2014";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UAE_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(parsedDate(value)) + " GST";
}
__name(formatUaeTime, "formatUaeTime");
var UAE_TIME_CLIENT_SOURCE = `
const UAE_TIME_ZONE = ${JSON.stringify(UAE_TIME_ZONE)};
${parsedDate.toString()}
${isoToUaeLocalInput.toString()}
${uaeLocalInputToIso.toString()}
${formatUaeTime.toString()}
`;

// src/playground.js
var PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Gateway \u2014 Admin</title>
<style>
  :root{
    --bg:#0b0d11; --surface:#11151c; --surface-hi:#161b24; --surface-deep:#0d1117;
    --line:#252c37; --line-hi:#364152; --text:#edf1f7; --muted:#8d98a8;
    --accent:#77a7ff; --accent-strong:#5f93f5; --good:#62d3a5; --warn:#e7bd67; --bad:#f07d7d;
    --radius:12px; --radius-sm:8px; --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
    --sans:"Segoe UI Variable","Segoe UI",ui-sans-serif,system-ui,sans-serif; --ease:cubic-bezier(.23,1,.32,1);
    /* Compatibility aliases for dynamically-rendered console rows. */
    --panel:var(--surface); --panel2:var(--surface-deep); --txt:var(--text); --mut:var(--muted); --acc:var(--accent); --ok:var(--good); --r:var(--radius); --inp:var(--radius-sm);
  }
  *{box-sizing:border-box} html,body{margin:0;min-height:100%}
  body{font:14px/1.48 var(--sans);background:var(--bg);color:var(--text);letter-spacing:.002em}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 0,transparent calc(100% - 1px),rgba(255,255,255,.018) calc(100% - 1px));background-size:72px 100%;opacity:.3}
  a{color:var(--accent)} button,input,select,textarea{font:inherit} button{white-space:nowrap}
  header{height:64px;display:flex;align-items:center;gap:16px;padding:0 24px;border-bottom:1px solid var(--line);background:rgba(11,13,17,.94);backdrop-filter:blur(16px);position:sticky;top:0;z-index:30}
  header .brand{display:flex;align-items:center;gap:10px;font-weight:680;font-size:15px;letter-spacing:-.015em}
  header .brand .dot{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:var(--accent);color:#0b0d11;font-size:13px;line-height:1;font-family:var(--mono)}
  header .base{margin-left:auto;max-width:42vw;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font:11px/1 var(--mono)}
  header .clock{padding-left:16px;border-left:1px solid var(--line);color:var(--muted);font:11px/1 var(--mono);font-variant-numeric:tabular-nums}
  nav{position:fixed;z-index:20;top:64px;bottom:0;left:0;width:216px;display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:18px 12px;background:var(--surface-deep);border-right:1px solid var(--line)}
  nav:before{content:"WORKSPACE";padding:0 10px 10px;color:#687384;font:10px/1 var(--mono);letter-spacing:.12em}
  nav button{position:relative;text-align:left;background:transparent;border:0;color:var(--muted);padding:9px 10px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:560;transition:background 160ms var(--ease),color 160ms var(--ease),transform 160ms var(--ease)}
  nav button:hover{color:var(--text);background:var(--surface-hi)} nav button:active{transform:scale(.98)}
  nav button.active{background:rgba(119,167,255,.14);color:var(--text)} nav button.active:before{content:"";position:absolute;left:-12px;top:9px;bottom:9px;width:2px;background:var(--accent)}
  main{position:relative;max-width:1540px;margin:0 auto 0 216px;padding:32px 36px 48px;min-height:calc(100vh - 64px)}
  .tab{display:none}.tab.active{display:block;animation:tab-in 180ms var(--ease)}@keyframes tab-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  h2.sec{font-size:14px;line-height:1.25;letter-spacing:-.012em;color:var(--text);margin:0 0 14px;font-weight:680;text-transform:none}
  .tab>h2.sec:first-child,.tab>.toolbar>h2.sec{font-size:20px;letter-spacing:-.03em}.tab>h2.sec:first-child:after,.tab>.toolbar>h2.sec:after{content:"";display:block;width:28px;height:2px;margin-top:10px;background:var(--accent)}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:16px;box-shadow:0 12px 28px rgba(0,0,0,.12)}
  .card[style*="padding:0"]{overflow:auto;background:var(--surface-deep)}
  label{display:block;font-size:11px;line-height:1.3;color:var(--muted);margin:0 0 6px;font-weight:620;letter-spacing:.025em}
  input,select,textarea{width:100%;background:#0c1016;border:1px solid var(--line);color:var(--text);border-radius:var(--radius-sm);padding:9px 10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.025);transition:border-color 160ms var(--ease),box-shadow 160ms var(--ease),background 160ms var(--ease)}
  input:hover,select:hover,textarea:hover{border-color:var(--line-hi)} input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(119,167,255,.13);background:#0e131a}
  input::placeholder,textarea::placeholder{color:#626d7c} textarea{min-height:108px;resize:vertical;font:12px/1.55 var(--mono)}
  .row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.row>.spacer{flex:0;min-width:0}
  button.act,button.ghost,button.danger{border-radius:var(--radius-sm);cursor:pointer;font-size:12px;font-weight:650;transition:transform 150ms var(--ease),background 150ms var(--ease),border-color 150ms var(--ease),color 150ms var(--ease)}
  button.act{background:var(--accent-strong);color:#07101f;border:1px solid var(--accent-strong);padding:9px 13px;margin-top:12px;box-shadow:0 6px 16px rgba(76,133,239,.18)}button.act:hover{background:#8bb4ff;border-color:#8bb4ff}button.act:active,button.ghost:active,button.danger:active{transform:scale(.97)}button.act:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  button.ghost{background:transparent;border:1px solid var(--line);color:var(--muted);padding:6px 10px}button.ghost:hover{color:var(--text);border-color:var(--line-hi);background:var(--surface-hi)}
  button.danger{background:transparent;border:1px solid rgba(240,125,125,.45);color:var(--bad);padding:6px 10px}button.danger:hover{background:rgba(240,125,125,.1);border-color:var(--bad)}
  table{width:100%;border-collapse:collapse;font-size:12.5px}#t-list{overflow-x:auto;border-radius:var(--radius-sm)}#t-list table{min-width:940px}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{position:sticky;top:0;background:var(--surface-deep);color:#727f91;font:10px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase}tbody tr{transition:background 130ms ease}tbody tr:hover{background:rgba(119,167,255,.055)}tbody tr:last-child td{border-bottom:0}
  .mono{font-family:var(--mono);font-size:11.5px;word-break:break-all}.pill{padding:3px 7px;border:1px solid transparent;border-radius:5px;font:10px/1.15 var(--mono);letter-spacing:.025em;display:inline-block}.pill.ok{background:rgba(98,211,165,.1);border-color:rgba(98,211,165,.2);color:var(--good)}.pill.bad{background:rgba(240,125,125,.1);border-color:rgba(240,125,125,.22);color:var(--bad)}.pill.warn{background:rgba(231,189,103,.1);border-color:rgba(231,189,103,.22);color:var(--warn)}.pill.mut{background:rgba(141,152,168,.09);border-color:rgba(141,152,168,.16);color:var(--muted)}.pill.acc{background:rgba(119,167,255,.1);border-color:rgba(119,167,255,.2);color:var(--accent)}
  .stat{position:relative;min-height:104px;background:transparent;border:1px solid var(--line);border-radius:var(--radius);padding:16px;overflow:hidden}.stat:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--line-hi)}.stat .k{color:var(--muted);font-size:11px;font-weight:600}.stat .v{font:700 26px/1.1 var(--mono);letter-spacing:-.06em;margin-top:13px;font-variant-numeric:tabular-nums}.stat .v.acc{color:var(--accent)}.stat .v.ok{color:var(--good)}.stat .v.bad{color:var(--bad)}
  .grid{display:grid;gap:12px}.grid.s4{grid-template-columns:repeat(4,minmax(0,1fr))}.grid.s3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid.s2{grid-template-columns:repeat(2,minmax(0,1fr))}
  .toast{position:fixed;right:22px;bottom:22px;background:#161b24;border:1px solid var(--line-hi);padding:11px 13px;border-radius:var(--radius-sm);opacity:0;transform:translateY(8px);transition:opacity 180ms var(--ease),transform 180ms var(--ease);pointer-events:none;max-width:360px;z-index:80;box-shadow:0 12px 28px rgba(0,0,0,.35)}.toast.show{opacity:1;transform:translateY(0)}.toast.err{border-color:var(--bad)}.toast.ok{border-color:var(--good)}
  .hint,.small{color:var(--muted);font-size:12px}.hint{margin:10px 0 0;line-height:1.5}.small{font-size:11px}.skeleton{background:linear-gradient(90deg,#151b24,#222a37,#151b24);background-size:200% 100%;animation:sk 1.1s linear infinite;color:transparent;border-radius:4px}@keyframes sk{to{background-position:-200% 0}}.empty{padding:34px 20px;text-align:center;color:var(--muted);font-size:12px;border:1px dashed var(--line-hi);border-radius:var(--radius-sm)}
  .overlay{position:fixed;inset:0;background:rgba(3,5,8,.72);backdrop-filter:blur(5px);display:none;align-items:center;justify-content:center;z-index:70;padding:24px}.overlay.show{display:flex}.modal{background:#11161e;border:1px solid var(--line-hi);border-radius:14px;padding:22px;width:480px;max-width:100%;max-height:90vh;overflow:auto;box-shadow:0 32px 80px rgba(0,0,0,.55)}.modal.trace-modal{width:min(1040px,100%)}.modal h3{margin:0 0 18px;font-size:17px;letter-spacing:-.025em}.modal pre{max-height:420px}.msg{display:flex;gap:10px;margin:10px 0}.msg .who{font-weight:650;min-width:62px}.msg.user .who{color:var(--accent)}.msg.assistant .who{color:var(--good)}
  pre{background:#0a0e14;border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;overflow:auto;max-height:340px;font:11.5px/1.58 var(--mono);white-space:pre-wrap;word-break:break-word}.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px}.toolbar .spacer{margin-left:auto}.seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden}.seg button{background:transparent;border:0;color:var(--muted);padding:6px 11px;cursor:pointer;font-size:11px}.seg button.on{background:var(--accent-strong);color:#07101f}
  @media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
  @media (max-width:980px){nav{position:sticky;top:64px;bottom:auto;width:100%;height:auto;flex-direction:row;overflow:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 14px}nav:before{display:none}nav button{flex:0 0 auto}nav button.active:before{left:10px;right:10px;top:auto;bottom:-8px;width:auto;height:2px}main{margin-left:0;padding:24px}.grid.s4{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:620px){header{padding:0 14px}.base{display:none}header .clock{margin-left:auto}.grid.s4,.grid.s3,.grid.s2{grid-template-columns:1fr}.row>*{min-width:100%}main{padding:18px 14px}.card{padding:16px}.toolbar{align-items:flex-start;flex-wrap:wrap}.toolbar .spacer{display:none}.modal{padding:16px}.toast{right:14px;left:14px;bottom:14px;max-width:none}}
  .pg-shell{display:grid;grid-template-columns:320px minmax(0,1fr);gap:18px;align-items:start}
  .pg-config{position:sticky;top:88px}
  .pg-check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;color:var(--text)}
  .pg-check input{width:auto;accent-color:var(--accent)}
  .pg-advanced{margin-top:16px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;background:var(--surface-deep)}
  .pg-advanced summary{cursor:pointer;font-size:12px;color:var(--muted);font-weight:620}
  .pg-advanced textarea{margin-top:10px;min-height:140px}
  .pg-main{display:grid;gap:18px;min-width:0}
  .pg-chat{display:flex;flex-direction:column;min-height:560px;overflow:hidden;padding:0}
  .pg-chat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line)}
  .pg-messages{flex:1;min-height:360px;max-height:520px;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:14px;background:var(--surface-deep)}
  .pg-msg{max-width:78%;padding:12px 14px;border-radius:14px;line-height:1.55}
  .pg-msg.user{align-self:flex-end;background:rgba(119,167,255,.14);border:1px solid rgba(119,167,255,.28);border-bottom-right-radius:4px}
  .pg-msg.assistant{align-self:flex-start;background:var(--surface-hi);border:1px solid var(--line);border-bottom-left-radius:4px}
  .pg-msg.streaming{border-style:dashed}
  .pg-msg .who{font:10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .pg-msg.user .who{color:var(--accent)}
  .pg-msg.assistant .who{color:var(--good)}
  .pg-body{white-space:pre-wrap;word-break:break-word}
  .pg-meta{margin-top:8px;font:10px/1.4 var(--mono);color:var(--muted)}
  .pg-composer{display:flex;gap:10px;align-items:flex-end;padding:16px 20px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-composer textarea{flex:1;min-height:44px;max-height:160px;resize:vertical}
  .pg-composer button{flex:0 0 auto;margin-top:0}
  .pg-trace{overflow:hidden}
  .pg-trace-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
  .pg-trace-tabs{display:flex;gap:6px;padding:12px 20px 0;flex-wrap:wrap}
  .seg-btn{background:var(--surface-deep);border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:6px 12px;font-size:11px;font-weight:620;cursor:pointer}
  .seg-btn.on{background:rgba(119,167,255,.16);border-color:var(--accent);color:var(--text)}
  .pg-trace-body{padding:16px 20px 20px}
  .pg-trace-body pre{max-height:320px}
  .pg-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .pg-summary .stat{min-height:86px;padding:12px}
  .pg-summary .stat .v{font-size:19px;margin-top:8px}
  .pg-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;font-size:12px;margin:14px 0 0}
  .pg-kv dt{color:var(--muted)}
  .pg-kv dd{margin:0;word-break:break-word}
  @media (max-width:980px){.pg-shell{grid-template-columns:1fr}.pg-config{position:static}.pg-messages{max-height:420px}.pg-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.pg-msg{max-width:100%}}
  /* Console refresh: operator layout, one accent, cards 14px, controls 9px, pills full. */
  .pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 18px}
  .pagehead h2.sec{font-size:22px;letter-spacing:-.03em;margin:0}
  .pagehead h2.sec:after{content:"";display:block;width:30px;height:2px;margin-top:10px;background:var(--accent)}
  .pagehead .sub{color:var(--muted);font-size:12.5px;margin:8px 0 0;max-width:62ch}
  .pagehead .actions{display:flex;gap:8px;flex:0 0 auto}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;margin-bottom:16px;overflow:hidden}
  .panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
  .panel-h h2.sec{margin:0;font-size:14px}
  .panel-b{padding:20px}
  .panel-b.flush{padding:0}
  .hero-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
  .hero-stats .stat{min-height:118px;padding:18px}
  .hero-stats .stat .v{font-size:32px}
  .hero-stats .stat .sub2{color:var(--muted);font-size:11px;margin-top:6px}
  .cols2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start}
  table tr th:first-child,table tr td:first-child{padding-left:20px}
  table tr th:last-child,table tr td:last-child{padding-right:20px}
  td.rowact{white-space:nowrap;text-align:right}
  .kvrow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
  .kvrow:last-child{border-bottom:0}
  .kvrow .grow{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .kvrow .right{margin-left:auto;flex:0 0 auto}
  .empty{border-style:solid;background:var(--surface-deep)}
  .empty .act{margin-top:12px}
  .form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .form-grid .full{grid-column:1/-1}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
  .modal-head h3{margin:0}
  .modal-x{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:9px;width:30px;height:30px;cursor:pointer;font-size:14px;line-height:1}
  .modal-x:hover{color:var(--text);border-color:var(--line-hi)}
  .modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
  .modal-foot .act{margin-top:0}
  #modal-body input,#modal-body select{margin-bottom:12px}
  #modal-body label{margin-top:2px}
  .trace-filters{display:grid;grid-template-columns:1.2fr 1.4fr 1.2fr 1.2fr .8fr auto;gap:12px;align-items:end}
  .pill{border-radius:999px}
  .toast{border-radius:10px}
  @media (max-width:1100px){.hero-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cols2{grid-template-columns:1fr}.trace-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:620px){.hero-stats{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.trace-filters{grid-template-columns:1fr}.pagehead{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot">G</span><span>Gateway</span><span style="color:var(--muted);font-weight:520">Control</span></div>
  <span class="base" id="base">\u2026</span>
  <span class="clock" id="clock"></span>
</header>
<nav>
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="providers">Providers</button>
  <button data-tab="routes">Model Routes</button>
  <button data-tab="tiers">Model Tiers</button>
  <button data-tab="keys">API Keys</button>
  <button data-tab="chat">Playground</button>
  <button data-tab="traces">Traces</button>
  <button data-tab="cache">Cache</button>
  <button data-tab="prices">Prices</button>
</nav>
<main>
  <section class="tab active" id="tab-overview">
    <div class="pagehead"><div><h2 class="sec">At a glance</h2><p class="sub">Live totals, recent runs, and the health of every upstream behind this gateway.</p></div></div>
    <div class="hero-stats" id="stats"></div>
    <div class="cols2">
      <div class="panel"><div class="panel-h"><h2 class="sec">Recent activity</h2></div><div class="panel-b flush" id="recent"></div></div>
      <div class="panel"><div class="panel-h"><h2 class="sec">Provider health</h2></div><div class="panel-b" id="ov-providers"></div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Egress health</h2><button class="ghost" id="ph-refresh">Refresh</button></div>
      <div class="panel-b" id="proxy-health"><span class="small">Loading egress status…</span></div>
    </div>
  </section>

  <section class="tab" id="tab-providers">
    <div class="pagehead"><div><h2 class="sec">Providers</h2><p class="sub">Upstream backends. Keys stay in the database. <span class="mono">auto</span> uses direct egress and the Koyeb relay only where separate egress is required; <span class="mono">proxy_url</span> keeps the legacy OCI path for rollback.</p></div><div class="actions"><button class="act" id="p-add" style="margin-top:0">Add provider</button></div></div>
    <div class="panel"><div class="panel-b flush" id="providers-list"></div></div>
  </section>

  <section class="tab" id="tab-routes">
    <div class="pagehead"><div><h2 class="sec">Model Routes</h2><p class="sub">Each public slug maps to one or more upstream models. Rank 0 is primary; higher ranks are failover. Clients only ever see the slug.</p></div><div class="actions"><button class="act" id="r-add" style="margin-top:0">Add route</button></div></div>
    <div class="panel"><div class="panel-b flush" id="routes-list"></div></div>
  </section>

  <section class="tab" id="tab-tiers">
    <div class="pagehead"><div><h2 class="sec">Model Tiers</h2><p class="sub">A tier is a reusable bundle of public model slugs. Assign one or more tiers to a key; per-key exclusions always win.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Create tier</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Tier name</label><input id="tier-name" placeholder="Builder"></div>
        <div><label>Public model slugs</label><select id="tier-slugs" multiple size="5"></select><small>Choose one or more currently enabled public models.</small></div>
        <div class="full"><button class="act" id="tier-create">Create tier</button></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="tiers-list"></div></div>
  </section>

  <section class="tab" id="tab-keys">
    <div class="pagehead"><div><h2 class="sec">API Keys</h2><p class="sub">Client credentials with budgets, rate limits, tier access, and model overrides.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Create key</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Name</label><input id="k-name" placeholder="my-app"></div>
        <div><label>Budget mode</label><select id="k-mode"><option value="usd">USD ($)</option><option value="tokens">Tokens</option></select></div>
        <div><label>Budget limit</label><input id="k-limit" type="number" step="any" placeholder="5.00"></div>
        <div><label>Request limit / minute</label><input id="k-rpm" type="number" min="1" step="1" placeholder="Unlimited"></div>
        <div><label>Expires at (UAE / GST)</label><input id="k-expiry" type="datetime-local"><small>UAE time (UTC+4). Blank means the key never expires.</small></div>
        <div><label>Model tiers</label><select id="k-tiers" multiple size="3"></select><small>Optional; choose one or more.</small></div>
        <div><label>Extra allowed models (comma list)</label><input id="k-models" placeholder="z-ai/glm-5.2"></div>
        <div><label>Excluded models (always override tiers and extra allows)</label><input id="k-excludes" placeholder="minimax/minimax-m3"></div>
      </div>
      <button class="act" id="k-create">Create Key</button>
      <div class="hint" id="k-out"></div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="keys-list"></div></div>
  </section>

  <section class="tab" id="tab-chat">
    <div class="pg-shell">
      <aside class="pg-config card">
        <h2 class="sec" style="margin-top:0">Playground</h2>
        <p class="hint">Run a model through the gateway with your admin session.</p>
        <label for="c-model">Model slug</label>
        <select id="c-model"><option value="">Loading enabled models...</option></select>
        <label class="pg-check" for="c-stream"><input type="checkbox" id="c-stream"> Stream responses</label>
        <button class="act" id="c-clear" style="margin-top:18px">Clear chat</button>
        <details class="pg-advanced">
          <summary>Request JSON</summary>
          <textarea id="c-messages">[{"role":"user","content":"Say hello in one sentence."}]</textarea>
        </details>
      </aside>
      <div class="pg-main">
        <section class="pg-chat card">
          <header class="pg-chat-head">
            <div>
              <h2 class="sec" style="margin:0">Conversation</h2>
              <div class="small" id="c-status">Ready when you are.</div>
            </div>
            <button class="ghost" id="c-copy-trace">Copy trace</button>
          </header>
          <div class="pg-messages" id="c-chat">
            <div class="empty">Send a message to start a run.</div>
          </div>
          <div class="pg-composer">
            <textarea id="c-prompt" placeholder="Ask anything..."></textarea>
            <button class="ghost" id="c-redo" title="Regenerate the last response">Regenerate</button>
            <button class="act" id="c-send">Send</button>
          </div>
        </section>
        <section class="pg-trace card" id="c-trace-panel" hidden>
          <header class="pg-trace-head">
            <div>
              <h2 class="sec" style="margin:0">Run trace</h2>
              <div class="small" id="c-trace-meta"></div>
            </div>
            <button class="ghost" id="c-close-trace">Close</button>
          </header>
          <div class="pg-trace-tabs" role="tablist">
            <button class="seg-btn on" data-trace-tab="summary" role="tab" aria-selected="true">Summary</button>
            <button class="seg-btn" data-trace-tab="request" role="tab" aria-selected="false">Request</button>
            <button class="seg-btn" data-trace-tab="response" role="tab" aria-selected="false">Response</button>
            <button class="seg-btn" data-trace-tab="events" role="tab" aria-selected="false">Events</button>
          </div>
          <div class="pg-trace-body" id="c-trace-body"></div>
        </section>
      </div>
    </div>
  </section>

  <section class="tab" id="tab-traces">
    <div class="pagehead"><div><h2 class="sec">Traces</h2><p class="sub">Every stored run. Exports include prompts and completions; treat downloads as sensitive.</p></div><div class="actions"><button class="ghost" id="t-export-json">Export JSON</button><button class="ghost" id="t-export-csv">Export CSV</button></div></div>
    <div class="panel"><div class="panel-b">
      <div class="trace-filters">
        <div><label>Key ID</label><input id="t-key" placeholder="sk-…"></div>
        <div><label>Search</label><input id="t-query" placeholder="trace, key, slug, provider"></div>
        <div><label>Model slug</label><input id="t-slug" placeholder="z-ai/glm-5.2"></div>
        <div><label>HTTP status</label><select id="t-status"><option value="all">All outcomes</option><option value="200">200 - success</option><option value="400">400 - request issue</option><option value="401">401 - auth issue</option><option value="403">403 - blocked</option><option value="429">429 - limited</option><option value="500">500 - gateway error</option><option value="503">503 - upstream unavailable</option></select></div>
        <div><label>Rows</label><input id="t-limit" type="number" value="100" min="1" max="500"></div>
        <div><button class="act" id="t-load" style="margin-top:0">Apply filters</button></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="t-list" style="margin-top:0"></div></div>
  </section>

  <section class="tab" id="tab-cache">
    <div class="card">
      <div class="toolbar"><h2 class="sec" style="margin:0">Response cache</h2><span class="spacer"></span><button class="ghost" id="cache-refresh">Refresh</button><button class="danger" id="cache-purge">Purge all</button></div>
      <p class="hint">Exact deterministic responses only. Clients opt in with <span class="mono">x-gateway-cache: true</span>. Cache entries are scoped to each API key.</p>
      <div class="grid s4" id="cache-stats"></div>
      <pre id="cache-policy" style="margin-top:14px"></pre>
    </div>
  </section>

  <section class="tab" id="tab-prices">
    <div class="card">
      <h2 class="sec" style="margin-top:0">Custom model prices (USD / 1M tokens)</h2>
      <p class="hint">Used to compute cost_usd for usage + traces when the upstream doesn't return a cost. Leave 0 for free. Keyed by model slug (e.g. <span class="mono">z-ai/glm-5.2</span>).</p>
      <div class="row" style="align-items:center">
        <div><label>Slug</label><input id="pr-slug" placeholder="z-ai/glm-5.2"></div>
        <div><label>Prompt $/1M</label><input id="pr-prompt" type="number" step="0.0001" placeholder="0"></div>
        <div><label>Completion $/1M</label><input id="pr-completion" type="number" step="0.0001" placeholder="0"></div>
        <button class="act" id="pr-save" style="flex:0 0 auto;margin-top:22px">Save price</button>
      </div>
      <div id="pr-list" style="margin-top:12px"></div>
    </div>
  </section>
</main>

<div class="overlay" id="overlay">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-head"><h3 id="modal-title">Modal</h3><button class="modal-x" id="modal-x" aria-label="Close">×</button></div>
    <div id="modal-body"></div>
    <div class="modal-foot">
      <button class="ghost" id="modal-cancel">Cancel</button>
      <button class="act" id="modal-save" style="margin-top:0">Save</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
${UAE_TIME_CLIENT_SOURCE}
const API = location.origin;
const NL = String.fromCharCode(10);
const toastEl = document.getElementById('toast');
function toast(msg, kind){ toastEl.textContent=msg; toastEl.className='toast show '+(kind||''); clearTimeout(toast._t); toast._t=setTimeout(function(){toastEl.className='toast';},2600); }
async function api(path, opts){ opts=opts||{}; const r=await fetch(API+path,{headers:{'Content-Type':'application/json'},credentials:'same-origin',...opts}); if(r.status===401){ setTimeout(()=>{location.href=API+'/_gw';},400); throw new Error('session expired'); } let d=null; try{d=await r.json();}catch(e){} return {status:r.status,data:d}; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmt(n){ n=Number(n)||0; return n.toLocaleString(undefined,{maximumFractionDigits:4}); }
function money(n){ return '$'+(Number(n)||0).toFixed(4); }
function statusPill(s){ s=Number(s)||0; if(s>=200&&s<400) return '<span class="pill ok">'+s+'</span>'; if(s===0) return '<span class="pill warn">err</span>'; return '<span class="pill bad">'+s+'</span>'; }

document.getElementById('base').textContent = API;
function tick(){ const el=document.getElementById('clock'); el.textContent=new Intl.DateTimeFormat('en-GB',{timeZone:UAE_TIME_ZONE,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date())+' GST'; }
tick(); setInterval(tick,1000);

// tabs
async function selectTab(t){
  document.querySelectorAll('nav button').forEach(function(x){x.classList.toggle('active',x.dataset.tab===t);});
  document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id==='tab-'+t);});
  if(t==='overview') await loadOverview();
  if(t==='providers') await loadProviders();
  if(t==='routes') await loadRoutes();
  if(t==='tiers') await loadTiers();
  if(t==='keys') await loadKeys();
  if(t==='chat') await refreshPlaygroundModels();
  if(t==='traces') await loadTraces();
  if(t==='cache') await loadCache();
  if(t==='prices') await loadPrices();
}
document.querySelectorAll('nav button').forEach(function(b){ b.onclick=function(){ selectTab(b.dataset.tab); }; });

// ---------- modal helper ----------
let modalSubmit=null;
function openModal(title, fields, onSubmit, saveLabel){
  document.querySelector('.modal').classList.remove('trace-modal');
  document.getElementById('modal-title').textContent=title;
  const body=document.getElementById('modal-body'); body.innerHTML='';
  const vals={};
  fields.forEach(function(f){
    const lab=document.createElement('label'); lab.textContent=f.label; body.appendChild(lab);
    let inp;
    if(f.type==='select'||f.type==='multiselect'){ inp=document.createElement('select'); if(f.type==='multiselect') inp.multiple=true; (f.options||[]).forEach(function(o){ const op=document.createElement('option'); op.value=o.value; op.textContent=o.label; if(f.type==='multiselect'&&Array.isArray(f.value)&&f.value.map(String).includes(String(o.value))) op.selected=true; inp.appendChild(op); }); }
    else if(f.type==='textarea'){ inp=document.createElement('textarea'); inp.rows=f.rows||4; }
    else { inp=document.createElement('input'); inp.type=f.type||'text'; }
    if(f.value!=null&&f.type!=='multiselect') inp.value=f.value;
    if(f.placeholder) inp.placeholder=f.placeholder;
    if(f.hint){ const h=document.createElement('div'); h.className='small'; h.style.margin='-6px 0 12px'; h.textContent=f.hint; body.appendChild(inp); body.appendChild(h); vals[f.key]=inp; return; }
    inp.dataset.key=f.key; body.appendChild(inp); vals[f.key]=inp;
  });
  modalSubmit=function(){ const out={}; fields.forEach(function(f){ out[f.key]=f.type==='multiselect'?Array.from(vals[f.key].selectedOptions).map(function(o){return o.value;}):vals[f.key].value; }); onSubmit(out); };
  document.getElementById('modal-save').textContent=saveLabel||'Save';
  document.getElementById('modal-save').style.display='';
  document.getElementById('overlay').classList.add('show');
  const first=body.querySelector('input,select,textarea'); if(first) setTimeout(function(){ try{first.focus();}catch(e){} },30);
}
function closeModal(){ document.getElementById('overlay').classList.remove('show'); modalSubmit=null; }
document.getElementById('modal-cancel').onclick=closeModal;
document.getElementById('modal-x').onclick=closeModal;
document.getElementById('modal-save').onclick=function(){ if(modalSubmit) modalSubmit(); };
document.getElementById('overlay').addEventListener('click',function(e){ if(e.target.id==='overlay') closeModal(); });
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&document.getElementById('overlay').classList.contains('show')) closeModal();
  if(e.key==='Enter'&&document.getElementById('overlay').classList.contains('show')&&modalSubmit&&/^(INPUT|SELECT)$/.test((document.activeElement||{}).tagName||'')){ e.preventDefault(); modalSubmit(); }
});
async function loadOverview(){
  const statsEl=document.getElementById('stats');
  statsEl.innerHTML='<div class="stat"><div class="k">loading</div><div class="v skeleton">----</div></div>';
  let data; try{ const res=await api('/admin/overview'); data=res.data; }catch(e){ statsEl.innerHTML='<div class="empty">Could not load overview: '+esc(e.message)+'</div>'; return; }
  if(!data) return;
  const ts=data.trace_stats||{}; const tot=data.totals||{};
  const stats=[
    {k:'Total requests', v:fmt(tot.requests), c:'acc', s:'all time'},
    {k:'Tokens used', v:fmt(tot.used_tokens), c:'', s:'all time'},
    {k:'Spend (USD)', v:money(tot.used_usd), c:'ok', s:'all time'},
    {k:'Errors', v:fmt(ts.errors), c:ts.errors>0?'bad':'', s:fmt(ts.total_traces)+' traces'},
    {k:'API keys', v:fmt((data.keys||[]).length), c:'', s:'configured'},
    {k:'Providers', v:fmt((data.providers||[]).length), c:'', s:'configured'},
    {k:'Model routes', v:fmt((data.routes||[]).length), c:'', s:'enabled paths'},
    {k:'Traces', v:fmt(ts.total_traces), c:'', s:'stored'}
  ];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+esc(s.k)+'</div><div class="v '+(s.c||'')+'">'+esc(s.v)+'</div><div class="sub2">'+esc(s.s||'')+'</div></div>';}).join('');
  const rec=(data.recent_traces||[]);
  document.getElementById('recent').innerHTML = rec.length ? '<table><tr><th>When</th><th>Slug</th><th>Provider</th><th>Tokens</th><th>Status</th></tr>'+rec.map(function(t){return '<tr><td class="mono">'+esc((t.created_at||'').replace('T',' ').slice(0,19))+'</td><td>'+esc(t.slug||'')+'</td><td>'+esc(t.provider_name||'')+'</td><td>'+fmt(t.total_tokens)+'</td><td>'+statusPill(t.status)+'</td></tr>';}).join('')+'</table>' : '<div class="empty" style="margin:20px">No traces yet. Send a request through the gateway.</div>';
  const ps=(data.providers||[]);
  document.getElementById('ov-providers').innerHTML = ps.length ? ps.map(function(p){
    const ok=(p.healthy&&p.last_status&&p.last_status>=200&&p.last_status<400); const cls=ok?'ok':(p.healthy?'warn':'bad');
    const label=ok?'healthy':(!p.healthy?'disabled':('HTTP '+(p.last_status||'—')));
    return '<div class="kvrow"><span class="pill '+cls+'">'+label+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.route_count||0)+' routes</span></div>';
  }).join('') : '<div class="empty">No providers.</div>';
  loadProxyHealth();
}
async function loadProxyHealth(){
  const el=document.getElementById('proxy-health'); el.innerHTML='<span class="small">Checking…</span>';
  let data; try{ const res=await api('/admin/proxy-health'); data=res.data; }catch(e){ el.innerHTML='<span class="small">Egress check failed: '+esc(e.message)+'</span>'; return; }
  if(!data){ el.innerHTML='<span class="small">Failed to load.</span>'; return; }
  const h=data.health||[];
  el.innerHTML = h.length ? h.map(function(p){
    if(p.transport==='koyeb'){ const ok=p.relay_reachable; return '<div class="kvrow"><span class="pill '+(ok?'ok':'bad')+'">'+(ok?'koyeb ok':'koyeb down')+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.relay_status||p.reason||'')+'</span></div>'; }
    if(!p.proxy) return '<div class="kvrow"><span class="pill mut">direct</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.reason||'')+'</span></div>';
    const ok=p.upstream_status && p.upstream_status>=200 && p.upstream_status<500;
    return '<div class="kvrow"><span class="pill '+(ok?'ok':'warn')+'">'+(ok?'proxy ok':'proxy reachable')+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">upstream '+p.upstream_status+'</span></div>';
  }).join('') : '<div class="empty">No providers configured.</div>';
}
var HEADER_PRESETS={
  none:'',
  openrouter:'HTTP-Referer: https://fsquarelabs.com\nX-Title: FSquare AI Gateway',
  claudecode:'anthropic-beta: claude-code-20250219',
  anthropicbeta:'anthropic-beta: prompt-caching-2024-07-31'
};
function headersToLines(json){
  try{ const o=typeof json==='string'?JSON.parse(json||'{}'):json||{}; return Object.keys(o).map(function(k){return k+': '+o[k];}).join('\n'); }catch(e){ return ''; }
}
function applyHeaderPreset(v){
  if(v.header_preset&&v.header_preset!=='custom'&&!(v.extra_headers||'').trim()) v.extra_headers=HEADER_PRESETS[v.header_preset]||'';
  delete v.header_preset; return v;
}
var HEADER_PRESET_OPTIONS=[{value:'none',label:'No preset'},{value:'openrouter',label:'OpenRouter app headers'},{value:'claudecode',label:'Claude Code beta'},{value:'anthropicbeta',label:'Anthropic prompt-caching beta'},{value:'custom',label:'Custom only'}];
  openModal('Add provider',[
    {key:'name',label:'Name',placeholder:'OpenRouter'},
    {key:'base_url',label:'Base URL',placeholder:'https://api.example.com/v1'},
    {key:'api_key',label:'API Key',type:'password',placeholder:'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',options:[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'}]},
    {key:'priority',label:'Priority (lower = first)',type:'number',value:'0'},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',placeholder:'http://user:pass@host:8080'},
    {key:'transport',label:'Transport',type:'select',value:'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from Worker'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
    {key:'header_preset',label:'Header preset',type:'select',value:'none',options:HEADER_PRESET_OPTIONS},
    {key:'extra_headers',label:'Extra upstream headers',type:'textarea',placeholder:'HTTP-Referer: https://example.com\nX-Title: My app',hint:'One Name: value per line. Sent to this provider on every request. Auth and content headers are managed automatically.'},
  ], async function(v){
    applyHeaderPreset(v);
    const {status,data}=await api('/admin/providers',{method:'POST',body:JSON.stringify(v)});
    if(status===201){ toast('provider created (id '+data.id+')','ok'); closeModal(); loadProviders(); }
    else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');
  });
};
async function editProvider(id){
  const {data}=await api('/admin/providers'); const p=(data.providers||[]).find(function(x){return x.id==id;}); if(!p) return;
  openModal('Edit provider',[
    {key:'name',label:'Name',value:p.name},
    {key:'base_url',label:'Base URL',value:p.base_url},
    {key:'api_key',label:'API Key',type:'password',placeholder: p.api_key_set ? '(set \u2014 leave blank to keep)' : 'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',value:p.fmt,options:[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'}]},
    {key:'priority',label:'Priority',type:'number',value:p.priority},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',value:p.proxy_url||''},
    {key:'transport',label:'Transport',type:'select',value:p.transport||'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from Worker'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
    {key:'header_preset',label:'Header preset',type:'select',value:'none',options:HEADER_PRESET_OPTIONS},
    {key:'extra_headers',label:'Extra upstream headers',type:'textarea',value:headersToLines(p.extra_headers),placeholder:'HTTP-Referer: https://example.com\nX-Title: My app',hint:'One Name: value per line. Sent to this provider on every request. Auth and content headers are managed automatically.'},
    {key:'notes',label:'Notes',value:p.notes||''},
    {key:'healthy',label:'State',type:'select',value:p.healthy?'1':'0',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.healthy = v.healthy==='1'; applyHeaderPreset(v);
    const {status,data:r}=await api('/admin/providers/'+id,{method:'PATCH',body:JSON.stringify(v)});
    if(status===200){ toast('provider updated','ok'); closeModal(); loadProviders(); }
    else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');
  });
}
async function toggleProvider(id, healthy){
  await api('/admin/providers/'+id+'/toggle',{method:'POST'}); loadProviders();
}
async function delProvider(id){
  if(!confirm('Delete provider '+id+' and its routes?')) return;
  const {status}=await api('/admin/providers/'+id,{method:'DELETE'});
  if(status===200){ toast('provider deleted','ok'); loadProviders(); } else toast('delete failed','err');
}

// ---------- ROUTES ----------
async function loadRoutes(){
  const {data}=await api('/admin/routes');
  const rows=(data.routes||[]).map(function(r){
    const cls=(r.enabled&&r.provider_healthy)?'ok':'bad';
    return '<tr><td class="mono">'+esc(r.slug)+'</td><td>rank '+r.rank+'</td><td>'+esc(r.provider_name||'')+'</td><td class="mono small">'+esc(r.upstream_model)+'</td><td><span class="pill '+cls+'">'+(r.enabled?'on':'off')+'</span></td>'+
      '<td><button class="ghost" data-act="redit" data-id="'+r.id+'">edit</button> <button class="ghost" data-act="rtoggle" data-id="'+r.id+'" data-e="'+r.enabled+'">'+(r.enabled?'disable':'enable')+'</button> <button class="danger" data-act="rdel" data-id="'+r.id+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="6"><div class="empty">No model routes yet.</div></td></tr>';
  document.getElementById('routes-list').innerHTML='<table><tr><th>Slug</th><th>Rank</th><th>Provider</th><th>Upstream model</th><th>Route</th><th></th></tr>'+rows+'</table>';
}
async function providerOptions(){
  const {data}=await api('/admin/providers'); return (data.providers||[]).map(function(p){return {value:String(p.id),label:esc(p.name)};});
}
document.getElementById('r-add').onclick=async function(){
  const opts=await providerOptions();
  if(!opts.length){ toast('create a provider first','err'); return; }
  openModal('Add model route',[
    {key:'slug',label:'Public slug (clients see this)',placeholder:'openai/gpt-4o-mini'},
    {key:'provider_id',label:'Provider',type:'select',options:opts},
    {key:'upstream_model',label:'Upstream model id',placeholder:'gpt-4o-mini'},
    {key:'rank',label:'Rank (0 = primary)',type:'number',value:'0'},
    {key:'enabled',label:'State',type:'select',value:'1',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    const {status,data}=await api('/admin/routes',{method:'POST',body:JSON.stringify(v)});
    if(status===201){ toast('route added','ok'); closeModal(); loadRoutes(); }
    else toast('add failed: '+(data&&data.error&&data.error.message||status),'err');
  });
};
async function editRoute(id){
  const {data}=await api('/admin/routes/'+id); const r=data.route; if(!r) return;
  const opts=await providerOptions();
  openModal('Edit model route',[
    {key:'slug',label:'Public slug',value:r.slug},
    {key:'provider_id',label:'Provider',type:'select',value:String(r.provider_id),options:opts},
    {key:'upstream_model',label:'Upstream model id',value:r.upstream_model},
    {key:'rank',label:'Rank',type:'number',value:r.rank},
    {key:'enabled',label:'State',type:'select',value:r.enabled?'1':'0',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    const {status,data:rr}=await api('/admin/routes/'+id,{method:'PATCH',body:JSON.stringify(v)});
    if(status===200){ toast('route updated','ok'); closeModal(); loadRoutes(); }
    else toast('update failed: '+(rr&&rr.error&&rr.error.message||status),'err');
  });
}
async function toggleRoute(id, enabled){
  await api('/admin/routes/'+id+'/toggle',{method:'POST'}); loadRoutes();
}
async function delRoute(id){
  if(!confirm('Delete route '+id+'?')) return;
  const {status}=await api('/admin/routes/'+id,{method:'DELETE'});
  if(status===200){ toast('route deleted','ok'); loadRoutes(); } else toast('delete failed','err');
}

// delegated clicks
document.addEventListener('click', function(e){
  const btn=e.target.closest('button[data-act]'); if(!btn) return;
  const id=btn.getAttribute('data-id'); const act=btn.getAttribute('data-act');
  if(act==='pedit') editProvider(id);
  else if(act==='ptoggle') toggleProvider(id, btn.getAttribute('data-h')==='1'?0:1);
  else if(act==='pdel') delProvider(id);
  else if(act==='redit') editRoute(id);
  else if(act==='rtoggle') toggleRoute(id, btn.getAttribute('data-e')==='1'?0:1);
  else if(act==='rdel') delRoute(id);
  else if(act==='tieredit') editTier(id);
  else if(act==='tierdel') delTier(id);
  else if(act==='copy') copyKey(id);
  else if(act==='kedit') editKey(id);
  else if(act==='ktoggle') toggleKey(id, btn.getAttribute('data-active')==='1'?0:1);
  else if(act==='kdel') delKey(id);
  else if(act==='viewtrace') viewTrace(id);
});

// ---------- MODEL TIERS ----------
async function publicModelOptions(){ const {data}=await api('/admin/routes'); return [...new Set((data&&data.routes||[]).filter(function(r){return r.enabled;}).map(function(r){return r.slug;}))].sort().map(function(slug){return {value:slug,label:slug};}); }
async function refreshTierSlugSelect(){ const select=document.getElementById('tier-slugs'); if(!select)return; const opts=await publicModelOptions(); select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('')||'<option disabled>No enabled public models</option>'; }
async function tierOptions(){ const {data}=await api('/admin/model-tiers'); return (data&&data.tiers||[]).map(function(t){return {value:String(t.id),label:t.name+' \u2014 '+t.models};}); }
async function refreshKeyTierSelect(){
  const select=document.getElementById('k-tiers'); if(!select) return;
  const opts=await tierOptions(); const selected=new Set(Array.from(select.selectedOptions).map(function(o){return o.value;}));
  select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'"'+(selected.has(o.value)?' selected':'')+'>'+esc(o.label)+'</option>';}).join('') || '<option disabled>No tiers created yet</option>';
}
async function loadTiers(){
  const {data}=await api('/admin/model-tiers'); const tiers=(data&&data.tiers)||[];
  const rows=tiers.map(function(t){return '<tr><td><b>'+esc(t.name)+'</b></td><td class="mono">'+esc(t.models)+'</td><td>'+fmt(t.key_count)+' keys</td><td><button class="ghost" data-act="tieredit" data-id="'+t.id+'">edit</button> <button class="danger" data-act="tierdel" data-id="'+t.id+'">delete</button></td></tr>';}).join('')||'<tr><td colspan="4"><div class="empty">No tiers yet.</div></td></tr>';
  document.getElementById('tiers-list').innerHTML='<table><tr><th>Tier</th><th>Public models</th><th>Assigned</th><th></th></tr>'+rows+'</table>';
  await Promise.all([refreshKeyTierSelect(),refreshTierSlugSelect()]);
}
async function editTier(id){
  const {data}=await api('/admin/model-tiers'); const t=(data&&data.tiers||[]).find(function(x){return Number(x.id)===Number(id);}); if(!t)return toast('tier not found','err');
  const opts=await publicModelOptions();
  openModal('Edit model tier',[{key:'name',label:'Tier name',value:t.name},{key:'models',type:'multiselect',label:'Public model slugs',value:t.models.split(',').map(function(s){return s.trim();}),options:opts}],async function(v){const {status,data:r}=await api('/admin/model-tiers/'+id,{method:'PATCH',body:JSON.stringify(v)});if(status===200){toast('tier updated','ok');closeModal();loadTiers();}else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');});
}
async function delTier(id){if(!confirm('Delete this tier? It will be removed from assigned keys.'))return;const {status}=await api('/admin/model-tiers/'+id,{method:'DELETE'});if(status===200){toast('tier deleted','ok');loadTiers();}else toast('delete failed','err');}
document.getElementById('tier-create').onclick=async function(){const body={name:document.getElementById('tier-name').value,models:Array.from(document.getElementById('tier-slugs').selectedOptions).map(function(o){return o.value;})};const {status,data}=await api('/admin/model-tiers',{method:'POST',body:JSON.stringify(body)});if(status===201){document.getElementById('tier-name').value='';Array.from(document.getElementById('tier-slugs').options).forEach(function(o){o.selected=false;});toast('tier created','ok');loadTiers();}else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');};

// ---------- KEYS ----------
function localExpiryValue(iso){
  try { return isoToUaeLocalInput(iso); } catch(e) { return ''; }
}
function expiryLabel(iso){
  if(!iso) return '<span class="pill mut">never</span>';
  let label=''; let ms=NaN;
  try { label=esc(formatUaeTime(iso)); ms=new Date(iso).getTime(); } catch(e) { return '<span class="pill bad">invalid</span>'; }
  return ms<=Date.now()?'<span class="pill bad">expired</span><div class="small">'+label+'</div>':'<span class="pill warn">expires</span><div class="small">'+label+'</div>';
}
async function loadKeys(){
  const {data}=await api('/admin/keys');
  await refreshKeyTierSelect();
  const rows=(data&&data.keys||[]).map(function(k){
    const used=k.budget_mode==='usd'?money(k.used_usd):fmt(k.used_tokens);
    const lim=k.budget_mode==='usd'?money(k.budget_limit):fmt(k.budget_limit);
    const am=k.allowed_models?esc(k.allowed_models):'<span class="pill mut">no extras</span>';
    const tiers=k.tier_names?esc(k.tier_names):'<span class="pill mut">none</span>';
    const excludes=k.excluded_models?esc(k.excluded_models):'<span class="pill mut">none</span>';
    const rpm=k.request_limit_per_minute?fmt(k.request_limit_per_minute)+'/min':'<span class="pill mut">unlimited</span>';
    const expiry=expiryLabel(k.expires_at);
    const active=(!k.active?'<span class="pill bad">off</span>':(k.expires_at&&new Date(k.expires_at).getTime()<=Date.now()?'<span class="pill bad">expired</span>':'<span class="pill ok">active</span>'));
    return '<tr><td><b>'+esc(k.name)+'</b><div class="mono small">'+esc(k.key_id)+'</div></td><td>'+used+' / '+lim+'</td><td>'+rpm+'</td><td>'+fmt(k.request_count)+'</td><td>'+tiers+'</td><td>'+am+'</td><td>'+excludes+'</td><td>'+expiry+'</td><td>'+active+'</td>'+
      '<td><button class="ghost" data-act="copy" data-id="'+esc(k.key_id)+'">copy</button> <button class="ghost" data-act="kedit" data-id="'+esc(k.key_id)+'">edit</button> <button class="ghost" data-act="ktoggle" data-id="'+esc(k.key_id)+'" data-active="'+(k.active?1:0)+'">'+(k.active?'deact':'act')+'</button> <button class="danger" data-act="kdel" data-id="'+esc(k.key_id)+'">del</button></td></tr>';
  }).join('') || '<tr><td colspan="10"><div class="empty">No keys yet.</div></td></tr>';
  document.getElementById('keys-list').innerHTML='<table><tr><th>Key</th><th>Budget</th><th>Rate</th><th>Reqs</th><th>Tiers</th><th>Extra allow</th><th>Excludes</th><th>Expiry</th><th>State</th><th></th></tr>'+rows+'</table>';
}
function copyKey(k){ navigator.clipboard.writeText(k).then(function(){toast('copied','ok');},function(){toast('copy failed','err');}); }
async function editKey(id){
  const {data}=await api('/admin/keys/'+encodeURIComponent(id)); const k=data&&data.key; if(!k) return toast('key not found','err');
  const tierOpts=await tierOptions(); const selectedTiers=(data.tiers||[]).map(function(t){return String(t.id);});
  openModal('Edit API key',[
    {key:'name',label:'Name',value:k.name},
    {key:'budget_mode',label:'Budget mode',type:'select',value:k.budget_mode,options:[{value:'usd',label:'USD ($)'},{value:'tokens',label:'Tokens'}]},
    {key:'budget_limit',label:'Budget limit',type:'number',value:k.budget_limit},
    {key:'request_limit_per_minute',label:'Request limit / minute (blank = unlimited)',type:'number',value:k.request_limit_per_minute||''},
    {key:'expires_at',label:'Expires at (UAE / GST, blank = never)',type:'datetime-local',value:localExpiryValue(k.expires_at)},
    {key:'tier_ids',label:'Model tiers (one or more)',type:'multiselect',value:selectedTiers,options:tierOpts},
    {key:'allowed_models',label:'Extra allowed models (comma list)',value:k.allowed_models||''},
    {key:'excluded_models',label:'Excluded models (always override tiers)',value:k.excluded_models||''},
    {key:'active',label:'State',type:'select',value:k.active?'1':'0',options:[{value:'1',label:'active'},{value:'0',label:'deactivated'}]}
  ],async function(v){
    v.active=v.active==='1'; v.request_limit_per_minute=v.request_limit_per_minute===''?0:Number(v.request_limit_per_minute);
    if(v.expires_at){ try { v.expires_at=uaeLocalInputToIso(v.expires_at); } catch(e) { return toast('invalid UAE expiry','err'); } } else v.expires_at=null;
    const {status,data:r}=await api('/admin/keys/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(v)});
    if(status===200){toast('key updated','ok');closeModal();loadKeys();}else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');
  });
}
async function toggleKey(id, active){ await api('/admin/keys/'+id+'/'+(active?'activate':'deactivate'),{method:'POST'}); loadKeys(); }
async function delKey(id){ if(!confirm('Delete '+id+'?')) return; await api('/admin/keys/'+id,{method:'DELETE'}); loadKeys(); }
document.getElementById('k-create').onclick=async function(){
  const rpm=document.getElementById('k-rpm').value;
  const rawExpiry=document.getElementById('k-expiry').value;
  let expires_at=null;
  if(rawExpiry){ try { expires_at=uaeLocalInputToIso(rawExpiry); } catch(e) { return toast('invalid UAE expiry','err'); } }
  const tier_ids=Array.from(document.getElementById('k-tiers').selectedOptions).map(function(o){return Number(o.value);});
  const body={name:document.getElementById('k-name').value, budget_mode:document.getElementById('k-mode').value, budget_limit:Number(document.getElementById('k-limit').value), request_limit_per_minute:rpm===''?0:Number(rpm), expires_at, tier_ids, allowed_models:document.getElementById('k-models').value, excluded_models:document.getElementById('k-excludes').value};
  if(!body.name||!body.budget_limit){ toast('name + limit required','err'); return; }
  const {status,data}=await api('/admin/keys',{method:'POST',body:JSON.stringify(body)});
  if(status===201){ document.getElementById('k-out').innerHTML='<b>Key:</b> <span class="mono">'+esc(data.key)+'</span>'; toast('key created','ok'); loadKeys(); }
  else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');
};

// ---------- CHAT ----------
let pgMessages=[], pgTrace=null, pgTraceTab='summary', pgLastTraceId='';
function playgroundDefaultMessages(){ return [{role:'user',content:'Say hello in one sentence.'}]; }
function setPlaygroundStatus(text){ const el=document.getElementById('c-status'); if(el) el.textContent=text; }
function renderPlaygroundMessages(messages){
  const el=document.getElementById('c-chat'); if(!el) return; el.innerHTML='';
  if(!messages.length){ el.innerHTML='<div class="empty">Send a message to start a run.</div>'; return; }
  messages.forEach(function(m){ appendPlaygroundMessage(m.role, m.content, m.meta); });
}
function appendPlaygroundMessage(role, text, meta){
  const el=document.getElementById('c-chat'); if(!el) return;
  const empty=el.querySelector('.empty'); if(empty) empty.remove();
  const d=document.createElement('div'); d.className='pg-msg '+(role==='user'?'user':'assistant');
  const who=document.createElement('div'); who.className='who'; who.textContent=role==='user'?'You':'Assistant';
  const body=document.createElement('div'); body.className='pg-body'; body.textContent=text||'(no content)';
  d.appendChild(who); d.appendChild(body);
  if(meta){ const me=document.createElement('div'); me.className='pg-meta'; me.textContent=meta; d.appendChild(me); }
  el.appendChild(d); el.scrollTop=el.scrollHeight;
  return d;
}
function appendStreamingMessage(){
  const d=appendPlaygroundMessage('assistant','',null); d.classList.add('streaming');
  const body=d.querySelector('.pg-body'); body.textContent='…';
  return { el:d, append:function(chunk){ if(body.textContent==='…') body.textContent=''; body.textContent+=chunk; const box=document.getElementById('c-chat'); box.scrollTop=box.scrollHeight; }, done:function(){ d.classList.remove('streaming'); } };
}
async function refreshPlaygroundModels(){
  const select=document.getElementById('c-model'); if(!select)return;
  const selected=select.value; const opts=await publicModelOptions();
  select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.label)+'</option>';}).join('') || '<option value="">No enabled public models</option>';
  if(!select.value&&select.options.length&&select.options[0].value) select.value=select.options[0].value;
}
document.getElementById('c-send').onclick=async function(){ await sendPlaygroundMessage(); };
document.getElementById('c-prompt').addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); sendPlaygroundMessage(); } });
document.getElementById('c-clear').onclick=function(){
  pgMessages=[]; pgTrace=null; pgLastTraceId='';
  document.getElementById('c-messages').value=JSON.stringify(playgroundDefaultMessages(),null,2);
  document.getElementById('c-prompt').value='';
  document.getElementById('c-trace-panel').hidden=true;
  renderPlaygroundMessages([]); setPlaygroundStatus('Ready when you are.');
};
document.getElementById('c-copy-trace').onclick=function(){
  const id=pgLastTraceId||((pgTrace&&pgTrace.trace_id)||'');
  if(!id){ toast('no trace yet','err'); return; }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(id).then(function(){toast('trace copied','ok');}); }
  else toast(id,'ok');
};
let pgLastRun=null;
function pgRateMeta(elapsedMs, totalTokens){
  const s=elapsedMs/1000; const tps=s>0&&totalTokens?Math.round(totalTokens/s):null;
  return s.toFixed(1)+'s'+(tps!=null?' · '+tps+' tok/s':'');
}
document.getElementById('c-redo').onclick=async function(){
  if(!pgLastRun){ toast('nothing to redo yet','err'); return; }
  await sendPlaygroundMessage(pgLastRun.prompt, pgLastRun.history);
};
async function sendPlaygroundMessage(promptOverride, historyOverride){
  const modelEl=document.getElementById('c-model'); const model=modelEl?modelEl.value.trim():'';
  const streamBox=document.getElementById('c-stream'); const stream=streamBox?streamBox.checked:false;
  const promptEl=document.getElementById('c-prompt'); const prompt=String(promptOverride!=null?promptOverride:(promptEl?promptEl.value:'')).trim();
  if(!model){ toast('choose a model','err'); return; }
  if(!prompt){ toast('write a prompt first','err'); return; }
  let history;
  if(historyOverride) history=historyOverride;
  else { try{ history=JSON.parse(document.getElementById('c-messages').value); if(!Array.isArray(history)) throw new Error('array'); }
  catch(e){ toast('Request JSON must be a messages array','err'); return; } }
  const messages=history.concat([{role:'user',content:prompt}]);
  document.getElementById('c-messages').value=JSON.stringify(messages,null,2);
  if(promptEl) promptEl.value='';
  pgMessages=messages; renderPlaygroundMessages(messages);
  pgLastRun={prompt:prompt,history:history.slice(),model:model,stream:stream};
  const trace=Math.random().toString(36).slice(2); pgLastTraceId=trace;
  setPlaygroundStatus('Running '+model+(stream?' (streaming)':'')+'…');
  const startedAt=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  const elapsed=function(){ return (((typeof performance!=='undefined'&&performance.now)?performance.now():Date.now())-startedAt)/1000; };
  try{
    const r=await fetch(API+'/admin/playground/completions',{method:'POST',headers:{'Content-Type':'application/json','x-trace-id':trace},credentials:'same-origin',body:JSON.stringify({model:model,messages:messages,stream:stream})});
    const traceId=r.headers.get('x-trace-id')||trace; pgLastTraceId=traceId;
    const usage=r.headers.get('x-gateway-used-usd')?('used '+r.headers.get('x-gateway-used-tokens')+' tokens / '+r.headers.get('x-gateway-used-usd')+' USD'):null;
    if(!r.ok){ const t=await r.text(); appendPlaygroundMessage('assistant','Request failed (HTTP '+r.status+'): '+t.slice(0,1200),'trace '+traceId+' · '+elapsed().toFixed(1)+'s'); setPlaygroundStatus('Failed: HTTP '+r.status); renderPlaygroundTraceError(traceId,t); return; }
    if(stream){
      const handle=appendStreamingMessage();
      const reader=r.body.getReader(); const dec=new TextDecoder(); let buf='', out='', su=null;
      while(true){ const res=await reader.read(); if(res.done)break; buf+=dec.decode(res.value,{stream:true});
        let i; while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
          if(line.indexOf('data:')===0){ const d=line.slice(5).trim(); if(d==='[DONE]')continue; try{ const o=JSON.parse(d); out+=(o.choices&&o.choices[0]&&o.choices[0].delta&&o.choices[0].delta.content||''); handle.append(o.choices&&o.choices[0]&&o.choices[0].delta&&o.choices[0].delta.content||''); if(o.usage) su=o.usage; }catch(e){} } } }
      handle.done();
      const toks=su?(su.total_tokens||((su.prompt_tokens||0)+(su.completion_tokens||0)))||null:null;
      const meta=pgRateMeta(elapsed()*1000,toks)+(usage?' · '+usage:'');
      pgMessages=messages.concat([{role:'assistant',content:out||'(no content)',meta:meta}]);
      appendPlaygroundMessage('assistant',out||'(no content)',meta);
      document.getElementById('c-messages').value=JSON.stringify(pgMessages,null,2);
    } else {
      const j=await r.json(); const content=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'(no content)';
      const ju=j.usage||{}; const jt=(ju.total_tokens||((ju.prompt_tokens||0)+(ju.completion_tokens||0)))||null;
      const meta=pgRateMeta(elapsed()*1000,jt)+(usage?' · '+usage:'');
      pgMessages=messages.concat([{role:'assistant',content:content,meta:meta}]);
      appendPlaygroundMessage('assistant',content,meta);
      document.getElementById('c-messages').value=JSON.stringify(pgMessages,null,2);
    }
    setPlaygroundStatus('Complete. Loading trace…');
    await loadTraceIntoPlayground(traceId);
  }catch(e){ toast('error: '+e.message,'err'); setPlaygroundStatus('Error: '+e.message); }
};
function addMsg(who,text){ appendPlaygroundMessage(who==='user'?'user':'assistant',text,null); }

// ---------- TRACES ----------
function traceQuery(limitCap){
  const limit=Math.min(limitCap,Math.max(1,Number(document.getElementById('t-limit').value)||100));
  const params=new URLSearchParams({limit:String(limit)});
  const fields=[['key_id','t-key'],['q','t-query'],['slug','t-slug'],['status','t-status']];
  fields.forEach(function(pair){ const value=document.getElementById(pair[1]).value.trim(); if(value&&value!=='all') params.set(pair[0],value); });
  return params;
}
async function loadTraces(){
  const {data}=await api('/admin/traces?'+traceQuery(500).toString());
  const rows=(data&&data.traces||[]).map(function(t){
    const cached=t.cache_hit?'<span class="pill acc">cache</span>':'<span class="pill mut">live</span>';
    return '<tr><td class="mono">'+esc(t.trace_id)+'</td><td class="mono">'+esc(t.key_id||'anonymous')+'</td><td class="mono">'+esc(t.slug)+'</td><td>'+cached+'</td><td>'+fmt(t.total_tokens)+'</td><td>'+money(t.cost_usd)+'</td><td>'+(t.duration_ms||0)+'ms</td><td>'+statusPill(t.status)+'</td><td><button class="ghost" data-act="viewtrace" data-id="'+esc(t.trace_id)+'">Inspect</button></td></tr>';
  }).join('') || '<tr><td colspan="9"><div class="empty">No traces match these filters.</div></td></tr>';
  document.getElementById('t-list').innerHTML='<table><tr><th>Trace</th><th>Key</th><th>Model</th><th>Source</th><th>Tokens</th><th>Cost</th><th>Time</th><th>Status</th><th></th></tr>'+rows+'</table>';
}
function traceTps(t){
  const s=(Number(t.duration_ms)||0)/1000; const n=Number(t.total_tokens)||0;
  if(!(s>0)||!n) return '—';
  return Math.round(n/s)+' tok/s';
}
function tracePanelHtml(t){
  const evts=(t.stream_events||[]);
  const summary='<div class="pg-summary">'
    +'<div class="stat"><div class="k">Status</div><div class="v">'+esc(t.status)+'</div></div>'
    +'<div class="stat"><div class="k">Tokens</div><div class="v">'+esc(fmt(t.total_tokens))+'</div></div>'
    +'<div class="stat"><div class="k">Rate</div><div class="v">'+esc(traceTps(t))+'</div></div>'
    +'<div class="stat"><div class="k">Duration</div><div class="v acc">'+esc((t.duration_ms||0)+'ms')+'</div></div></div>'
    +'<dl class="pg-kv"><dt>Provider</dt><dd>'+esc(t.provider_name||'—')+' <span class="mono small">'+esc(t.upstream_model||'')+'</span></dd>'
    +'<dt>Source</dt><dd>'+(t.cache_hit?'cache hit':'live upstream')+'</dd>'
    +'<dt>Cost</dt><dd>'+esc(money(t.cost_usd))+'</dd>'
    +(t.error?'<dt>Error</dt><dd>'+esc(String(t.error).slice(0,600))+'</dd>':'')+'</dl>';
  const req=t.request_body?traceJsonText(t.request_body):'(none)';
  const resp=t.error?String(t.error):(t.response_body?traceJsonText(t.response_body):'(none)');
  const ev=t.stream?(evts.length?JSON.stringify(evts,null,2):'(no stream events recorded)'):'(not a streamed run)';
  return {summary:summary,request:req,response:resp,events:ev};
}
function traceJsonText(s){ try{ const o=JSON.parse(s); return JSON.stringify(o,null,2); }catch(e){ return String(s); } }
function paintTraceBody(body,t,tab){
  const parts=tracePanelHtml(t);
  if(tab==='request'||tab==='response'||tab==='events'){ body.innerHTML='<pre>'+esc(parts[tab])+'</pre>'; return; }
  body.innerHTML=parts.summary;
}
function setTraceTabs(root,tab){
  root.querySelectorAll('[data-trace-tab]').forEach(function(b){
    const on=b.getAttribute('data-trace-tab')===tab;
    b.classList.toggle('on',on); b.setAttribute('aria-selected',on?'true':'false');
  });
}
function wireTraceTabs(root,getTrace){
  root.querySelectorAll('[data-trace-tab]').forEach(function(b){
    b.onclick=function(){ const t=getTrace(); if(!t) return; pgTraceTab=b.getAttribute('data-trace-tab'); setTraceTabs(root,pgTraceTab); paintTraceBody(root.querySelector('.pg-trace-body')||root, t, pgTraceTab); };
  });
}
function renderPlaygroundTrace(t){
  pgTrace=t; pgTraceTab='summary';
  const panel=document.getElementById('c-trace-panel'); if(!panel) return;
  panel.hidden=false;
  const meta=document.getElementById('c-trace-meta');
  if(meta) meta.textContent='trace '+t.trace_id+' | status '+t.status+' | '+(t.cache_hit?'cache hit':'live upstream')+' | '+(t.duration_ms||0)+'ms | '+fmt(t.total_tokens)+' tokens | '+money(t.cost_usd);
  setTraceTabs(panel,'summary');
  paintTraceBody(document.getElementById('c-trace-body'),t,'summary');
  wireTraceTabs(panel,function(){return pgTrace;});
  setPlaygroundStatus('Complete. Trace loaded inline.');
}
function renderPlaygroundTraceError(traceId,errText){
  const panel=document.getElementById('c-trace-panel'); if(!panel) return;
  panel.hidden=false;
  const meta=document.getElementById('c-trace-meta');
  if(meta) meta.textContent='trace '+traceId+' | failed before a trace was stored';
  setTraceTabs(panel,'response');
  document.getElementById('c-trace-body').innerHTML='<pre>'+esc(String(errText||'unknown error').slice(0,3000))+'</pre>';
  wireTraceTabs(panel,function(){return null;});
}
async function loadTraceIntoPlayground(id){
  setPlaygroundStatus('Complete. Loading trace…');
  try{
    const {status,data}=await api('/admin/traces/'+encodeURIComponent(id));
    const t=data&&data.trace;
    if(status!==200||!t){ renderPlaygroundTraceError(id,'Trace not stored yet. Open Traces and retry in a few seconds.'); return; }
    renderPlaygroundTrace(t);
  }catch(e){ renderPlaygroundTraceError(id,e.message); }
}
function appendTraceBlock(parent,label,value){
  const l=document.createElement('label'); l.textContent=label; parent.appendChild(l);
  const pre=document.createElement('pre'); pre.textContent=typeof value==='string'?value:JSON.stringify(value,null,2); parent.appendChild(pre);
}
async function viewTrace(id){
  try{
    const {status,data}=await api('/admin/traces/'+encodeURIComponent(id));
    const t=data&&data.trace; if(status!==200||!t){ toast('trace not found','err'); return; }
    modalSubmit=null; document.querySelector('.modal').classList.add('trace-modal'); document.getElementById('modal-title').textContent='Trace '+t.trace_id;
    document.getElementById('modal-save').style.display='none';
    const body=document.getElementById('modal-body'); body.innerHTML='';
    const meta=document.createElement('div'); meta.className='small'; meta.textContent='status '+t.status+' | '+(t.cache_hit?'cache hit':'live upstream')+' | '+(t.duration_ms||0)+'ms | '+fmt(t.total_tokens)+' tokens | '+money(t.cost_usd); body.appendChild(meta);
    const host=document.createElement('div'); host.className='pg-trace-tabs'; host.setAttribute('role','tablist');
    host.innerHTML='<button class="seg-btn on" data-trace-tab="summary" role="tab">Summary</button><button class="seg-btn" data-trace-tab="request" role="tab">Request</button><button class="seg-btn" data-trace-tab="response" role="tab">Response</button><button class="seg-btn" data-trace-tab="events" role="tab">Events</button>';
    body.appendChild(host);
    const content=document.createElement('div'); content.className='pg-trace-body'; content.style.padding='14px 0 0'; body.appendChild(content);
    let tab='summary';
    const paint=function(){ paintTraceBody(content,t,tab); };
    host.querySelectorAll('[data-trace-tab]').forEach(function(b){ b.onclick=function(){ tab=b.getAttribute('data-trace-tab'); setTraceTabs(host,tab); paint(); }; });
    paint();
    document.getElementById('overlay').classList.add('show');
  }catch(e){toast('trace load failed: '+e.message,'err');}
}
async function loadTraceBy(id){ await loadTraceIntoPlayground(id); }
function tryJson(s){ try{ return JSON.parse(s); }catch(e){ return s; } }
async function exportTraces(format){
  if(!confirm('This download includes sensitive prompts and completions. Continue?')) return;
  const q=traceQuery(1000); q.set('format',format);
  const r=await fetch(API+'/admin/traces/export?'+q.toString(),{credentials:'same-origin'}); if(!r.ok){toast('export failed: '+r.status,'err');return;}
  const blob=await r.blob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='gateway-traces.'+format; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); toast('sensitive export downloaded','ok');
}
document.getElementById('t-load').onclick=loadTraces;
document.getElementById('t-export-json').onclick=function(){exportTraces('json');};
document.getElementById('t-export-csv').onclick=function(){exportTraces('csv');};

// ---------- CACHE ----------
async function loadCache(){
  const {data}=await api('/admin/cache'); if(!data)return;
  const c=data.cache||{}; const stats=[{k:'Entries',v:fmt(c.entries)},{k:'Hits',v:fmt(c.hits),c:'acc'},{k:'Saved tokens',v:fmt(c.saved_tokens),c:'ok'},{k:'Saved USD',v:money(c.saved_usd),c:'ok'}];
  document.getElementById('cache-stats').innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+s.k+'</div><div class="v '+(s.c||'')+'">'+s.v+'</div></div>';}).join('');
  document.getElementById('cache-policy').textContent=JSON.stringify(data.policy||{},null,2);
}
document.getElementById('cache-refresh').onclick=loadCache;
document.getElementById('cache-purge').onclick=async function(){ if(!confirm('Purge every protected response cache entry? This cannot be undone.'))return; const {status,data}=await api('/admin/cache/purge',{method:'POST',body:JSON.stringify({confirm:'PURGE_ALL_CACHE'})}); if(status===200){toast('purged '+data.purged+' entries','ok');loadCache();}else toast('purge failed','err'); };

// ---------- prices ----------
async function loadPrices(){
  const {data}=await api('/admin/prices');
  const rows=(data&&data.prices||[]).map(function(p){
    return '<tr><td class="mono">'+esc(p.slug)+'</td><td>'+Number(p.prompt_per_1m||0)+'</td><td>'+Number(p.completion_per_1m||0)+'</td><td>'+(p.currency||'USD')+'</td><td><button class="ghost" data-act="prdel" data-slug="'+esc(p.slug)+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="5"><div class="empty">No prices set. Costs will be 0 unless the upstream returns them.</div></td></tr>';
  document.getElementById('pr-list').innerHTML='<table><tr><th>Slug</th><th>Prompt $/1M</th><th>Completion $/1M</th><th>Cur</th><th></th></tr>'+rows+'</table>';
}
document.getElementById('pr-save').onclick=async function(){
  const slug=document.getElementById('pr-slug').value.trim();
  if(!slug){ toast('slug required','err'); return; }
  const body=JSON.stringify({ slug, prompt_per_1m: document.getElementById('pr-prompt').value||0, completion_per_1m: document.getElementById('pr-completion').value||0 });
  const {status,data}=await api('/admin/prices',{method:'POST',body});
  if(status===200){ toast('price saved','ok'); loadPrices(); }
  else toast('save failed: '+(data&&data.error&&data.error.message||status),'err');
};
document.getElementById('pr-list').addEventListener('click',function(e){
  const b=e.target.closest('[data-act="prdel"]'); if(!b) return;
  api('/admin/prices/'+encodeURIComponent(b.dataset.slug),{method:'DELETE'}).then(function(){ loadPrices(); });
});

// init
loadOverview();
<\/script>
</body>
</html>`;

// src/index.js
var app = new Hono2();
app.use("/*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  await next();
});
app.use("/v1/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-trace-id", "x-gateway-cache", "x-gateway-cache-ttl"],
  exposeHeaders: ["x-trace-id", "x-gateway-cache", "x-gateway-used-usd", "x-gateway-used-tokens"]
}));
var encoder = new TextEncoder();
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function stableJson(value) {
  if (Array.isArray(value))
    return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
__name(stableJson, "stableJson");
function isCacheableRequest(payload, isStream, mode) {
  if (mode !== "true" && mode !== "refresh")
    return false;
  if (isStream || !payload || Number(payload.temperature) !== 0)
    return false;
  if (payload.tools || payload.functions || payload.tool_choice || payload.parallel_tool_calls)
    return false;
  return true;
}
__name(isCacheableRequest, "isCacheableRequest");
async function responseCacheKey(key, slug, payload) {
  const normalized = { ...payload, stream: false };
  return "rc:v1:" + await sha256hex(String(key.key_id) + "\n" + String(slug) + "\n" + stableJson(normalized));
}
__name(responseCacheKey, "responseCacheKey");
function isCacheableResponse(text) {
  try {
    const body = JSON.parse(text);
    return !!(body && typeof body === "object" && !body.error && Array.isArray(body.choices));
  } catch {
    return false;
  }
}
__name(isCacheableResponse, "isCacheableResponse");
async function serveCachedCompletion(c, { cached, traceId, key, slug, payload, started, state }) {
  await recordTrace(c, {
    traceId,
    key,
    slug,
    route: null,
    status: 200,
    error: null,
    stream: false,
    cacheHit: true,
    durationMs: Date.now() - started,
    requestBody: JSON.stringify(sanitizeRequest(payload)),
    responseBody: cached.response_body
  });
  await recordUsage(c, key, { total_tokens: 0, cost_usd: 0 });
  const hdrs = clientResponseHeaders(new Headers({ "content-type": "application/json; charset=utf-8" }), false);
  hdrs["x-trace-id"] = traceId;
  hdrs["x-gateway-cache"] = state || "HIT";
  return new Response(cached.response_body, { status: 200, headers: hdrs });
}
__name(serveCachedCompletion, "serveCachedCompletion");
function cacheTtlSeconds(c) {
  const requested = Number(c.req.header("x-gateway-cache-ttl") || 3600);
  return Number.isFinite(requested) ? Math.max(60, Math.min(86400, Math.floor(requested))) : 3600;
}
__name(cacheTtlSeconds, "cacheTtlSeconds");
function cacheExpiry(ttl) {
  return new Date(Date.now() + ttl * 1e3).toISOString().replace(".000", "");
}
__name(cacheExpiry, "cacheExpiry");
var RESPONSE_CACHE_LEASE_MS = 2e4;
var RESPONSE_CACHE_WAIT_MS = 15e3;
function cacheLeaseExpiry() {
  return new Date(Date.now() + RESPONSE_CACHE_LEASE_MS).toISOString().replace(".000", "");
}
__name(cacheLeaseExpiry, "cacheLeaseExpiry");
function cacheCoalesceDelayMs(attempt) {
  return Math.min(800, 75 * 2 ** Math.min(4, Math.max(0, attempt)));
}
__name(cacheCoalesceDelayMs, "cacheCoalesceDelayMs");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
async function acquireResponseCacheLease(c, cacheKey) {
  const leaseId = uuid();
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO response_cache_locks (cache_key, lease_id, expires_at) VALUES (?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET lease_id=excluded.lease_id, expires_at=excluded.expires_at
       WHERE response_cache_locks.expires_at<=?`
    ).bind(cacheKey, leaseId, cacheLeaseExpiry(), nowIso()).run();
    return Number(result && result.meta && result.meta.changes || 0) === 1 ? { acquired: true, leaseId } : { acquired: false, unavailable: false };
  } catch {
    return { acquired: false, unavailable: true };
  }
}
__name(acquireResponseCacheLease, "acquireResponseCacheLease");
async function releaseResponseCacheLease(c, cacheKey, leaseId) {
  if (!leaseId)
    return;
  try {
    await c.env.DB.prepare("DELETE FROM response_cache_locks WHERE cache_key=? AND lease_id=?").bind(cacheKey, leaseId).run();
  } catch {
  }
}
__name(releaseResponseCacheLease, "releaseResponseCacheLease");
function genSessionToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b)
    s += x.toString(16).padStart(2, "0");
  return "v1." + s;
}
__name(genSessionToken, "genSessionToken");
function genKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b)
    s += x.toString(16).padStart(2, "0");
  return "sk-" + s;
}
__name(genKey, "genKey");
function uuid() {
  return crypto.randomUUID();
}
__name(uuid, "uuid");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(".000", "");
}
__name(nowIso, "nowIso");
function bearerFrom(c) {
  const a = c.req.header("authorization");
  if (a && a.toLowerCase().startsWith("bearer "))
    return a.slice(7).trim();
  return c.req.header("x-api-key") || null;
}
__name(bearerFrom, "bearerFrom");
function isOverBudget(key) {
  return key.budget_mode === "usd" ? key.used_usd >= key.budget_limit : key.used_tokens >= key.budget_limit;
}
__name(isOverBudget, "isOverBudget");
function normalizeRequestLimit(value) {
  if (value === void 0 || value === null || value === "")
    return null;
  const n = Number(value);
  if (n === 0)
    return null;
  if (!Number.isInteger(n) || n < 1)
    throw new Error("request_limit_per_minute must be a positive integer or 0 for unlimited");
  return n;
}
__name(normalizeRequestLimit, "normalizeRequestLimit");
function normalizeKeyExpiry(value, nowMs = Date.now()) {
  const text = String(value == null ? "" : value).trim();
  if (!text)
    return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error("expires_at must be a valid ISO timestamp with timezone");
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms))
    throw new Error("expires_at must be a valid ISO timestamp with timezone");
  if (ms <= nowMs)
    throw new Error("expires_at must be in the future");
  return new Date(ms).toISOString().replace(".000", "");
}
__name(normalizeKeyExpiry, "normalizeKeyExpiry");
function isKeyExpired(key, at = nowIso()) {
  return !!(key && key.expires_at && String(key.expires_at) <= at);
}
__name(isKeyExpired, "isKeyExpired");
async function enforceRequestLimit(c, key) {
  const limit = normalizeRequestLimit(key.request_limit_per_minute);
  if (!limit)
    return null;
  const now = /* @__PURE__ */ new Date();
  const bucket = now.toISOString().slice(0, 16);
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1e3).toISOString().replace(".000", "");
  const row = await c.env.DB.prepare(
    `INSERT INTO api_key_rate_windows (key_id, bucket, request_count, expires_at) VALUES (?,?,1,?)
     ON CONFLICT(key_id,bucket) DO UPDATE SET request_count=request_count+1
     RETURNING request_count`
  ).bind(key.key_id, bucket, expiresAt).first();
  if (Number(row && row.request_count) > limit) {
    return c.json({ error: { message: "Request rate limit exceeded. Retry in the next minute.", type: "rate_limit_exceeded" } }, 429, { "retry-after": String(60 - now.getUTCSeconds()) });
  }
  return null;
}
__name(enforceRequestLimit, "enforceRequestLimit");
function fmt(n) {
  return Number(n).toLocaleString(void 0, { maximumFractionDigits: 6 });
}
__name(fmt, "fmt");
function bytesToB64url(bytes) {
  let s = "";
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(bytesToB64url, "bytesToB64url");
function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const s = atob(b64);
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
__name(b64urlToBytes, "b64urlToBytes");
async function providerCryptoKey(env, legacyAdminKey = false) {
  const secret = legacyAdminKey ? env.ADMIN_TOKEN : env.PROVIDER_CRYPTO_KEY || env.ADMIN_TOKEN;
  if (!secret)
    throw new Error("provider encryption unavailable");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("provider-key-v1:" + secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
__name(providerCryptoKey, "providerCryptoKey");
async function sealProviderKey(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await providerCryptoKey(env), encoder.encode(value));
  return "enc:v1:" + bytesToB64url(iv) + "." + bytesToB64url(new Uint8Array(ct));
}
__name(sealProviderKey, "sealProviderKey");
async function openProviderKey(env, value, legacyAdminKey = false) {
  const parts = String(value).split(":");
  if (parts.length !== 3 || parts[0] !== "enc" || parts[1] !== "v1")
    throw new Error("invalid provider key envelope");
  const pair = parts[2].split(".");
  if (pair.length !== 2)
    throw new Error("invalid provider key envelope");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(pair[0]) }, await providerCryptoKey(env, legacyAdminKey), b64urlToBytes(pair[1]));
  return new TextDecoder().decode(plain);
}
__name(openProviderKey, "openProviderKey");
async function providerKey(c, id) {
  try {
    const row = await c.env.DB.prepare("SELECT api_key FROM providers WHERE id=?").bind(id).first();
    if (row && row.api_key) {
      const stored = String(row.api_key);
      if (stored.startsWith("enc:v1:")) {
        try {
          return await openProviderKey(c.env, stored);
        } catch (e) {
          if (!c.env.PROVIDER_CRYPTO_KEY || !c.env.ADMIN_TOKEN)
            throw e;
          const legacyPlain = await openProviderKey(c.env, stored, true);
          await c.env.DB.prepare("UPDATE providers SET api_key=?, updated_at=? WHERE id=?").bind(await sealProviderKey(c.env, legacyPlain), nowIso(), id).run();
          console.log("PROVIDER_KEY re-encrypted id=" + id);
          return legacyPlain;
        }
      }
      const sealed = await sealProviderKey(c.env, stored);
      await c.env.DB.prepare("UPDATE providers SET api_key=?, updated_at=? WHERE id=?").bind(sealed, nowIso(), id).run();
      console.log("PROVIDER_KEY migrated id=" + id);
      return stored;
    }
  } catch (e) {
    console.log("PROVIDER_KEY unavailable id=" + id);
  }
  return c.env["PROVIDER_" + id + "_KEY"] || c.env["PROVIDER_" + (id - 1) + "_KEY"] || c.env.PROVIDER_KEY || c.env.UPSTREAM_API_KEY || null;
}
__name(providerKey, "providerKey");
function adminToken(c) {
  const a = c.req.header("authorization");
  if (a && a.toLowerCase().startsWith("bearer "))
    return a.slice(7).trim();
  const ck = c.req.header("cookie") || "";
  const m = ck.match(/(?:^|;\s*)gw_adm=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
__name(adminToken, "adminToken");
async function isAdmin(c) {
  const t = adminToken(c);
  if (!t)
    return false;
  if (t.startsWith("v1.")) {
    const h2 = await sha256hex(t);
    const row2 = await c.env.DB.prepare("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?").bind(h2, nowIso()).first();
    return !!row2;
  }
  const h = await sha256hex(t);
  if (c.env.ADMIN_TOKEN && await sha256hex(c.env.ADMIN_TOKEN) === h)
    return true;
  const row = await c.env.DB.prepare("SELECT 1 FROM admin_tokens WHERE token_hash=?").bind(h).first();
  return !!row;
}
__name(isAdmin, "isAdmin");
async function checkAdminPassword(password, env) {
  const secret = env && env.ADMIN_TOKEN || (typeof ADMIN_TOKEN !== "undefined" ? ADMIN_TOKEN : null);
  if (!password || !secret)
    return false;
  return await sha256hex(password) === await sha256hex(secret);
}
__name(checkAdminPassword, "checkAdminPassword");
async function allowAdminLoginAttempt(c) {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const ipHash = await sha256hex("admin-login:" + ip);
  const cutoff = new Date(Date.now() - 15 * 60 * 1e3).toISOString();
  await c.env.DB.prepare("DELETE FROM admin_login_attempts WHERE created_at < ?").bind(cutoff).run();
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts WHERE ip_hash=? AND created_at >= ?").bind(ipHash, cutoff).first();
  if (Number(row && row.n || 0) >= 8)
    return false;
  await c.env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash, created_at) VALUES (?,?)").bind(ipHash, nowIso()).run();
  return true;
}
__name(allowAdminLoginAttempt, "allowAdminLoginAttempt");
async function requireAdmin(c) {
  if (!await isAdmin(c))
    return c.json({ error: { message: "Admin authentication required", type: "auth_error" } }, 401);
  return null;
}
__name(requireAdmin, "requireAdmin");
app.get("/", (c) => c.json({
  service: "ai-gateway",
  note: "OpenAI-compatible API. Endpoints: /v1/models, /v1/chat/completions, /health."
}));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/v1/models", async (c) => {
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  const { key } = auth;
  const allowed = await allowedSlugs(c, key);
  const routes = await c.env.DB.prepare(
    "SELECT DISTINCT slug FROM model_routes WHERE enabled=1 AND slug IN (" + (allowed.map(() => "?").join(",") || "NULL") + ") ORDER BY slug"
  ).bind(...allowed).all();
  const data = (routes.results || []).map((r) => ({
    id: r.slug,
    object: "model",
    created: 0,
    owned_by: "gateway"
  }));
  return c.json({ object: "list", data });
});
app.get("/status", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const provs = await c.env.DB.prepare("SELECT * FROM providers ORDER BY priority").all();
  const status = [];
  for (const p of provs.results || []) {
    const key = await providerKey(c, p.id);
    let ok = false, code = null, err = null;
    if (!key) {
      err = "no key configured (PROVIDER_" + p.id + "_KEY)";
    } else {
      try {
        const r = await fetch(p.base_url + "/models", {
          headers: { Authorization: "Bearer " + key }
          // short timeout so status isn't slow
        });
        code = r.status;
        ok = r.ok;
      } catch (e) {
        err = String(e.message || e);
      }
    }
    status.push({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      priority: p.priority,
      fmt: p.fmt,
      healthy_flag: !!p.healthy,
      last_status: code,
      ok,
      error: err
    });
  }
  const routes = await c.env.DB.prepare(
    "SELECT mr.slug, mr.rank, mr.upstream_model, mr.enabled, p.name AS provider, p.healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  return c.json({ providers: status, routes: routes.results || [] });
});
app.post("/v1/chat/completions", async (c) => {
  const auth = await authClient(c);
  if (auth instanceof Response)
    return auth;
  return runChatCompletion(c, auth.key, false);
});
app.post("/admin/playground/completions", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  return runChatCompletion(c, null, true);
});
async function runChatCompletion(c, key, isAdminPlayground) {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }
  const slug = payload.model;
  if (!slug)
    return c.json({ error: { message: "model is required" } }, 400);
  if (!isAdminPlayground && !await slugAllowed(c, key, slug)) {
    const traceId2 = c.req.header("x-trace-id") || uuid();
    await recordTrace(c, {
      traceId: traceId2,
      key,
      slug,
      route: null,
      status: 403,
      error: "model_not_allowed: " + String(slug),
      stream: !!payload.stream,
      durationMs: Date.now() - Date.now(),
      requestBody: JSON.stringify(sanitizeRequest(payload)),
      responseBody: null
    });
    return c.json({ error: { message: 'Model "' + slug + '" is not enabled for this key', type: "model_not_allowed" } }, 403);
  }
  const routes = await c.env.DB.prepare(
    "SELECT mr.*, p.base_url, p.name AS provider_name, p.healthy, p.fmt, p.proxy_url, p.transport, p.extra_headers FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.slug=? AND mr.enabled=1 AND p.healthy=1 ORDER BY mr.rank"
  ).bind(slug).all();
  if (!routes.results || !routes.results.length) {
    return c.json({ error: { message: 'No healthy route for model "' + slug + '"', type: "no_route" } }, 503);
  }
  const traceId = c.req.header("x-trace-id") || uuid();
  const started = Date.now();
  const isStream = !!payload.stream;
  const cacheMode = String(c.req.header("x-gateway-cache") || "").toLowerCase();
  const cacheable = !!key && isCacheableRequest(payload, isStream, cacheMode);
  const cacheKey = cacheable ? await responseCacheKey(key, slug, payload) : null;
  if (cacheKey && cacheMode !== "refresh") {
    const cached = await lookupResponseCache(c, cacheKey);
    if (cached)
      return serveCachedCompletion(c, { cached, traceId, key, slug, payload, started, state: "HIT" });
  }
  let cacheLeaseId = null;
  if (cacheKey && cacheMode === "true") {
    const deadline = Date.now() + RESPONSE_CACHE_WAIT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      const lease = await acquireResponseCacheLease(c, cacheKey);
      if (lease.acquired) {
        cacheLeaseId = lease.leaseId;
        break;
      }
      if (lease.unavailable)
        break;
      await sleep(cacheCoalesceDelayMs(attempt++));
      const cached = await lookupResponseCache(c, cacheKey);
      if (cached)
        return serveCachedCompletion(c, { cached, traceId, key, slug, payload, started, state: "COALESCED" });
    }
  }
  if (isStream)
    payload.stream_options = { ...payload.stream_options || {}, include_usage: true };
  try {
    let lastErr = null;
    let attempts = 0;
    let lastRoute = null;
    for (const route of routes.results) {
      lastRoute = route;
      const key2 = await providerKey(c, route.provider_id);
      if (!key2) {
        lastErr = "provider " + route.provider_name + " has no key";
        attempts++;
        continue;
      }
      try {
        const res = await forwardToProvider(c, route, key2, payload, isStream, traceId);
        const up = res.response;
        c.env.DB.prepare("UPDATE providers SET last_status=?, last_checked=? WHERE id=?").bind(up.status, nowIso(), route.provider_id).run();
        if (!up.ok || !up.body) {
          const txt = await up.text();
          lastErr = "provider " + route.provider_name + " -> HTTP " + up.status + " [" + classifyUpstreamFailure(txt) + "] [" + transportLabel(routeTransport(route, c.env)) + "]";
          attempts++;
          continue;
        }
        if (!isStream) {
          const txt = await up.text();
          const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
          const costUsd = await computeCost(c, slug, usage);
          await recordTrace(c, {
            traceId,
            key,
            slug,
            route,
            status: up.status,
            error: null,
            stream: false,
            durationMs: Date.now() - started,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            costUsd,
            requestBody: JSON.stringify(sanitizeRequest(payload)),
            responseBody: sanitizeUpstreamResponse(txt)
          });
          const clientTxt = sanitizeClientResponse(txt, slug);
          if (isGenericUpstreamErrorResponse(clientTxt)) {
            await c.env.DB.prepare("UPDATE traces SET status=?, error=?, response_body=?, prompt_tokens=0, completion_tokens=0, total_tokens=0, cost_usd=0 WHERE trace_id=?").bind(503, "Malformed upstream completion envelope", clientTxt, traceId).run();
            const hdrs2 = clientResponseHeaders(new Headers({ "content-type": "application/json; charset=utf-8" }), false);
            hdrs2["x-trace-id"] = traceId;
            return new Response(clientTxt, { status: 503, headers: hdrs2 });
          }
          await recordUsage(c, key, { ...usage, cost_usd: costUsd });
          if (cacheKey && isCacheableResponse(clientTxt)) {
            await storeResponseCache(c, {
              cacheKey,
              keyId: key.key_id,
              slug,
              responseBody: clientTxt,
              sourceCostUsd: costUsd,
              sourceTokens: usage.total_tokens,
              ttl: cacheTtlSeconds(c)
            });
          }
          const hdrs = withGatewayHeaders(up.headers, key, usage);
          hdrs["x-trace-id"] = traceId;
          if (cacheKey)
            hdrs["x-gateway-cache"] = cacheMode === "refresh" ? "REFRESH" : "MISS";
          return new Response(clientTxt, { status: up.status, headers: hdrs });
        }
        const result = await handleStream(c, up, key, slug, route, traceId, payload, started, res.usage);
        return result;
      } catch (e) {
        lastErr = "provider " + route.provider_name + " -> " + String(e.message || e) + " [" + transportLabel(routeTransport(route, c.env)) + "]";
        attempts++;
      }
    }
    await recordTrace(c, {
      traceId,
      key,
      slug,
      route: lastRoute,
      status: 503,
      error: "All providers failed: " + (lastErr || "unknown"),
      stream: isStream,
      durationMs: Date.now() - started,
      requestBody: JSON.stringify(sanitizeRequest(payload)),
      responseBody: null
    });
    return c.json(genericUpstreamError(), 503);
  } finally {
    await releaseResponseCacheLease(c, cacheKey, cacheLeaseId);
  }
}
__name(runChatCompletion, "runChatCompletion");
async function forwardToProvider(c, route, apiKey, payload, isStream, traceId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
  const transport = routeTransport(route, c.env);
  if (transport === "oci" && route.proxy_url) {
    console.log("FWD proxy_url present len=" + route.proxy_url.length);
    const reqBody = JSON.stringify({ ...payload, model: route.upstream_model });
    const target = fmt2 === "anthropic" ? route.base_url + "/messages" : route.base_url + "/chat/completions";
    const headers = withExtraHeaders(fmt2 === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, route);
    return fetchViaProxy(route.proxy_url, target, "POST", headers, reqBody);
  }
  if (transport === "koyeb") {
    console.log("FWD koyeb provider=" + route.provider_name);
    return fetchViaKoyeb(c, route, apiKey, payload, isStream, traceId);
  }
  console.log("FWD DIRECT; route keys=" + Object.keys(route).join(",") + " proxy_url=" + route.proxy_url);
  if (fmt2 === "anthropic")
    return forwardAnthropic(c, route, apiKey, payload);
  return forwardOpenAI(c, route, apiKey, payload);
}
__name(forwardToProvider, "forwardToProvider");
var PROXY_TIMEOUT_MS = 20000;
async function fetchViaProxy(proxyUrl, targetUrl, method, headers, body) {
  const sep = proxyUrl.includes("?") ? "&" : "?";
  const fwd = proxyUrl + sep + "url=" + encodeURIComponent(targetUrl);
  const fwdHeaders = { ...headers };
  delete fwdHeaders["host"];
  delete fwdHeaders["content-length"];
  delete fwdHeaders["connection"];
  delete fwdHeaders["transfer-encoding"];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const r = await fetch(fwd, {
      method: method || "POST",
      headers: fwdHeaders,
      body: body || void 0,
      signal: ctrl.signal
    });
    let usage = null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      try {
        const txt = await r.clone().text();
        const p = JSON.parse(txt);
        if (p && p.usage)
          usage = usageFrom(p);
      } catch {
      }
    }
    return { response: r, usage };
  } catch (e) {
    if (e && e.name === "AbortError")
      throw new Error("proxy timeout after " + PROXY_TIMEOUT_MS + "ms");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchViaProxy, "fetchViaProxy");
var KOYEB_TUNNEL_VERSION = 1;
var KOYEB_CONNECT_TIMEOUT_MS = 30000;
var KOYEB_MAX_NONSTREAM_BYTES = 16777216;
function koyebCfg(env) {
  return {
    backend: String(env && env.RELAY_BACKEND || "koyeb").toLowerCase(),
    url: String(env && env.KOYEB_RELAY_URL || ""),
    secret: String(env && env.KOYEB_RELAY_SECRET || "")
  };
}
__name(koyebCfg, "koyebCfg");
function routeTransport(route, env) {
  const explicit = String(route.transport || "auto").toLowerCase();
  if (explicit === "direct")
    return "direct";
  if (explicit === "koyeb" || explicit === "oci") {
    if (explicit === "oci" && !route.proxy_url)
      return "direct";
    if (explicit === "koyeb") {
      const cfg = koyebCfg(env);
      if (!cfg.url || !cfg.secret)
        return route.proxy_url ? "oci" : "direct";
    }
    return explicit;
  }
  if (!route.proxy_url)
    return "direct";
  const cfg = koyebCfg(env);
  if (cfg.backend === "oci")
    return "oci";
  if (!cfg.url || !cfg.secret)
    return "oci";
  return "koyeb";
}
__name(routeTransport, "routeTransport");
function transportLabel(transport) {
  return transport === "direct" ? "DIRECT" : transport === "koyeb" ? "via-koyeb" : "via-proxy";
}
__name(transportLabel, "transportLabel");
function normalizeTransport(value) {
  const t = String(value == null ? "auto" : value).toLowerCase();
  if (t === "auto" || t === "direct" || t === "koyeb" || t === "oci")
    return t;
  throw new Error("transport must be auto, direct, koyeb, or oci");
}
__name(normalizeTransport, "normalizeTransport");
var EXTRA_HEADER_FORBIDDEN = ["authorization", "x-api-key", "content-type", "content-length", "host", "connection", "transfer-encoding", "cookie", "set-cookie", "proxy-authenticate", "proxy-authorization", "keep-alive", "upgrade", "te", "trailer"];
function normalizeExtraHeaders(value) {
  let obj = {};
  if (value == null || value === "")
    return "{}";
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{")) {
      try {
        obj = JSON.parse(text);
      } catch {
        throw new Error("extra_headers must be valid JSON or Name: value lines");
      }
    } else {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#"))
          continue;
        const i = t.indexOf(":");
        if (i < 1)
          throw new Error("extra_headers line needs Name: value (" + t.slice(0, 40) + ")");
        obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  } else if (typeof value === "object") {
    obj = value;
  } else {
    throw new Error("extra_headers must be an object or Name: value lines");
  }
  const out = {};
  const names = Object.keys(obj);
  if (names.length > 16)
    throw new Error("extra_headers allows at most 16 headers");
  for (const raw of names) {
    const name = String(raw).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name) || name.length > 64)
      throw new Error("bad extra header name: " + name.slice(0, 40));
    if (EXTRA_HEADER_FORBIDDEN.includes(name.toLowerCase()))
      throw new Error("extra header not allowed: " + name);
    const val = String(obj[raw] == null ? "" : obj[raw]);
    if (val.length > 512)
      throw new Error("extra header value too long: " + name);
    out[name] = val;
  }
  return JSON.stringify(out);
}
__name(normalizeExtraHeaders, "normalizeExtraHeaders");
function providerExtraHeaders(route) {
  try {
    const raw = route && route.extra_headers;
    if (!raw)
      return {};
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object")
      return {};
    const out = {};
    for (const k of Object.keys(obj)) {
      if (!EXTRA_HEADER_FORBIDDEN.includes(String(k).toLowerCase()))
        out[k] = String(obj[k]);
    }
    return out;
  } catch {
    return {};
  }
}
__name(providerExtraHeaders, "providerExtraHeaders");
function withExtraHeaders(headers, route) {
  const out = { ...headers };
  const extra = providerExtraHeaders(route);
  for (const k of Object.keys(extra)) {
    if (["content-type", "authorization", "x-api-key"].includes(k.toLowerCase()))
      continue;
    out[k] = extra[k];
  }
  return out;
}
__name(withExtraHeaders, "withExtraHeaders");
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");
async function sha256hexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha256hexBytes, "sha256hexBytes");
function koyebConnect(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          ws.close();
        } catch {
        }
        reject(new Error("connect timeout"));
      }
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.addEventListener("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error("connect failed"));
      }
    });
  });
}
__name(koyebConnect, "koyebConnect");
async function koyebExchange(c, opts) {
  const cfg = koyebCfg(c.env);
  const bodyHash = await sha256hexBytes(opts.body);
  const timestamp = String(Date.now());
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  let nonce = "";
  for (const b of nonceBytes)
    nonce += b.toString(16).padStart(2, "0");
  const canonical = ["v1", timestamp, nonce, opts.traceId, opts.provider, opts.method, opts.path, "", bodyHash].join("\n");
  const signature = await hmacHex(cfg.secret, canonical);
  let ws = null;
  let attempt = 0;
  const t0 = Date.now();
  for (; ;) {
    try {
      ws = await koyebConnect(cfg.url, KOYEB_CONNECT_TIMEOUT_MS);
      break;
    } catch (e) {
      if (++attempt >= 3)
        throw new Error("koyeb relay unreachable: " + String(e && e.message || e));
      await sleep(500 * attempt + Math.floor(Math.random() * 250 * attempt));
    }
  }
  const connectMs = Date.now() - t0;
  try {
    ws.binaryType = "arraybuffer";
    const queue = [];
    let waiter = null;
    let tunnelClosed = false;
    ws.addEventListener("message", (ev) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(ev.data);
      } else {
        queue.push(ev.data);
      }
    });
    ws.addEventListener("close", () => {
      tunnelClosed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(new Error("koyeb tunnel closed"));
      }
    });
    const nextFrame = () => {
      if (queue.length)
        return Promise.resolve(queue.shift());
      if (tunnelClosed)
        return Promise.reject(new Error("koyeb tunnel closed"));
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    };
    ws.send(JSON.stringify({ type: "open", version: KOYEB_TUNNEL_VERSION, requestId: opts.traceId, provider: opts.provider, method: opts.method, path: opts.path, query: "", headers: opts.headers, bodySha256: bodyHash, bodyLen: opts.body.length, timestamp, nonce, signature }));
    for (let off = 0; off < opts.body.length; off += 65536)
      ws.send(opts.body.slice(off, off + 65536));
    ws.send(JSON.stringify({ type: "request_end", requestId: opts.traceId }));
    let status = 0;
    let respHeaders = {};
    let firstByteAt = 0;
    let streamController = null;
    let stream = null;
    if (opts.isStream) {
      stream = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          try {
            ws.close();
          } catch {
          }
        }
      });
    }
    const chunks = [];
    let received = 0;
    for (; ;) {
      const msg = await nextFrame();
      if (typeof msg === "string") {
        let frame = null;
        try {
          frame = JSON.parse(msg);
        } catch {
          throw new Error("koyeb relay sent malformed frame");
        }
        if (frame.type === "accepted")
          continue;
        if (frame.type === "response") {
          status = Number(frame.status) || 0;
          continue;
        }
        if (frame.type === "response_end")
          break;
        if (frame.type === "error")
          throw new Error("koyeb relay: " + String(frame.code || "error") + ": " + String(frame.message || "unknown"));
        continue;
      }
      const bytes = new Uint8Array(msg);
      if (!firstByteAt)
        firstByteAt = Date.now();
      if (opts.isStream) {
        try {
          streamController.enqueue(bytes);
        } catch {
          break;
        }
      } else {
        received += bytes.length;
        if (received > KOYEB_MAX_NONSTREAM_BYTES) {
          try {
            ws.close();
          } catch {
          }
          throw new Error("koyeb response exceeded size limit");
        }
        chunks.push(bytes);
      }
    }
    try {
      ws.close();
    } catch {
    }
    let body = null;
    if (!opts.isStream) {
      body = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
    }
    return { status, headers: respHeaders, stream, bytes: body, connectMs, ttfbMs: firstByteAt ? firstByteAt - t0 : 0 };
  } catch (e) {
    try {
      ws.close();
    } catch {
    }
    throw e;
  }
}
__name(koyebExchange, "koyebExchange");
function anthropicRequestBody(route, payload) {
  const { system, msgs } = toAnthropicMessages(payload.messages || [], payload.system);
  const maxTokens = payload.max_tokens || 1024;
  return {
    model: route.upstream_model,
    messages: msgs,
    max_tokens: maxTokens,
    ...system ? { system } : {},
    ...payload.temperature != null ? { temperature: payload.temperature } : {},
    ...payload.top_p != null ? { top_p: payload.top_p } : {},
    ...payload.stream ? { stream: true } : {}
  };
}
__name(anthropicRequestBody, "anthropicRequestBody");
async function fetchViaKoyeb(c, route, apiKey, payload, isStream, traceId) {
  const fmt2 = (route.fmt || "openai").toLowerCase();
  const provider = String(route.provider_name || "").toLowerCase();
  let basePath = "";
  try {
    basePath = new URL(route.base_url).pathname.replace(/\/+$/, "");
  } catch {
    basePath = "";
  }
  const targetPath = basePath + (fmt2 === "anthropic" ? "/messages" : "/chat/completions");
  const headers = withExtraHeaders(fmt2 === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } : { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, route);
  const reqBody = fmt2 === "anthropic" ? JSON.stringify(anthropicRequestBody(route, payload)) : JSON.stringify({ ...payload, model: route.upstream_model });
  const res = await koyebExchange(c, { provider, method: "POST", path: targetPath, headers, body: encoder.encode(reqBody), isStream, traceId });
  const upHeaders = { "content-type": res.headers["content-type"] || (isStream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8") };
  if (res.headers["retry-after"])
    upHeaders["retry-after"] = res.headers["retry-after"];
  if (fmt2 === "anthropic") {
    if (isStream) {
      const wrapped = wrapAnthropicStream(new Response(res.stream, { headers: upHeaders }), route.upstream_model);
      return { response: wrapped, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } };
    }
    const txt = new TextDecoder().decode(res.bytes);
    try {
      const oai = fromAnthropic(JSON.parse(txt), route.upstream_model);
      return { response: new Response(JSON.stringify(oai), { status: res.status, headers: { "content-type": "application/json" } }), usage: oai.usage };
    } catch {
    }
    return { response: new Response(res.bytes, { status: res.status, headers: upHeaders }), usage: null };
  }
  const up = new Response(isStream ? res.stream : res.bytes, { status: res.status, headers: upHeaders });
  let usage = null;
  if (!isStream && res.bytes) {
    try {
      const p = JSON.parse(new TextDecoder().decode(res.bytes));
      if (p && p.usage)
        usage = usageFrom(p);
    } catch {
    }
  }
  return { response: up, usage };
}
__name(fetchViaKoyeb, "fetchViaKoyeb");
async function forwardOpenAI(c, route, apiKey, payload) {
  const up = await fetch(route.base_url + "/chat/completions", {
    method: "POST",
    headers: withExtraHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      ...c.env.UPSTREAM_HTTP_REFERER ? { "HTTP-Referer": c.env.UPSTREAM_HTTP_REFERER } : {},
      ...c.env.UPSTREAM_APP_TITLE ? { "X-Title": c.env.UPSTREAM_APP_TITLE } : {}
    }, route),
    body: JSON.stringify({ ...payload, model: route.upstream_model })
  });
  let usage = null;
  if (up.ok && up.body) {
    const ct = up.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
    } else {
      const txt = await up.clone().text();
      try {
        const p = JSON.parse(txt);
        if (p.usage)
          usage = usageFrom(p);
      } catch {
      }
    }
  }
  return { response: up, usage };
}
__name(forwardOpenAI, "forwardOpenAI");
var ANTHROPIC_VERSION = "2023-06-01";
function toAnthropicMessages(messages, fallbackSystem) {
  const msgs = [];
  let system = fallbackSystem;
  for (const m of messages) {
    if (m.role === "system") {
      system = m.content;
      continue;
    }
    if (m.role === "assistant") {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []).filter((b) => b.type !== "tool_use").map((b) => b.type === "text" ? b : { type: b.type, ...b });
      msgs.push({ role: "assistant", content: blocks });
    } else {
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
      msgs.push({ role: "user", content });
    }
  }
  return { system, msgs };
}
__name(toAnthropicMessages, "toAnthropicMessages");
function fromAnthropic(body, model) {
  const text = (body.content || []).map((b) => b.type === "text" ? b.text : "").join("");
  const stop = body.stop_reason === "max_tokens" ? "length" : body.stop_reason || "stop";
  return {
    id: body.id || "cmpl-anthropic",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: stop }],
    usage: {
      prompt_tokens: body.usage ? body.usage.input_tokens : 0,
      completion_tokens: body.usage ? body.usage.output_tokens : 0,
      total_tokens: body.usage ? body.usage.input_tokens + body.usage.output_tokens : 0,
      cost_usd: 0
    }
  };
}
__name(fromAnthropic, "fromAnthropic");
function fromAnthropicStreamChunk(obj, model) {
  if (obj.type === "content_block_delta" && obj.delta && obj.delta.type === "text_delta") {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { content: obj.delta.text } }]
    };
  }
  if (obj.type === "message_start") {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant" } }]
    };
  }
  if (obj.type === "message_delta" && obj.usage) {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {} }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: obj.usage.output_tokens || 0,
        total_tokens: obj.usage.output_tokens || 0,
        cost_usd: 0
      }
    };
  }
  if (obj.type === "message_stop")
    return null;
  return { id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {} }] };
}
__name(fromAnthropicStreamChunk, "fromAnthropicStreamChunk");
async function forwardAnthropic(c, route, apiKey, payload) {
  const reqBody = anthropicRequestBody(route, payload);
  const up = await fetch(route.base_url + "/messages", {
    method: "POST",
    headers: withExtraHeaders({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...c.env.UPSTREAM_APP_TITLE ? { "anthropic-title": c.env.UPSTREAM_APP_TITLE } : {}
    }, route),
    body: JSON.stringify(reqBody)
  });
  if (up.ok && up.body) {
    const ct = up.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const wrapped = wrapAnthropicStream(up, route.upstream_model);
      return { response: wrapped, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } };
    }
    const txt = await up.text();
    try {
      const p = JSON.parse(txt);
      const oai = fromAnthropic(p, route.upstream_model);
      return { response: new Response(JSON.stringify(oai), { status: up.status, headers: { "content-type": "application/json" } }), usage: oai.usage };
    } catch {
    }
  }
  return { response: up, usage: null };
}
__name(forwardAnthropic, "forwardAnthropic");
function wrapAnthropicStream(upReq, model) {
  const reader = upReq.body.getReader();
  const dec = new TextDecoder();
  return new Response(new ReadableStream({
    async start(controller) {
      let buf = "";
      const enc = encoder;
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:"))
              continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]")
              continue;
            let obj;
            try {
              obj = JSON.parse(data);
            } catch {
              continue;
            }
            const chunk = fromAnthropicStreamChunk(obj, model);
            if (chunk)
              controller.enqueue(enc.encode("data: " + JSON.stringify(chunk) + "\n\n"));
          }
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        try {
          controller.error(e);
        } catch {
        }
      }
    }
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
__name(wrapAnthropicStream, "wrapAnthropicStream");
async function handleStream(c, upReq, key, slug, route, traceId, payload, started, usageHint) {
  const reader = upReq.body.getReader();
  const dec = new TextDecoder();
  const enc = encoder;
  let controllerRef = null;
  let clientCancelled = false;
  let persisted = false;
  let buf = "";
  let streamError = null;
  let lastUsage = usageHint || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
  let lastChunkJson = null;
  const streamEvents = [];
  let malformedSseSent = false;
  const keepAlive = /* @__PURE__ */ __name((promise) => {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function")
      ctx.waitUntil(promise);
  }, "keepAlive");
  const persistOnce = /* @__PURE__ */ __name(async () => {
    if (persisted)
      return;
    persisted = true;
    const costUsd = await computeCost(c, slug, lastUsage);
    await recordTrace(c, {
      traceId,
      key,
      slug,
      route,
      status: upReq.status,
      error: streamError,
      stream: true,
      durationMs: Date.now() - started,
      promptTokens: lastUsage.prompt_tokens,
      completionTokens: lastUsage.completion_tokens,
      totalTokens: lastUsage.total_tokens,
      costUsd,
      requestBody: JSON.stringify(sanitizeRequest(payload)),
      responseBody: JSON.stringify({ stream_event_count: streamEvents.length, final_event: lastChunkJson })
    });
    await recordTraceEvents(c, traceId, streamEvents);
    await recordUsage(c, key, { ...lastUsage, cost_usd: costUsd });
    console.log("TRACE stream persisted id=" + traceId + " tokens=" + lastUsage.total_tokens + " cancelled=" + clientCancelled);
  }, "persistOnce");
  const safeEnqueue = /* @__PURE__ */ __name((text) => {
    if (clientCancelled || !controllerRef)
      return;
    try {
      controllerRef.enqueue(enc.encode(text));
    } catch {
      clientCancelled = true;
    }
  }, "safeEnqueue");
  const pump = /* @__PURE__ */ __name(async () => {
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:"))
            continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]")
            continue;
          try {
            const obj = JSON.parse(data);
            const u = usageFrom(obj);
            if (u && (u.total_tokens || u.completion_tokens || u.prompt_tokens))
              lastUsage = u;
            if (obj && obj.model && slug)
              obj.model = slug;
            sanitizeClientObject(obj);
            lastChunkJson = JSON.stringify(obj);
            streamEvents.push(lastChunkJson);
            safeEnqueue("data: " + lastChunkJson + "\n\n");
          } catch {
            if (!malformedSseSent) {
              malformedSseSent = true;
              streamError = "malformed upstream SSE payload";
              const safeError = JSON.stringify(genericUpstreamError());
              streamEvents.push(safeError);
              safeEnqueue("data: " + safeError + "\n\n");
            }
          }
        }
      }
      streamEvents.push("[DONE]");
      if (!clientCancelled) {
        safeEnqueue("data: [DONE]\n\n");
        try {
          controllerRef.close();
        } catch {
        }
      }
    } catch (e) {
      streamError = String(e && e.message || e).slice(0, 4e3);
      console.log("TRACE stream error id=" + traceId + " " + streamError);
      if (!clientCancelled) {
        try {
          controllerRef.error(e);
        } catch {
        }
      }
    } finally {
      await persistOnce();
    }
  }, "pump");
  const reader2 = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const work = pump();
      keepAlive(work.catch((e) => console.log("TRACE stream background error=" + String(e && e.message || e))));
    },
    cancel(reason) {
      clientCancelled = true;
      console.log("TRACE stream client cancelled id=" + traceId + " reason=" + String(reason || "unknown").slice(0, 160));
    }
  });
  const hdrs = clientResponseHeaders(upReq.headers, true);
  hdrs["content-type"] = "text/event-stream; charset=utf-8";
  hdrs["cache-control"] = "no-cache, no-store";
  hdrs["connection"] = "keep-alive";
  hdrs["x-trace-id"] = traceId;
  return new Response(reader2, { status: upReq.status, headers: hdrs });
}
__name(handleStream, "handleStream");
function usageFrom(obj) {
  const u = obj && obj.usage;
  if (!u)
    return null;
  return {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
    cost_usd: Number(u.cost) || 0
  };
}
__name(usageFrom, "usageFrom");
async function computeCost(c, slug, usage) {
  const pt = Number(usage && usage.cost_usd) || 0;
  if (pt > 0)
    return pt;
  if (!slug)
    return 0;
  try {
    const row = await c.env.DB.prepare("SELECT prompt_per_1m, completion_per_1m FROM prices WHERE slug=?").bind(slug).first();
    if (row) {
      const p = Number(row.prompt_per_1m) || 0;
      const ct = Number(row.completion_per_1m) || 0;
      const cost = (Number(usage && usage.prompt_tokens) || 0) / 1e6 * p + (Number(usage && usage.completion_tokens) || 0) / 1e6 * ct;
      return cost;
    }
  } catch {
  }
  return 0;
}
__name(computeCost, "computeCost");
function normalizeStreamTraceEvents(events) {
  return (events || []).map((eventData, sequence) => ({ sequence, event_data: String(eventData) }));
}
__name(normalizeStreamTraceEvents, "normalizeStreamTraceEvents");
var TRACE_EVENT_D1_BATCH_SIZE = 100;
async function recordTraceEvents(c, traceId, events) {
  try {
  const createdAt = nowIso();
  for (let start = 0; start < events.length; start += TRACE_EVENT_D1_BATCH_SIZE) {
    const batch = events.slice(start, start + TRACE_EVENT_D1_BATCH_SIZE).map((eventData, offset) => c.env.DB.prepare(
      "INSERT OR REPLACE INTO trace_events (trace_id, sequence, event_data, created_at) VALUES (?,?,?,?)"
    ).bind(traceId, start + offset, String(eventData), createdAt));
    if (batch.length)
      await c.env.DB.batch(batch);
  }
  } catch (e) { console.log("TRACE_EVENTS store unavailable id=" + traceId); }
}
__name(recordTraceEvents, "recordTraceEvents");
async function attachTraceEvents(c, traces) {
  try {
  const ids = [...new Set((traces || []).filter((trace) => trace.stream).map((trace) => trace.trace_id))];
  const byTrace = new Map(ids.map((id) => [id, []]));
  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    const rows = await c.env.DB.prepare("SELECT trace_id, sequence, event_data FROM trace_events WHERE trace_id IN (" + chunk.map(() => "?").join(",") + ") ORDER BY trace_id, sequence").bind(...chunk).all();
    for (const event of rows.results || [])
      byTrace.get(event.trace_id).push({ sequence: event.sequence, event_data: event.event_data });
  }
  for (const trace of traces || [])
    trace.stream_events = byTrace.get(trace.trace_id) || [];
  return traces || [];
  } catch (e) { console.log("TRACE_EVENTS attach unavailable"); return traces || []; }
}
__name(attachTraceEvents, "attachTraceEvents");
function normalizeTraceFilters(input) {
  const cleanText = /* @__PURE__ */ __name((value) => {
    const text = String(value || "").trim();
    return text ? text.slice(0, 160) : null;
  }, "cleanText");
  const statusText = String(input && input.status || "").trim().toLowerCase();
  let status = null;
  if (statusText && statusText !== "all") {
    status = Number(statusText);
    if (!Number.isInteger(status) || status < 0 || status > 599)
      throw new Error("status must be a valid HTTP status or all");
  }
  return { key_id: cleanText(input && input.key_id), q: cleanText(input && input.q), slug: cleanText(input && input.slug), status };
}
__name(normalizeTraceFilters, "normalizeTraceFilters");
function traceFilterSql(filters) {
  const where = [];
  const binds = [];
  if (filters.key_id) {
    where.push("key_id=?");
    binds.push(filters.key_id);
  }
  if (filters.slug) {
    where.push("slug=?");
    binds.push(filters.slug);
  }
  if (filters.status !== null) {
    where.push("status=?");
    binds.push(filters.status);
  }
  if (filters.q) {
    const pattern = "%" + filters.q.replace(/[\\%_]/g, "\\$&") + "%";
    where.push("(trace_id LIKE ? ESCAPE '\\' OR key_id LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR provider_name LIKE ? ESCAPE '\\')");
    binds.push(pattern, pattern, pattern, pattern);
  }
  return { where: where.join(" AND "), binds };
}
__name(traceFilterSql, "traceFilterSql");
function csvCell(value) {
  let text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value == null ? "" : value);
  text = text.replace(/\r?\n/g, "\\n");
  if (/^[=+\-@]/.test(text))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
__name(csvCell, "csvCell");
function tracesToCsv(rows) {
  const fields = ["trace_id", "slug", "key_id", "provider_name", "upstream_model", "stream", "status", "cache_hit", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "duration_ms", "error", "request_body", "response_body", "stream_events", "created_at"];
  return fields.join(",") + "\n" + rows.map((row) => fields.map((field) => csvCell(row[field])).join(",")).join("\n") + "\n";
}
__name(tracesToCsv, "tracesToCsv");
async function recordTrace(c, t) {
  await c.env.DB.prepare(
    `INSERT INTO traces (trace_id, key_id, slug, provider_id, provider_name, upstream_model, stream, status, error, prompt_tokens, completion_tokens, total_tokens, cost_usd, duration_ms, request_body, response_body, cache_hit, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    t.traceId,
    t.key ? t.key.key_id : null,
    t.slug,
    t.route ? t.route.provider_id : null,
    t.route ? t.route.provider_name : null,
    t.route ? t.route.upstream_model : null,
    t.stream ? 1 : 0,
    t.status,
    t.error ? String(t.error).slice(0, 4e3) : null,
    t.promptTokens || 0,
    t.completionTokens || 0,
    t.totalTokens || 0,
    t.costUsd || 0,
    t.durationMs || 0,
    t.requestBody || null,
    t.responseBody || null,
    t.cacheHit ? 1 : 0,
    nowIso()
  ).run();
}
__name(recordTrace, "recordTrace");
async function lookupResponseCache(c, cacheKey) {
  try {
    const row = await c.env.DB.prepare(
      "SELECT response_body, source_cost_usd, source_tokens FROM response_cache WHERE cache_key=? AND expires_at>?"
    ).bind(cacheKey, nowIso()).first();
    if (!row)
      return null;
    await c.env.DB.prepare("UPDATE response_cache SET hits=hits+1 WHERE cache_key=?").bind(cacheKey).run();
    return row;
  } catch (e) {
    console.log("RESPONSE_CACHE lookup unavailable");
    return null;
  }
}
__name(lookupResponseCache, "lookupResponseCache");
async function storeResponseCache(c, entry) {
  try {
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO response_cache (cache_key, key_id, slug, response_body, source_cost_usd, source_tokens, hits, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(entry.cacheKey, entry.keyId, entry.slug, entry.responseBody, entry.sourceCostUsd || 0, entry.sourceTokens || 0, 0, nowIso(), cacheExpiry(entry.ttl)).run();
  } catch (e) {
    console.log("RESPONSE_CACHE store unavailable");
  }
}
__name(storeResponseCache, "storeResponseCache");
async function recordUsage(c, key, usage) {
  if (!key || !key.key_id)
    return;
  await c.env.DB.prepare(
    "UPDATE api_keys SET used_tokens=used_tokens+?, used_usd=used_usd+?, request_count=request_count+1, updated_at=? WHERE key_id=?"
  ).bind(usage.total_tokens, usage.cost_usd || 0, nowIso(), key.key_id).run();
}
__name(recordUsage, "recordUsage");
function sanitizeRequest(payload) {
  if (!payload || typeof payload !== "object")
    return payload;
  const out = { ...payload };
  for (const k of Object.keys(out)) {
    if (/key|token|secret|authorization|api[_-]?key/i.test(k))
      delete out[k];
  }
  if (typeof out.messages === "string")
    out.messages = "[omitted]";
  return out;
}
__name(sanitizeRequest, "sanitizeRequest");
function sanitizeUpstreamResponse(text) {
  if (!text)
    return text;
  let s = String(text);
  s = s.replace(/https?:\/\/[a-z0-9.-]*openrouter\.ai[a-z0-9/._-]*/gi, "[redacted-provider]");
  s = s.replace(/https?:\/\/[a-z0-9.-]*api\.anthropic\.com[a-z0-9/._-]*/gi, "[redacted-provider]");
  s = s.replace(/https?:\/\/[a-z0-9.-]*api\.openai\.com[a-z0-9/._-]*/gi, "[redacted-provider]");
  s = s.replace(/https?:\/\/api\.futureppo\.top[a-z0-9/._-]*/gi, "[redacted-provider]");
  s = s.replace(/\b[a-z0-9.-]*(futureppo|openrouter|anthropic|openai)[a-z0-9.-]*\.(?:top|ai|com)\b/gi, "[redacted-provider]");
  s = s.replace(/\bapi\.futureppo\.top\b/gi, "[redacted-provider]");
  s = s.replace(/https?:\/\/[a-z0-9.-]*(futureppo|openrouter|anthropic|openai)[a-z0-9/._-]*/gi, "[redacted-provider]");
  return s;
}
__name(sanitizeUpstreamResponse, "sanitizeUpstreamResponse");
function genericUpstreamError() {
  return { error: { message: "The selected model is currently experiencing an outage. Please retry later.", type: "upstream_error" } };
}
__name(genericUpstreamError, "genericUpstreamError");
function isGenericUpstreamErrorResponse(text) {
  try {
    return JSON.parse(text)?.error?.type === "upstream_error";
  } catch {
    return false;
  }
}
__name(isGenericUpstreamErrorResponse, "isGenericUpstreamErrorResponse");
function classifyUpstreamFailure(body) {
  const text = String(body || "").toLowerCase();
  if (/bad (body|url|scheme)|key-mismatch|proxy error|upstream timeout/.test(text))
    return "relay";
  if (/api[ _-]?key|authorization|unauthenticated|forbidden|invalid credential/.test(text))
    return "auth";
  if (/rate.?limit|too many requests|quota/.test(text))
    return "rate_limit";
  if (/model.+(not found|invalid)|unknown model/.test(text))
    return "model";
  if (/tool|function.{0,80}(schema|invalid|unsupported)/.test(text))
    return "tool_schema";
  if (/context|prompt.{0,80}(long|large)|token.{0,80}(limit|large)/.test(text))
    return "request_size";
  return "unknown";
}
__name(classifyUpstreamFailure, "classifyUpstreamFailure");
function safeSseData(line) {
  return "data: " + JSON.stringify(genericUpstreamError()) + "\n\n";
}
__name(safeSseData, "safeSseData");
var LEAK_FIELDS = [
  "service_tier",
  "service_provider",
  "service_model",
  "provider",
  "providers",
  "system_fingerprint",
  "x_gw",
  "upstream",
  "upstream_model",
  "real_model",
  "channel",
  "distributor",
  "gateway",
  "backend",
  "source",
  "request_id",
  "served_by",
  "route_id",
  "worker",
  "region",
  "datacenter",
  "metal"
];
var LEAK_FIELD_RE = /^(service_|provider|upstream|backend|channel|distributor|gateway|source|request_id|served_by|route_id|region|datacenter|real_|internal|debug)/i;
function sanitizeClientObject(obj) {
  if (!obj || typeof obj !== "object")
    return obj;
  if (obj.error && typeof obj.error === "object") {
    obj.error = genericUpstreamError().error;
  }
  for (const k of Object.keys(obj)) {
    if (LEAK_FIELDS.includes(k.toLowerCase()) || LEAK_FIELD_RE.test(k))
      delete obj[k];
  }
  return obj;
}
__name(sanitizeClientObject, "sanitizeClientObject");
function sanitizeClientResponse(text, publicSlug) {
  if (!text)
    return text;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return JSON.stringify(genericUpstreamError());
  }
  if (obj && typeof obj === "object") {
    if (!Array.isArray(obj.choices))
      return JSON.stringify(genericUpstreamError());
    if (publicSlug && "model" in obj)
      obj.model = publicSlug;
    sanitizeClientObject(obj);
    return JSON.stringify(obj);
  }
  return sanitizeUpstreamResponse(text);
}
__name(sanitizeClientResponse, "sanitizeClientResponse");
async function authClient(c) {
  const token = bearerFrom(c);
  if (!token || !token.startsWith("sk-")) {
    return c.json({ error: { message: "Missing or invalid API key. Use Authorization: Bearer sk-...", type: "auth_error" } }, 401);
  }
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(token).first();
  if (!key)
    return c.json({ error: { message: "Unknown API key", type: "auth_error" } }, 401);
  if (!key.active)
    return c.json({ error: { message: "API key is deactivated", type: "auth_error" } }, 403);
  if (isKeyExpired(key))
    return c.json({ error: { message: "API key has expired", type: "key_expired" } }, 403);
  if (isOverBudget(key)) {
    const unit = key.budget_mode === "usd" ? "USD" : "tokens";
    return c.json({
      error: { message: `Key budget exceeded (${unit}). Used ${fmt(key.budget_mode === "usd" ? key.used_usd : key.used_tokens)} / ${fmt(key.budget_limit)} ${unit}.`, type: "budget_exceeded" }
    }, 429);
  }
  const rateDenied = await enforceRequestLimit(c, key);
  if (rateDenied)
    return rateDenied;
  return { key };
}
__name(authClient, "authClient");
function splitModelSlugs(value) {
  return String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean);
}
__name(splitModelSlugs, "splitModelSlugs");
function normalizeTierModels(value) {
  const models = [...new Set(splitModelSlugs(value))];
  if (!models.length)
    throw new Error("a tier must contain at least one public model slug");
  if (models.length > 100 || models.some((slug) => slug.length > 160))
    throw new Error("tier model list is too large");
  return models.join(",");
}
__name(normalizeTierModels, "normalizeTierModels");
function normalizeTierIds(value) {
  const raw2 = value == null || value === "" ? [] : Array.isArray(value) ? value : String(value).split(",");
  const ids = [...new Set(raw2.map((id) => Number(id)))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1))
    throw new Error("tier_ids must contain positive integer IDs");
  return ids;
}
__name(normalizeTierIds, "normalizeTierIds");
async function validateTierIds(c, ids) {
  if (!ids.length)
    return;
  const rows = await c.env.DB.prepare("SELECT id FROM model_tiers WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all();
  if ((rows.results || []).length !== ids.length)
    throw new Error("one or more model tiers do not exist");
}
__name(validateTierIds, "validateTierIds");
async function setKeyTierIds(c, keyId, ids) {
  await validateTierIds(c, ids);
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE key_id=?").bind(keyId).run();
  for (const tierId of ids)
    await c.env.DB.prepare("INSERT INTO api_key_model_tiers (key_id, tier_id) VALUES (?,?)").bind(keyId, tierId).run();
}
__name(setKeyTierIds, "setKeyTierIds");
function effectiveModelSlugs(key, tiers, enabledSlugs) {
  const enabled = new Set(enabledSlugs || []);
  const explicit = splitModelSlugs(key && key.allowed_models);
  const tierModels = (tiers || []).flatMap((tier) => splitModelSlugs(tier && tier.models));
  const grants = !explicit.length && !tierModels.length ? [...enabled] : [...explicit, ...tierModels];
  const excluded = new Set(splitModelSlugs(key && key.excluded_models));
  return [...new Set(grants)].filter((slug) => enabled.has(slug) && !excluded.has(slug)).sort();
}
__name(effectiveModelSlugs, "effectiveModelSlugs");
async function allowedSlugs(c, key) {
  const all = await c.env.DB.prepare("SELECT slug FROM model_routes WHERE enabled=1").all();
  const tiers = await c.env.DB.prepare(
    `SELECT mt.models FROM model_tiers mt
     JOIN api_key_model_tiers akmt ON akmt.tier_id=mt.id
     WHERE akmt.key_id=? ORDER BY mt.name`
  ).bind(key.key_id).all();
  return effectiveModelSlugs(key, tiers.results || [], (all.results || []).map((row) => row.slug));
}
__name(allowedSlugs, "allowedSlugs");
async function slugAllowed(c, key, slug) {
  const allowed = await allowedSlugs(c, key);
  return allowed.includes(slug);
}
__name(slugAllowed, "slugAllowed");
app.post("/admin/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const name = String(body.name || "unnamed").slice(0, 120);
  const budget_mode = body.budget_mode === "usd" ? "usd" : "tokens";
  const budget_limit = Number(body.budget_limit);
  if (!Number.isFinite(budget_limit) || budget_limit <= 0)
    return c.json({ error: { message: "budget_limit must be positive" } }, 400);
  let request_limit_per_minute;
  try {
    request_limit_per_minute = normalizeRequestLimit(body.request_limit_per_minute);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let expires_at;
  try {
    expires_at = normalizeKeyExpiry(body.expires_at);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  let allowed_models = null;
  if (body.allowed_models && Array.isArray(body.allowed_models))
    allowed_models = body.allowed_models.join(",");
  else if (body.allowed_models)
    allowed_models = String(body.allowed_models);
  const excluded_models = splitModelSlugs(body.excluded_models).join(",") || null;
  let tierIds;
  try {
    tierIds = normalizeTierIds(body.tier_ids);
    await validateTierIds(c, tierIds);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const keyId = genKey();
  await c.env.DB.prepare(
    "INSERT INTO api_keys (key_id, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(keyId, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, nowIso(), nowIso()).run();
  await setKeyTierIds(c, keyId, tierIds);
  return c.json({ key_id: keyId, key: keyId, name, budget_mode, budget_limit, request_limit_per_minute, expires_at, allowed_models, excluded_models, tier_ids: tierIds, note: "Send as: Authorization: *** " + keyId }, 201);
});
app.get("/admin/keys", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT k.key_id, k.name, k.budget_mode, k.budget_limit, k.used_tokens, k.used_usd, k.request_count, k.request_limit_per_minute, k.expires_at, k.active, k.allowed_models, k.excluded_models, k.created_at, k.updated_at,
      COALESCE((SELECT GROUP_CONCAT(akmt.tier_id, ',') FROM api_key_model_tiers akmt WHERE akmt.key_id=k.key_id), '') AS tier_ids,
      COALESCE((SELECT GROUP_CONCAT(mt.name, ' \xB7 ') FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=k.key_id), '') AS tier_names
     FROM api_keys k ORDER BY k.created_at DESC`
  ).all();
  return c.json({ keys: rows.results || [] });
});
app.get("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!key)
    return c.json({ error: { message: "key not found" } }, 404);
  const logs = await c.env.DB.prepare("SELECT * FROM traces WHERE key_id=? ORDER BY id DESC LIMIT 50").bind(id).all();
  const tiers = await c.env.DB.prepare("SELECT mt.id, mt.name, mt.models FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=? ORDER BY mt.name").bind(id).all();
  return c.json({ key, tiers: tiers.results || [], recent_traces: logs.results || [] });
});
app.patch("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!existing)
    return c.json({ error: { message: "key not found" } }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  if (body.name !== void 0) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name)
      return c.json({ error: { message: "name is required" } }, 400);
    sets.push("name=?");
    binds.push(name);
  }
  if (body.budget_mode !== void 0) {
    sets.push("budget_mode=?");
    binds.push(body.budget_mode === "usd" ? "usd" : "tokens");
  }
  if (body.budget_limit !== void 0) {
    const n = Number(body.budget_limit);
    if (!Number.isFinite(n) || n <= 0)
      return c.json({ error: { message: "budget_limit must be positive" } }, 400);
    sets.push("budget_limit=?");
    binds.push(n);
  }
  if (body.allowed_models !== void 0) {
    const models = Array.isArray(body.allowed_models) ? body.allowed_models.join(",") : String(body.allowed_models || "").trim();
    sets.push("allowed_models=?");
    binds.push(models || null);
  }
  if (body.request_limit_per_minute !== void 0) {
    try {
      sets.push("request_limit_per_minute=?");
      binds.push(normalizeRequestLimit(body.request_limit_per_minute));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.expires_at !== void 0) {
    try {
      sets.push("expires_at=?");
      binds.push(normalizeKeyExpiry(body.expires_at));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.excluded_models !== void 0) {
    sets.push("excluded_models=?");
    binds.push(splitModelSlugs(body.excluded_models).join(",") || null);
  }
  let tierIds = null;
  if (body.tier_ids !== void 0) {
    try {
      tierIds = normalizeTierIds(body.tier_ids);
      await validateTierIds(c, tierIds);
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (body.active !== void 0) {
    sets.push("active=?");
    binds.push(body.active ? 1 : 0);
  }
  if (!sets.length && tierIds === null)
    return c.json({ error: { message: "no editable fields supplied" } }, 400);
  if (sets.length) {
    sets.push("updated_at=?");
    binds.push(nowIso(), id);
    await c.env.DB.prepare("UPDATE api_keys SET " + sets.join(", ") + " WHERE key_id=?").bind(...binds).run();
  }
  if (tierIds !== null)
    await setKeyTierIds(c, id, tierIds);
  const key = await c.env.DB.prepare("SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, request_limit_per_minute, expires_at, active, allowed_models, excluded_models, created_at, updated_at FROM api_keys WHERE key_id=?").bind(id).first();
  const tiers = await c.env.DB.prepare("SELECT mt.id, mt.name, mt.models FROM api_key_model_tiers akmt JOIN model_tiers mt ON mt.id=akmt.tier_id WHERE akmt.key_id=? ORDER BY mt.name").bind(id).all();
  return c.json({ key, tiers: tiers.results || [] });
});
async function setActive(c, id, active) {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key_id=?").bind(id).first();
  if (!key)
    return c.json({ error: { message: "key not found" } }, 404);
  await c.env.DB.prepare("UPDATE api_keys SET active=?, updated_at=? WHERE key_id=?").bind(active ? 1 : 0, nowIso(), id).run();
  return c.json({ key_id: id, active: !!active });
}
__name(setActive, "setActive");
app.post("/admin/keys/:id/deactivate", (c) => setActive(c, c.req.param("id"), 0));
app.post("/admin/keys/:id/activate", (c) => setActive(c, c.req.param("id"), 1));
app.delete("/admin/keys/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM trace_events WHERE trace_id IN (SELECT trace_id FROM traces WHERE key_id=?)").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_keys WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM traces WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM response_cache WHERE key_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_key_rate_windows WHERE key_id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.get("/admin/model-tiers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    `SELECT mt.*, (SELECT COUNT(*) FROM api_key_model_tiers akmt WHERE akmt.tier_id=mt.id) AS key_count
     FROM model_tiers mt ORDER BY mt.name`
  ).all();
  return c.json({ tiers: rows.results || [] });
});
app.post("/admin/model-tiers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name)
    return c.json({ error: { message: "tier name is required" } }, 400);
  let models;
  try {
    models = normalizeTierModels(body.models);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  try {
    const row = await c.env.DB.prepare("INSERT INTO model_tiers (name, models, created_at, updated_at) VALUES (?,?,?,?) RETURNING id, name, models, created_at, updated_at").bind(name, models, nowIso(), nowIso()).first();
    return c.json({ tier: row }, 201);
  } catch {
    return c.json({ error: { message: "tier name already exists" } }, 409);
  }
});
app.patch("/admin/model-tiers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1)
    return c.json({ error: { message: "invalid tier id" } }, 400);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  if (body.name !== void 0) {
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name)
      return c.json({ error: { message: "tier name is required" } }, 400);
    sets.push("name=?");
    binds.push(name);
  }
  if (body.models !== void 0) {
    try {
      sets.push("models=?");
      binds.push(normalizeTierModels(body.models));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (!sets.length)
    return c.json({ error: { message: "no editable fields supplied" } }, 400);
  try {
    sets.push("updated_at=?");
    binds.push(nowIso(), id);
    await c.env.DB.prepare("UPDATE model_tiers SET " + sets.join(", ") + " WHERE id=?").bind(...binds).run();
  } catch {
    return c.json({ error: { message: "tier name already exists" } }, 409);
  }
  const tier = await c.env.DB.prepare("SELECT * FROM model_tiers WHERE id=?").bind(id).first();
  if (!tier)
    return c.json({ error: { message: "tier not found" } }, 404);
  return c.json({ tier });
});
app.delete("/admin/model-tiers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1)
    return c.json({ error: { message: "invalid tier id" } }, 400);
  await c.env.DB.prepare("DELETE FROM api_key_model_tiers WHERE tier_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM model_tiers WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.get("/admin/providers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare("SELECT id, name, base_url, priority, healthy, last_status, last_checked, notes, fmt, proxy_url, transport, extra_headers, (api_key IS NOT NULL AND api_key <> '') AS api_key_set FROM providers ORDER BY priority").all();
  return c.json({ providers: rows.results || [] });
});
app.get("/admin/proxy-health", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare("SELECT id, name, base_url, proxy_url, transport FROM providers").all();
  const out = [];
  const koyebHealthUrl = String(c.env.KOYEB_RELAY_URL || "").replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/tunnel\/?$/, "/healthz");
  for (const p of rows.results || []) {
    const transport = routeTransport(p, c.env);
    if (transport === "koyeb") {
      if (!koyebHealthUrl) {
        out.push({ id: p.id, name: p.name, transport, proxy: false, reason: "KOYEB_RELAY_URL not configured" });
        continue;
      }
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8e3);
        const r = await fetch(koyebHealthUrl, { method: "GET", signal: ctrl.signal });
        clearTimeout(t);
        out.push({ id: p.id, name: p.name, transport, proxy: true, relay: "koyeb", relay_reachable: r.ok, relay_status: r.status });
      } catch (e) {
        out.push({ id: p.id, name: p.name, transport, proxy: false, relay: "koyeb", reason: String(e && e.message || e) });
      }
      continue;
    }
    if (transport === "direct" || !p.proxy_url) {
      out.push({ id: p.id, name: p.name, transport, proxy: false, reason: transport === "direct" ? "direct" : "no proxy_url" });
      continue;
    }
    try {
      const testUrl = p.proxy_url + (p.proxy_url.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(p.base_url + "/models");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8e3);
      const r = await fetch(testUrl, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      let postStatus = null, postErr = null;
      try {
        const pt = new AbortController();
        const pt2 = setTimeout(() => pt.abort(), 8e3);
        const pr = await fetch(testUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: pt.signal });
        clearTimeout(pt2);
        postStatus = pr.status;
      } catch (e2) {
        postErr = String(e2 && e2.message || e2);
      }
      out.push({ id: p.id, name: p.name, transport, proxy: true, relay: "oci", upstream_status: r.status, post_status: postStatus, post_err: postErr });
    } catch (e) {
      out.push({ id: p.id, name: p.name, transport, proxy: false, relay: "oci", reason: String(e && e.message || e) });
    }
  }
  return c.json({ health: out });
});
app.post("/admin/providers", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!b.name || !b.base_url)
    return c.json({ error: { message: "name + base_url required" } }, 400);
  const fmt2 = b.fmt === "anthropic" ? "anthropic" : "openai";
  let transport = "auto";
  try {
    transport = normalizeTransport(b.transport);
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const sealedKey = b.api_key ? await sealProviderKey(c.env, String(b.api_key)) : null;
  let extraHeaders = "{}";
  try { extraHeaders = normalizeExtraHeaders(b.extra_headers); }
  catch (e) { return c.json({ error: { message: e.message } }, 400); }
  const info = await c.env.DB.prepare("INSERT INTO providers (name, base_url, priority, healthy, notes, fmt, proxy_url, transport, extra_headers, api_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(b.name, b.base_url, Number(b.priority) || 0, b.healthy === false ? 0 : 1, b.notes || null, fmt2, b.proxy_url || null, transport, extraHeaders, sealedKey, nowIso()).all();
  const pid = info.results && info.results[0] && info.results[0].id;
  return c.json({ id: pid, name: b.name, fmt: fmt2, proxy_url: b.proxy_url || null, transport, api_key_set: !!b.api_key }, 201);
});
app.patch("/admin/providers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  for (const f of ["name", "base_url", "notes", "fmt", "proxy_url", "api_key"]) {
    if (b[f] === void 0)
      continue;
    if (f === "api_key") {
      if (!b.api_key)
        continue;
      sets.push("api_key=?");
      binds.push(await sealProviderKey(c.env, String(b.api_key)));
      continue;
    }
    sets.push(f + "=?");
    binds.push(f === "fmt" ? b.fmt === "anthropic" ? "anthropic" : "openai" : b[f]);
  }
  if (b.priority !== void 0) {
    sets.push("priority=?");
    binds.push(Number(b.priority));
  }
  if (b.healthy !== void 0) {
    sets.push("healthy=?");
    binds.push(b.healthy ? 1 : 0);
  }
  if (b.transport !== void 0) {
    try {
      sets.push("transport=?");
      binds.push(normalizeTransport(b.transport));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (b.extra_headers !== void 0) {
    try {
      sets.push("extra_headers=?");
      binds.push(normalizeExtraHeaders(b.extra_headers));
    } catch (e) {
      return c.json({ error: { message: e.message } }, 400);
    }
  }
  if (!sets.length)
    return c.json({ id });
  await c.env.DB.prepare("UPDATE providers SET " + sets.join(", ") + ", updated_at=? WHERE id=?").bind(...binds, nowIso(), id).run();
  const p = await c.env.DB.prepare("SELECT id, name, base_url, priority, healthy, fmt, proxy_url, transport, extra_headers, (api_key IS NOT NULL AND api_key <> '') AS api_key_set FROM providers WHERE id=?").bind(id).first();
  return c.json({ provider: p });
});
app.post("/admin/providers/:id/toggle", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE providers SET healthy = CASE WHEN healthy=1 THEN 0 ELSE 1 END WHERE id=?").bind(id).run();
  const p = await c.env.DB.prepare("SELECT id, healthy FROM providers WHERE id=?").bind(id).first();
  return c.json({ id: p.id, healthy: !!p.healthy });
});
app.post("/admin/routes", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!b.slug || !b.provider_id || !b.upstream_model)
    return c.json({ error: { message: "slug + provider_id + upstream_model required" } }, 400);
  const existing = await c.env.DB.prepare("SELECT COALESCE(MAX(rank),-1)+1 AS next FROM model_routes WHERE slug=?").bind(b.slug).first();
  const rank = b.rank != null ? Number(b.rank) : existing.next;
  await c.env.DB.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,?,?)").bind(b.slug, Number(b.provider_id), b.upstream_model, rank, b.enabled === false ? 0 : 1).run();
  return c.json({ ok: true, slug: b.slug, rank }, 201);
});
app.get("/admin/routes", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare(
    "SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled, p.name AS provider_name, p.healthy AS provider_healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  return c.json({ routes: rows.results || [] });
});
app.post("/admin/routes/:id/toggle", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE model_routes SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END WHERE id=?").bind(id).run();
  const r = await c.env.DB.prepare("SELECT id, enabled FROM model_routes WHERE id=?").bind(id).first();
  return c.json({ id: r.id, enabled: !!r.enabled });
});
app.get("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  const r = await c.env.DB.prepare("SELECT mr.*, p.name AS provider_name FROM model_routes mr JOIN providers p ON p.id=mr.provider_id WHERE mr.id=?").bind(id).first();
  if (!r)
    return c.json({ error: { message: "route not found" } }, 404);
  return c.json({ route: r });
});
app.patch("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const sets = [];
  const binds = [];
  for (const f of ["slug", "provider_id", "upstream_model", "rank"]) {
    if (b[f] !== void 0) {
      sets.push(f + "=?");
      binds.push(f === "rank" || f === "provider_id" ? Number(b[f]) : b[f]);
    }
  }
  if (b.enabled !== void 0) {
    sets.push("enabled=?");
    binds.push(b.enabled ? 1 : 0);
  }
  if (!sets.length)
    return c.json({ id });
  await c.env.DB.prepare("UPDATE model_routes SET " + sets.join(", ") + " WHERE id=?").bind(...binds, id).run();
  const r = await c.env.DB.prepare("SELECT * FROM model_routes WHERE id=?").bind(id).first();
  return c.json({ route: r });
});
app.delete("/admin/routes/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM model_routes WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.delete("/admin/providers/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM model_routes WHERE provider_id=?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM providers WHERE id=?").bind(id).run();
  return c.json({ deleted: id });
});
app.get("/admin/overview", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const providers = await c.env.DB.prepare(
    "SELECT p.id, p.name, p.base_url, p.priority, p.healthy, p.fmt, p.proxy_url, p.transport, p.last_status, p.last_checked, (SELECT COUNT(*) FROM model_routes mr WHERE mr.provider_id=p.id) AS route_count FROM providers p ORDER BY p.priority"
  ).all();
  const routes = await c.env.DB.prepare(
    "SELECT mr.id, mr.slug, mr.provider_id, mr.upstream_model, mr.rank, mr.enabled, p.name AS provider_name, p.healthy AS provider_healthy FROM model_routes mr JOIN providers p ON p.id=mr.provider_id ORDER BY mr.slug, mr.rank"
  ).all();
  const keys = await c.env.DB.prepare(
    "SELECT key_id, name, budget_mode, budget_limit, used_tokens, used_usd, request_count, active, allowed_models, created_at FROM api_keys ORDER BY created_at DESC"
  ).all();
  const agg = await c.env.DB.prepare(
    "SELECT COUNT(*) AS total_traces, COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(cost_usd),0) AS total_usd, COALESCE(SUM(CASE WHEN status>=400 OR status=0 THEN 1 ELSE 0 END),0) AS errors FROM traces"
  ).first();
  const totals = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(request_count),0) AS requests, COALESCE(SUM(used_tokens),0) AS used_tokens, COALESCE(SUM(used_usd),0) AS used_usd FROM api_keys"
  ).first();
  const recent = await c.env.DB.prepare(
    "SELECT trace_id, slug, provider_name, total_tokens, cost_usd, status, duration_ms, created_at FROM traces ORDER BY id DESC LIMIT 12"
  ).all();
  return c.json({
    providers: providers.results || [],
    routes: routes.results || [],
    keys: keys.results || [],
    totals: totals || { requests: 0, used_tokens: 0, used_usd: 0 },
    trace_stats: agg || { total_traces: 0, total_tokens: 0, total_usd: 0, errors: 0, requests: 0 },
    recent_traces: recent.results || [],
    generated_at: nowIso()
  });
});
app.get("/admin/cache", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  await c.env.DB.prepare("DELETE FROM response_cache WHERE expires_at<=?").bind(nowIso()).run();
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(hits * source_cost_usd),0) AS saved_usd, COALESCE(SUM(hits * source_tokens),0) AS saved_tokens FROM response_cache"
  ).first();
  return c.json({ cache: row || { entries: 0, hits: 0, saved_usd: 0, saved_tokens: 0 }, policy: {
    opt_in_header: "x-gateway-cache: true",
    refresh_header: "x-gateway-cache: refresh",
    ttl_header: "x-gateway-cache-ttl",
    default_ttl_seconds: 3600,
    min_ttl_seconds: 60,
    max_ttl_seconds: 86400,
    deterministic_only: true,
    key_scoped: true
  } });
});
app.post("/admin/cache/purge", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const keyId = body && body.key_id ? String(body.key_id) : null;
  if (keyId) {
    const r2 = await c.env.DB.prepare("DELETE FROM response_cache WHERE key_id=?").bind(keyId).run();
    return c.json({ purged: Number(r2.meta && r2.meta.changes) || 0, scope: "key" });
  }
  if (!body || body.confirm !== "PURGE_ALL_CACHE")
    return c.json({ error: { message: "confirm must equal PURGE_ALL_CACHE to clear every cached response" } }, 400);
  const r = await c.env.DB.prepare("DELETE FROM response_cache").run();
  return c.json({ purged: Number(r.meta && r.meta.changes) || 0, scope: "all" });
});
app.get("/admin/traces", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 100), 1), 500);
  let filters;
  try {
    filters = normalizeTraceFilters(c.req.query());
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const query = traceFilterSql(filters);
  let sql = "SELECT trace_id, key_id, slug, provider_name, upstream_model, stream, status, error, prompt_tokens, completion_tokens, total_tokens, cost_usd, duration_ms, cache_hit, created_at FROM traces";
  if (query.where)
    sql += " WHERE " + query.where;
  sql += " ORDER BY id DESC LIMIT " + limit;
  const rows = await c.env.DB.prepare(sql).bind(...query.binds).all();
  return c.json({ traces: rows.results || [], filters });
});
app.get("/admin/traces/export", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const format = String(c.req.query("format") || "json").toLowerCase();
  if (format !== "json" && format !== "csv")
    return c.json({ error: { message: "format must be json or csv" } }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 500), 1), 1e3);
  let filters;
  try {
    filters = normalizeTraceFilters(c.req.query());
  } catch (e) {
    return c.json({ error: { message: e.message } }, 400);
  }
  const query = traceFilterSql(filters);
  let sql = "SELECT trace_id, key_id, slug, provider_name, upstream_model, stream, status, cache_hit, prompt_tokens, completion_tokens, total_tokens, cost_usd, duration_ms, error, request_body, response_body, created_at FROM traces";
  if (query.where)
    sql += " WHERE " + query.where;
  sql += " ORDER BY id DESC LIMIT " + limit;
  const rows = await c.env.DB.prepare(sql).bind(...query.binds).all();
  const traces = await attachTraceEvents(c, rows.results || []);
  const stamp = nowIso().replace(/[:.]/g, "-");
  if (format === "csv")
    return new Response(tracesToCsv(traces), { headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="gateway-traces-' + stamp + '.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    } });
  return new Response(JSON.stringify({ exported_at: nowIso(), count: traces.length, traces }, null, 2), { headers: {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="gateway-traces-' + stamp + '.json"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  } });
});
app.get("/admin/traces/:id", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM traces WHERE trace_id=?").bind(id).first();
  if (!row)
    return c.json({ error: { message: "trace not found" } }, 404);
  await attachTraceEvents(c, [row]);
  return c.json({ trace: row });
});
app.post("/admin/rotate", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  const t = String(b.token || "");
  if (t.length < 16)
    return c.json({ error: { message: "token >= 16 chars" } }, 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO admin_tokens (token_hash, created_at) VALUES (?,?)").bind(await sha256hex(t), nowIso()).run();
  return c.json({ ok: true });
});
app.get("/admin/prices", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const rows = await c.env.DB.prepare("SELECT slug, prompt_per_1m, completion_per_1m, currency, updated_at FROM prices ORDER BY slug").all();
  return c.json({ prices: rows.results || [] });
});
app.post("/admin/prices", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  let b;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!b.slug)
    return c.json({ error: { message: "slug required" } }, 400);
  const p = Number(b.prompt_per_1m) || 0;
  const ct = Number(b.completion_per_1m) || 0;
  await c.env.DB.prepare("INSERT INTO prices (slug, prompt_per_1m, completion_per_1m, currency, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET prompt_per_1m=excluded.prompt_per_1m, completion_per_1m=excluded.completion_per_1m, currency=excluded.currency, updated_at=excluded.updated_at").bind(b.slug, p, ct, b.currency || "USD", nowIso()).run();
  return c.json({ ok: true, slug: b.slug, prompt_per_1m: p, completion_per_1m: ct });
});
app.delete("/admin/prices/:slug", async (c) => {
  const denied = await requireAdmin(c);
  if (denied)
    return denied;
  const slug = decodeURIComponent(c.req.param("slug"));
  await c.env.DB.prepare("DELETE FROM prices WHERE slug=?").bind(slug).run();
  return c.json({ ok: true });
});
var LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI Gateway \u2014 Sign in</title>
<style>
  :root{--bg:#0b0f17;--panel:#131a26;--acc:#4f8cff;--txt:#e6edf3;--mut:#8b98a9;--bad:#f87171}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;background:var(--bg);color:var(--txt);display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:var(--panel);border:1px solid #243047;border-radius:14px;padding:28px 26px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{font-size:17px;margin:0 0 4px}
  .sub{color:var(--mut);font-size:12px;margin-bottom:18px}
  label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}
  input{width:100%;background:#0a0e15;border:1px solid #243047;color:var(--txt);border-radius:8px;padding:10px;font:inherit}
  button{width:100%;background:var(--acc);color:#fff;border:0;border-radius:8px;padding:11px;font-weight:600;cursor:pointer;margin-top:16px}
  .err{color:var(--bad);font-size:12px;min-height:16px;margin-top:10px}
</style></head>
<body><div class="card">
  <h1>\u26A1 AI Gateway</h1>
  <div class="sub">Admin sign in</div>
  <form id="f">
    <label for="p">Password</label>
    <input id="p" type="password" autofocus autocomplete="current-password"/>
    <button type="submit">Sign in</button>
    <div class="err" id="e"></div>
  </form>
</div>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),e=document.getElementById('e');
f.onsubmit=async(ev)=>{ev.preventDefault();e.textContent='';
  try{
    const r=await fetch('/_gw/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});
    if(r.ok){ location.href='/_gw'; }
    else { const j=await r.json().catch(()=>({})); e.textContent=j.error||'Invalid password'; }
  }catch(err){ e.textContent='Network error'; }
};
<\/script>
</body></html>`;
var ADMIN_UI_PATH = "/_gw";
function adminHtml(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      // The SPA uses its bundled inline script/style; no third-party code,
      // frames, forms, or network destinations are permitted.
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "permissions-policy": "geolocation=(), camera=(), microphone=()"
    }
  });
}
__name(adminHtml, "adminHtml");
app.post(ADMIN_UI_PATH + "/auth", async (c) => {
  let b;
  try {
    b = await c.req.json();
  } catch {
    b = {};
  }
  if (!await allowAdminLoginAttempt(c)) {
    return new Response(JSON.stringify({ ok: false, error: "Too many attempts. Try again later." }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "900" } });
  }
  const ok = await checkAdminPassword(String(b.password || ""), c.env);
  if (!ok)
    return new Response(JSON.stringify({ ok: false, error: "Invalid password" }), { status: 401, headers: { "content-type": "application/json" } });
  const session = genSessionToken();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1e3).toISOString();
  await c.env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(nowIso()).run();
  await c.env.DB.prepare("INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?,?,?)").bind(await sha256hex(session), expiresAt, nowIso()).run();
  const cookie = "gw_adm=" + encodeURIComponent(session) + "; Path=/; Max-Age=43200; SameSite=Strict; Secure; HttpOnly";
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "Set-Cookie": cookie } });
});
app.get(ADMIN_UI_PATH, async (c) => {
  if (!await isAdmin(c))
    return adminHtml(LOGIN_HTML);
  return adminHtml(PLAYGROUND_HTML);
});
app.get(ADMIN_UI_PATH + "/", async (c) => {
  if (!await isAdmin(c))
    return adminHtml(LOGIN_HTML);
  return adminHtml(PLAYGROUND_HTML);
});
function clientResponseHeaders(upstreamHeaders, streaming = false) {
  const contentType = upstreamHeaders.get("content-type") || (streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  return {
    "content-type": contentType,
    "cache-control": streaming ? "no-cache, no-store" : "no-store"
  };
}
__name(clientResponseHeaders, "clientResponseHeaders");
function withGatewayHeaders(headers, key, usage) {
  const out = clientResponseHeaders(headers, false);
  out["x-gateway-used-usd"] = String(Number(usage && usage.cost_usd) || 0);
  out["x-gateway-used-tokens"] = String(Number(usage && usage.total_tokens) || 0);
  return out;
}
__name(withGatewayHeaders, "withGatewayHeaders");
var __test = { sanitizeClientResponse, safeSseData, sealProviderKey, openProviderKey, stableJson, isCacheableRequest, responseCacheKey, isCacheableResponse, normalizeRequestLimit, normalizeKeyExpiry, isKeyExpired, splitModelSlugs, effectiveModelSlugs, tracesToCsv, normalizeStreamTraceEvents, normalizeTraceFilters, traceFilterSql, acquireResponseCacheLease, releaseResponseCacheLease, cacheCoalesceDelayMs, classifyUpstreamFailure, isGenericUpstreamErrorResponse, routeTransport, normalizeTransport, transportLabel, koyebCfg };
var src_default = app;
export {
  __test,
  src_default as default
};
//# sourceMappingURL=index.js.map
