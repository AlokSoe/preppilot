/**
 * Minimal JSON-schema validator for tool inputs.
 *
 * Tool inputs stream from the model unvalidated (eager input streaming), so
 * every input is checked here before a tool runs. Supports the subset our
 * tool schemas use: type, properties, required, additionalProperties: false,
 * enum, minimum/maximum, minLength/maxLength, items.
 *
 * @param {any} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} error messages; empty when valid
 */
export function validate(schema, value, path = 'input') {
  const errors = [];

  if (schema.type && !matchesType(schema.type, value)) {
    return [`${path} must be ${schema.type}, got ${describe(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (schema.type === 'object' && isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...validate(properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

function matchesType(type, value) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === type;
    default:
      return true;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
