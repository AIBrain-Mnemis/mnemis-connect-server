import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface D1Result<T = unknown> {
	results: T[];
	meta: { changes: number };
}

export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = unknown>(): T | null;
	all<T = unknown>(): D1Result<T>;
	run(): D1Result;
}

export interface D1Database {
	prepare(sql: string): D1PreparedStatement;
}

export function createDatabase(dbPath: string): Database.Database {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	return db;
}

export function applyMigrations(db: Database.Database, migrationsDir: string): void {
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
		filename TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const file of files) {
		const applied = db.prepare("SELECT 1 FROM _migrations WHERE filename = ?").get(file);
		if (applied) continue;
		const sql = readFileSync(join(migrationsDir, file), "utf-8");
		db.exec(sql);
		db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run(file);
		console.info(`[db] applied migration: ${file}`);
	}
}

function convertD1Placeholders(sql: string): string {
	return sql.replace(/\?(\d+)/g, "?");
}

export function wrapDatabase(db: Database.Database): D1Database {
	return {
		prepare(sql: string): D1PreparedStatement {
			let boundValues: unknown[] = [];
			const convertedSql = convertD1Placeholders(sql);

			const stmt: D1PreparedStatement = {
				bind(...values: unknown[]) {
					boundValues = values;
					return stmt;
				},
				first<T>(): T | null {
					const prepared = db.prepare(convertedSql);
					const row = prepared.get(...boundValues) as T | undefined;
					return row ?? null;
				},
				all<T>(): D1Result<T> {
					const prepared = db.prepare(convertedSql);
					const rows = prepared.all(...boundValues) as T[];
					return { results: rows, meta: { changes: 0 } };
				},
				run(): D1Result {
					const prepared = db.prepare(convertedSql);
					const result = prepared.run(...boundValues);
					return { results: [], meta: { changes: result.changes } };
				},
			};
			return stmt;
		},
	};
}
