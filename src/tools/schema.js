export function validateArguments(schema, value, { root = schema, label = 'arguments', depth = 0 } = {}) {
  if (depth > 32) throw new Error('Tool arguments exceed the schema nesting limit.');
  if (schema === true) return;
  if (schema === false || !schema || typeof schema !== 'object') throw new Error(`Invalid tool schema for ${label}.`);
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('Only local JSON-schema references are supported.');
    let target = root;
    for (const key of schema.$ref.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (!target || !Object.hasOwn(target, key)) throw new Error('Invalid local schema reference.'); target = target[key];
    }
    return validateArguments(target, value, { root, label, depth: depth + 1 });
  }
  if (schema.allOf) for (const alternative of schema.allOf) validateArguments(alternative, value, { root, label, depth: depth + 1 });
  if (schema.not) {
    let matches = true;
    try { validateArguments(schema.not, value, { root, label, depth: depth + 1 }); } catch { matches = false; }
    if (matches) throw new Error(`${label} matches a prohibited schema.`);
  }
  for (const kind of ['anyOf', 'oneOf']) if (schema[kind]) {
    let matches = 0;
    for (const alternative of schema[kind]) try { validateArguments(alternative, value, { root, label, depth: depth + 1 }); matches += 1; } catch { /* try another alternative */ }
    if (!matches || kind === 'oneOf' && matches !== 1) throw new Error(`${label} does not match ${kind}.`);
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${label} has an invalid enum value.`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error(`${label} does not match its constant.`);
  const typeMatches = (type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)) throw new Error(`Invalid type for ${label}.`);
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${label} is outside its allowed range.`);
  if (typeof value === 'string') {
    if (schema.maxLength === undefined && value.length > 2097152) throw new Error(`${label} exceeds the 2 MiB size limit.`);
    if (value.length > (schema.maxLength ?? 2097152) || value.length < (schema.minLength ?? 0)) throw new Error(`${label} has an invalid length.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${label} does not match its pattern.`);
  }
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? 1000) || value.length < (schema.minItems ?? 0)) throw new Error(`${label} has an invalid array length.`);
    if (schema.items) value.forEach((item, index) => validateArguments(schema.items, item, { root, label: `${label}[${index}]`, depth: depth + 1 }));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`Missing argument: ${label}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateArguments(schema.properties[key], item, { root, label: `${label}.${key}`, depth: depth + 1 });
      else if (schema.additionalProperties === false) throw new Error(`Unknown argument: ${label}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateArguments(schema.additionalProperties, item, { root, label: `${label}.${key}`, depth: depth + 1 });
    }
  }
}
