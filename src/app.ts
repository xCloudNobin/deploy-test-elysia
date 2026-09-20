import { Elysia, t, ValidationError } from "elysia";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import {
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  probeDb,
  type Priority,
  type ProjectStatus,
  type TaskStatus,
} from "./db.ts";
import { ROOT, type Config } from "./config.ts";

const PUBLIC_DIR = join(ROOT, "public");
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const NAME_MAX = 120;

export interface AppContext {
  config: Config;
  db: Database | null;
}

export class HttpError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

function requireDb(db: Database | null): Database {
  if (!db) throw new HttpError(503, "Service Unavailable");
  return db;
}

const PROJECT_STATUS_ENUM = t.Enum({
  active: "active",
  archived: "archived",
} as const);

const TASK_STATUS_ENUM = t.Enum({
  todo: "todo",
  in_progress: "in_progress",
  done: "done",
} as const);

const PRIORITY_ENUM = t.Enum({
  low: "low",
  medium: "medium",
  high: "high",
} as const);

// A string must contain at least one non-whitespace character.
const NOT_BLANK = ".*\\S.*";

const projectBody = t.Object({
  name: t.String({ minLength: 1, maxLength: NAME_MAX, pattern: NOT_BLANK }),
  description: t.Optional(t.String({ maxLength: DESCRIPTION_MAX })),
  status: t.Optional(PROJECT_STATUS_ENUM),
});

const taskBody = t.Object({
  project_id: t.Number({ minimum: 1, integer: true }),
  title: t.String({ minLength: 1, maxLength: TITLE_MAX, pattern: NOT_BLANK }),
  description: t.Optional(t.String({ maxLength: DESCRIPTION_MAX })),
  status: t.Optional(TASK_STATUS_ENUM),
  priority: t.Optional(PRIORITY_ENUM),
});

const taskPatchBody = t.Object({
  project_id: t.Optional(t.Number({ minimum: 1, integer: true })),
  title: t.Optional(t.String({ minLength: 1, maxLength: TITLE_MAX, pattern: NOT_BLANK })),
  description: t.Optional(t.String({ maxLength: DESCRIPTION_MAX })),
  status: t.Optional(TASK_STATUS_ENUM),
  priority: t.Optional(PRIORITY_ENUM),
});

const projectPatchBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: NAME_MAX, pattern: NOT_BLANK })),
  description: t.Optional(t.String({ maxLength: DESCRIPTION_MAX })),
  status: t.Optional(PROJECT_STATUS_ENUM),
});

const idParams = t.Object({ id: t.Number({ minimum: 1, integer: true }) });

const taskQuery = t.Object({
  q: t.Optional(t.String()),
  status: t.Optional(t.String()),
  priority: t.Optional(t.String()),
  project_id: t.Optional(t.Number({ minimum: 1, integer: true })),
});

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  created_at: string;
  updated_at: string;
}

function getProject(db: Database, id: number): ProjectRow | null {
  const row = db.query("SELECT * FROM project WHERE id = ?").get(id);
  return row ? (row as ProjectRow) : null;
}

function getTask(db: Database, id: number): TaskRow | null {
  const row = db
    .query(
      `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
              t.status, t.priority, t.created_at, t.updated_at
         FROM task t JOIN project p ON p.id = t.project_id WHERE t.id = ?`,
    )
    .get(id);
  return row ? (row as TaskRow) : null;
}

