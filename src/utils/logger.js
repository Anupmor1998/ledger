function safeMeta(meta = {}) {
  const output = {};
  Object.entries(meta).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    if (value instanceof Error) {
      output[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      return;
    }
    output[key] = value;
  });
  return output;
}

function write(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...safeMeta(meta),
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

module.exports = {
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
};
