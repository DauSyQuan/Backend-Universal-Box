function serialize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code ?? null,
      stack: value.stack ?? null
    };
  }

  if (typeof value === "string") {
    return value;
  }

  return value === undefined ? null : value;
}

function formatArgs(args) {
  if (args.length === 0) {
    return { message: "" };
  }

  if (args.length === 1) {
    const [first] = args;
    if (typeof first === "string") {
      return { message: first };
    }
    return { message: "", detail: serialize(first) };
  }

  const [first, ...rest] = args;
  return {
    message: typeof first === "string" ? first : "",
    detail: rest.map((item) => serialize(item))
  };
}

export function createLogger(scope = "app", baseContext = {}) {
  const write = (level, args) => {
    const payload = {
      timestamp: new Date().toISOString(),
      scope,
      level,
      ...baseContext,
      ...formatArgs(args)
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  };

  return {
    log: (...args) => write("info", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    debug: (...args) => write("debug", args)
  };
}