function escapeLike(q: string): string {
  return `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function serveStatic(path: string): Response {
  const rel = path === "/" ? "/index.html" : path;
  const joined = resolve(PUBLIC_DIR, "." + normalize(rel));
  const prefix = PUBLIC_DIR.endsWith("/") ? PUBLIC_DIR : PUBLIC_DIR + "/";
  if (joined !== PUBLIC_DIR && !joined.startsWith(prefix)) {
    return html("<!doctype html><meta charset=\"utf-8\"><title>Not found</title><h1>404 Not Found</h1>", 404);
  }
  if (!existsSync(joined)) {
    return html("<!doctype html><meta charset=\"utf-8\"><title>Not found</title><h1>404 Not Found</h1>", 404);
  }
  const data = readFileSync(joined);
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
  };
  const ext = joined.slice(joined.lastIndexOf("."));
  return new Response(data, { headers: { "content-type": mime[ext] ?? "application/octet-stream" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isAllowedListMember(value: string, list: readonly string[]): boolean {
  return (list as readonly string[]).includes(value);
}

export function buildApp(ctx: AppContext) {
  return new Elysia()
    .state({ config: ctx.config, db: ctx.db } as const)
    .onError(({ code, error, set, path }) => {
      if (code === "NOT_FOUND") {
        if (path.startsWith("/api")) {
          set.status = 404;
          return { error: "Not found" };
        }
        return serveStatic(path);
      }
      if (error instanceof HttpError) {
        set.status = error.status;
        if (error.status === 503) return { error: error.message, db: "unavailable" };
        if (Object.keys(error.fields).length > 0) {
          return { error: error.message, fields: error.fields };
        }
        return { error: error.message };
      }
      if (code === "PARSE") {
        set.status = 400;
        return { error: "Request body is not valid JSON" };
      }
      if (code === "VALIDATION" && error instanceof ValidationError) {
        const fields: Record<string, string> = {};
        for (const item of error.all ?? []) {
          const key = String(item.path ?? "").replace(/^\//, "");
          if (key && !(key in fields)) {
            fields[key] = item.message ?? "Invalid value";
          }
        }
        set.status = 400;
        return { error: "Validation failed", fields };
      }
      // eslint-disable-next-line no-console
      console.error("[taskboard] unhandled error:", error);
      set.status = 500;
      return { error: "Internal Server Error" };
    })

    // Health and metadata ----------------------------------------------------
    .get("/api/health/live", () => ({ status: "alive", timestamp: new Date().toISOString() }))
    .get("/api/health/ready", ({ store, set }) => {
      const probe = probeDb(store.config.dbPath);
      if (probe.ok) return { status: "ready", db: "sqlite", checked_at: probe.detail || null };
      set.status = 503;
      return { status: "unavailable", db: "sqlite", detail: probe.detail };
    })
    .get("/api/meta", ({ store }) => ({
      name: "deploy-test-elysia",
      description: "Elysia on Bun taskboard: SQLite persistence, typed validation, search/filter.",
      release: store.config.buildMarker,
      framework: "elysia",
      runtime: { name: "bun", version: Bun.version },
      database: { engine: "sqlite", path: store.config.dbPath },
    }))

    // Projects ---------------------------------------------------------------
    .get("/api/projects", ({ store }) => {
      const db = requireDb(store.db);
      const rows = db
        .query(
          `SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
                  COUNT(t.id) AS task_total,
                  SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,
                  SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
                  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
             FROM project p LEFT JOIN task t ON t.project_id = p.id
            GROUP BY p.id ORDER BY p.id ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      const projects = rows.map((r) => ({
        ...r,
        task_total: Number(r.task_total) ?? 0,
        todo: Number(r.todo) ?? 0,
        in_progress: Number(r.in_progress) ?? 0,
        done: Number(r.done) ?? 0,
      }));
      return { projects };
    })
    .post("/api/projects", ({ store, body, set }) => {
      const db = requireDb(store.db);
      const res = db
        .query("INSERT INTO project (name, description, status) VALUES (?, ?, ?)")
        .run(body.name, body.description ?? "", body.status ?? "active");
      set.status = 201;
      return { project: getProject(db, Number(res.lastInsertRowid)) };
    }, { body: projectBody })
    .get("/api/projects/:id", ({ store, params, set }) => {
      const db = requireDb(store.db);
      const project = getProject(db, params.id);
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }
      const tasks = db
        .query("SELECT * FROM task WHERE project_id = ? ORDER BY id DESC")
        .all(params.id) as TaskRow[];
      return { project, tasks };
    }, { params: idParams })
    .patch("/api/projects/:id", ({ store, params, body, set }) => {
      const db = requireDb(store.db);
      const id = params.id;
      const current = getProject(db, id);
      if (!current) {
        set.status = 404;
        return { error: "Project not found" };
      }
      if (body.name === undefined && body.description === undefined && body.status === undefined) {
        throw new HttpError(400, "Nothing to update: provide at least one of name, description, status");
      }
      db.query(
        "UPDATE project SET name = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(body.name ?? current.name, body.description ?? current.description, body.status ?? current.status, id);
      return { project: getProject(db, id) };
    }, { params: idParams, body: projectPatchBody })
    .delete("/api/projects/:id", ({ store, params, set }) => {
      const db = requireDb(store.db);
      const res = db.query("DELETE FROM project WHERE id = ?").run(params.id);
      if (Number(res.changes) === 0) {
        set.status = 404;
        return { error: "Project not found" };
      }
      set.status = 204;
      return null;
    }, { params: idParams })

    // Tasks ------------------------------------------------------------------
    .get("/api/tasks", ({ store, query, set }) => {
      const db = requireDb(store.db);
      const q = query.q?.trim() ?? "";
      const status = query.status?.trim() || null;
      const priority = query.priority?.trim() || null;

      if (status !== null && !isAllowedListMember(status, TASK_STATUSES)) {
        throw new HttpError(400, `status filter must be one of: ${TASK_STATUSES.join(", ")}`);
      }
      if (priority !== null && !isAllowedListMember(priority, PRIORITIES)) {
        throw new HttpError(400, `priority filter must be one of: ${PRIORITIES.join(", ")}`);
      }

      const like = q ? escapeLike(q) : null;
      const tasks = db
        .query(
          `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                  t.status, t.priority, t.created_at, t.updated_at
             FROM task t JOIN project p ON p.id = t.project_id
            WHERE (($project IS NULL) OR t.project_id = $project)
              AND (($status IS NULL) OR t.status = $status)
              AND (($priority IS NULL) OR t.priority = $priority)
              AND (($q IS NULL) OR t.title LIKE $q ESCAPE '\\' OR t.description LIKE $q ESCAPE '\\')
            ORDER BY t.id DESC`,
        )
        .all({
          $project: query.project_id ?? null,
          $status: status,
          $priority: priority,
          $q: like,
        }) as TaskRow[];

      return { tasks, count: tasks.length, query: { q, status, priority, project_id: query.project_id ?? null } };
    }, { query: taskQuery })
    .post("/api/tasks", ({ store, body, set }) => {
      const db = requireDb(store.db);
      if (!getProject(db, body.project_id)) {
        throw new HttpError(400, "project_id does not exist", { project_id: "no project with that id" });
      }
      const res = db
        .query(
          "INSERT INTO task (project_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          body.project_id,
          body.title,
          body.description ?? "",
          body.status ?? "todo",
          body.priority ?? "medium",
        );
      set.status = 201;
      return { task: getTask(db, Number(res.lastInsertRowid)) };
    }, { body: taskBody })
    .get("/api/tasks/:id", ({ store, params, set }) => {
      const db = requireDb(store.db);
      const task = getTask(db, params.id);
      if (!task) {
        set.status = 404;
        return { error: "Task not found" };
      }
      return { task };
    }, { params: idParams })
    .patch("/api/tasks/:id", ({ store, params, body, set }) => {
      const db = requireDb(store.db);
      const id = params.id;
      const current = getTask(db, id);
      if (!current) {
        set.status = 404;
        return { error: "Task not found" };
      }
      const keys = ["title", "description", "status", "priority", "project_id"] as const;
      if (!keys.some((k) => body[k] !== undefined)) {
        throw new HttpError(400, "Nothing to update: provide at least one of title, description, status, priority");
      }
      const projectId = body.project_id ?? current.project_id;
      if (body.project_id !== undefined && !getProject(db, body.project_id)) {
        throw new HttpError(400, "project_id does not exist", { project_id: "no project with that id" });
      }
      db.query(
        `UPDATE task SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
                updated_at = datetime('now') WHERE id = ?`,
      ).run(
        projectId,
        body.title ?? current.title,
        body.description ?? current.description,
        body.status ?? current.status,
        body.priority ?? current.priority,
        id,
      );
      return { task: getTask(db, id) };
    }, { params: idParams, body: taskPatchBody })
    .delete("/api/tasks/:id", ({ store, params, set }) => {
      const db = requireDb(store.db);
      const res = db.query("DELETE FROM task WHERE id = ?").run(params.id);
      if (Number(res.changes) === 0) {
        set.status = 404;
        return { error: "Task not found" };
      }
      set.status = 204;
      return null;
    }, { params: idParams });
}