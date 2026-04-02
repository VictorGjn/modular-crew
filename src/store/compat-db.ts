// bun:sqlite compatibility shim for better-sqlite3 API
import { Database as BunDB } from "bun:sqlite";

function prefixKeys(obj: any): any {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result["$" + key] = val;
  }
  return result;
}

function fixSQL(sql: string): string {
  return sql.replace(/@(\w+)/g, (_, name) => "$" + name);
}

class WrappedStatement {
  private s: any;
  constructor(s: any) { this.s = s; }
  run(...args: any[]) {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      return this.s.run(prefixKeys(args[0]));
    }
    return this.s.run(...args);
  }
  get(...args: any[]) {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      return this.s.get(prefixKeys(args[0]));
    }
    return this.s.get(...args);
  }
  all(...args: any[]) { return this.s.all(...args); }
}

export default class Database {
  private db: InstanceType<typeof BunDB>;
  constructor(path: string) { this.db = new BunDB(path); }
  exec(sql: string) { return this.db.exec(sql); }
  prepare(sql: string) { return new WrappedStatement(this.db.prepare(fixSQL(sql))); }
  pragma(_: string) { /* no-op for bun:sqlite compat */ }
  close() { this.db.close(); }
}
