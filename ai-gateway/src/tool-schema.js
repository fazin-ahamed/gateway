// A small JSON Schema subset used to coerce and validate tool-call arguments
// against the schema the caller advertised. Subset on purpose: type, enum,
// const, required, properties, items, additionalProperties:false, default,
// anyOf/oneOf. Anything else is ignored rather than guessed at.
//
// coerce() only changes a value when the intent is unambiguous ("5" for an
// integer, "true" for a boolean, a near-miss enum spelling) and reports each
// change as a fix kind. Required fields with no default are reported as
// errors, never invented.

function typesOf(schema) {
  const t = schema && schema.type;
  if (Array.isArray(t)) return t;
  return t ? [t] : [];
}

function kindOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function matchesType(v, types) {
  if (!types.length) return true;
  const k = kindOf(v);
  return types.some((t) => t === k || (t === "number" && k === "integer"));
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function snapEnum(v, options) {
  if (options.includes(v)) return { hit: v, exact: true };
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = norm(v);
  const hits = options.filter((o) => (typeof o === "string" || typeof o === "number") && norm(o) === n);
  return hits.length === 1 ? { hit: hits[0], exact: false } : null;
}

function coerceScalar(v, types, fixes) {
  if (matchesType(v, types)) return { value: v, ok: true };
  const want = types.includes("integer") ? "integer" : types.includes("number") ? "number" : types.includes("boolean") ? "boolean" : types.includes("string") ? "string" : null;
  if (typeof v === "string") {
    const t = v.trim();
    if ((want === "integer" || want === "number") && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
      const n = Number(t);
      if (want === "integer" && !Number.isInteger(n)) return { value: v, ok: false };
      fixes.push("type_coercion");
      return { value: n, ok: true };
    }
    if (want === "boolean" && /^(true|false)$/i.test(t)) {
      fixes.push("type_coercion");
      return { value: t.toLowerCase() === "true", ok: true };
    }
    if (types.includes("null") && /^(null|none)$/i.test(t)) {
      fixes.push("type_coercion");
      return { value: null, ok: true };
    }
  }
  if ((typeof v === "number" || typeof v === "boolean") && types.includes("string")) {
    fixes.push("type_coercion");
    return { value: String(v), ok: true };
  }
  if (typeof v === "number" && want === "boolean" && (v === 0 || v === 1)) {
    fixes.push("type_coercion");
    return { value: v === 1, ok: true };
  }
  return { value: v, ok: false };
}

export function coerce(value, schema, path = "$") {
  const fixes = [];
  const errors = [];
  const root = schema || {};
  const out = walk(value, root, path, fixes, errors, root);
  return { value: out, fixes, errors };
}

// Resolve a local JSON pointer against the root schema's $defs/definitions.
function resolveRef(ref, root) {
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const p of parts) {
    if (!node || typeof node !== "object") return null;
    node = node[p];
  }
  return node || null;
}

function walk(v, schema, path, fixes, errors, root) {
  if (!schema || typeof schema !== "object") return v;
  root = root || schema;

  // $ref resolves against the root schema's $defs/definitions.
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const target = resolveRef(schema.$ref, root);
    if (target) return walk(v, target, path, fixes, errors, root);
  }

  const alts = schema.anyOf || schema.oneOf;
  if (Array.isArray(alts) && alts.length) {
    for (const alt of alts) {
      const f = [], e = [];
      const r = walk(v, alt, path, f, e, root);
      if (!e.length) { fixes.push(...f); return r; }
    }
    errors.push(path + ": matches none of the allowed shapes");
    return v;
  }

  // allOf: every branch must pass; constraints merge.
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    for (const branch of schema.allOf) {
      v = walk(v, branch, path, fixes, errors, root);
    }
  }

  const types = typesOf(schema);

  // A JSON string where an object/array was declared: models often double-encode.
  if (typeof v === "string" && (types.includes("object") || types.includes("array")) && !types.includes("string")) {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        v = JSON.parse(t);
        fixes.push("type_coercion");
      } catch {}
    }
  }
  // A lone scalar where an array was declared.
  if (types.includes("array") && !Array.isArray(v) && v !== undefined && v !== null && !types.includes(kindOf(v))) {
    v = [v];
    fixes.push("type_coercion");
  }

  if ("const" in schema && v !== schema.const) {
    const snap = snapEnum(v, [schema.const]);
    if (snap) { fixes.push("enum_snap"); v = snap.hit; }
    else errors.push(path + ": must equal " + JSON.stringify(schema.const));
    return v;
  }

  if (types.length && !types.includes("object") && !types.includes("array")) {
    const r = coerceScalar(v, types, fixes);
    if (!r.ok) errors.push(path + ": expected " + types.join("|") + ", got " + kindOf(v));
    v = r.value;
  }

  if (Array.isArray(schema.enum)) {
    const snap = snapEnum(v, schema.enum);
    if (!snap) errors.push(path + ": not one of " + JSON.stringify(schema.enum));
    else if (!snap.exact) { fixes.push("enum_snap"); v = snap.hit; }
  }

  if (typeof v === "string" && typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(v))
        errors.push(path + ": does not match pattern " + schema.pattern);
    } catch {}
  }

  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum)
      errors.push(path + ": " + v + " is below minimum " + schema.minimum);
    if (typeof schema.maximum === "number" && v > schema.maximum)
      errors.push(path + ": " + v + " is above maximum " + schema.maximum);
    if (typeof schema.exclusiveMinimum === "number" && v <= schema.exclusiveMinimum)
      errors.push(path + ": " + v + " is not above exclusiveMinimum " + schema.exclusiveMinimum);
    if (typeof schema.exclusiveMaximum === "number" && v >= schema.exclusiveMaximum)
      errors.push(path + ": " + v + " is not below exclusiveMaximum " + schema.exclusiveMaximum);
  }

  if (types.includes("object") || (!types.length && schema.properties)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      if (types.includes("object")) errors.push(path + ": expected object, got " + kindOf(v));
      return v;
    }
    const props = schema.properties || {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k in props) out[k] = walk(val, props[k], path + "." + k, fixes, errors, root);
      else if (schema.additionalProperties === false) fixes.push("unknown_prop_dropped");
      else out[k] = val;
    }
    for (const k of Array.isArray(schema.required) ? schema.required : []) {
      if (k in out && out[k] !== undefined) continue;
      if (props[k] && "default" in props[k]) {
        out[k] = props[k].default;
        fixes.push("required_default");
      } else {
        errors.push(path + "." + k + ": required");
      }
    }
    return out;
  }

  if (types.includes("array")) {
    if (!Array.isArray(v)) { errors.push(path + ": expected array, got " + kindOf(v)); return v; }
    if (typeof schema.minItems === "number" && v.length < schema.minItems)
      errors.push(path + ": " + v.length + " items is below minItems " + schema.minItems);
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems)
      errors.push(path + ": " + v.length + " items is above maxItems " + schema.maxItems);
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items))
      return v.map((el, i) => walk(el, schema.items, path + "[" + i + "]", fixes, errors, root));
  }
  return v;
}

export function validate(value, schema) {
  return coerce(value, schema).errors;
}
