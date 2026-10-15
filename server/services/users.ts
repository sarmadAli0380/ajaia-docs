import type { User } from "../../shared/api.js";
import type { Queryable } from "../db/index.js";
import { isUuid } from "./text.js";

export type { User };

export async function listUsers(q: Queryable): Promise<User[]> {
  const { rows } = await q.query<User>("SELECT id, name, email FROM users ORDER BY name, id");
  return rows;
}

export async function findUser(q: Queryable, id: unknown): Promise<User | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query<User>("SELECT id, name, email FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}
