// An in-memory stand-in for the D1 binding, over node:sqlite (the same SQLite
// engine D1 runs), so the history store's real SQL runs in unit tests. It
// implements only the HistoryDb slice: prepare/bind/run/all/first, batch and
// exec. Like D1's batch, a batch is one transaction that rolls back whole.
//
// Not a test file: vitest only collects `*.test.ts`.
import { DatabaseSync } from "node:sqlite";
import type { HistoryDb, HistoryStatement, HistoryValue } from "../lib/status/history-store.ts";

class FakeStatement implements HistoryStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    private readonly values: HistoryValue[] = [],
  ) {}

  bind(...values: HistoryValue[]): HistoryStatement {
    return new FakeStatement(this.sqlite, this.sql, values);
  }

  /** Synchronous core, shared by run() and batch(). */
  execute(): unknown {
    return this.sqlite.prepare(this.sql).run(...this.values);
  }

  async run(): Promise<unknown> {
    return this.execute();
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...this.values);
    return { results: rows.map((row) => ({ ...row })) as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    return row === undefined ? null : ({ ...row } as T);
  }
}

export class D1Fake implements HistoryDb {
  readonly sqlite = new DatabaseSync(":memory:");
  /** Every statement text that ran through prepare(), in order. */
  readonly prepared: string[] = [];
  /** How many batches committed and how many rolled back. */
  batches = { committed: 0, rolledBack: 0 };

  prepare(query: string): HistoryStatement {
    this.prepared.push(query);
    return new FakeStatement(this.sqlite, query);
  }

  async batch(statements: HistoryStatement[]): Promise<unknown[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => (statement as FakeStatement).execute());
      this.sqlite.exec("COMMIT");
      this.batches.committed++;
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      this.batches.rolledBack++;
      throw error;
    }
  }

  async exec(query: string): Promise<unknown> {
    this.sqlite.exec(query);
    return { count: 1 };
  }

  /** Every history row, for assertions. */
  rows(): Record<string, unknown>[] {
    return this.sqlite
      .prepare("SELECT * FROM history_day_v1 ORDER BY day, service_id")
      .all()
      .map((row) => ({ ...row }));
  }

  close(): void {
    this.sqlite.close();
  }
}
