// Dashboard sign-in. Passwords: scrypt. Sessions: a signed cookie
//   v1.<userId>.<expiryUnix>.<sessionVersion>.<HMAC-SHA256(SESSION_SECRET, everything before)>
// A session only counts while the user is active and their session_version matches, so changing or
// resetting a password (or removing the user) ends all of that user's sessions at once.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDb } from "./db.js";
import { env, isProd } from "./config.js";
import { HttpError, bad, isEmail, parseCookies, str } from "./http.js";

const scrypt = promisify(scryptCb);
export const COOKIE = "ps_admin";
export const SESSION_SECONDS = 7 * 24 * 3600;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(String(pw), Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) throw bad("weak_password", "Use at least 10 characters for the password.", { field: "password" });
  if (pw.length > 200) throw bad("weak_password", "That password is too long.", { field: "password" });
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) throw bad("weak_password", "Choose a less guessable password.", { field: "password" });
}

export const generatePassword = () => randomBytes(12).toString("base64url");

function secret() {
  const s = env("SESSION_SECRET");
  if (s.length < 32) throw new HttpError(503, "not_configured", "Dashboard sign-in isn't set up yet (SESSION_SECRET).");
  return s;
}
const sign = (body) => createHmac("sha256", secret()).update(body).digest("base64url");
const safeEq = (a, b) => timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());

const attrs = () => `Path=/; HttpOnly; SameSite=Strict${isProd() || env("COOKIE_SECURE") === "true" ? "; Secure" : ""}`;
export function sessionCookie(user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const body = `v1.${user.id}.${exp}.${user.session_version}`;
  return `${COOKIE}=${body}.${sign(body)}; Max-Age=${SESSION_SECONDS}; ${attrs()}`;
}
export const clearCookie = () => `${COOKIE}=; Max-Age=0; ${attrs()}`;

const publicUser = (u) => ({ id: Number(u.id), email: u.email, name: u.name, role: u.role, must_change_password: u.must_change_password });

export async function sessionUser(request) {
  const raw = parseCookies(request)[COOKIE];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const body = parts.slice(0, 4).join(".");
  if (!safeEq(sign(body), parts[4])) return null;
  const [, id, exp, version] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  const { query } = await getDb();
  const { rows } = await query(`SELECT * FROM admin_users WHERE id = $1 AND active`, [Number(id)]);
  if (!rows.length || Number(rows[0].session_version) !== Number(version)) return null;
  return publicUser(rows[0]);
}

// Every dashboard API call goes through this. State-changing calls also need the custom header, which a
// cross-site form or image can't send (SameSite=Strict cookies are the first line of defence).
export async function requireAdmin(request, { role = null, allowMustChange = false } = {}) {
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-requested-with") !== "poffi-admin") {
    throw new HttpError(403, "bad_request_origin", "Please use the dashboard to do that.");
  }
  const user = await sessionUser(request);
  if (!user) throw new HttpError(401, "signed_out", "Please sign in again.");
  if (user.must_change_password && !allowMustChange) throw new HttpError(403, "must_change_password", "Choose a new password to continue.");
  if (role === "owner" && user.role !== "owner") throw new HttpError(403, "owner_only", "Only the owner account can do that.");
  return user;
}

export async function login(email, password) {
  const { query } = await getDb();
  const { rows } = await query(`SELECT * FROM admin_users WHERE email = $1 AND active`, [str(email, 254).toLowerCase()]);
  const ok = rows.length ? await checkPassword(password, rows[0].password_hash) : (await checkPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==").catch(() => false), false);
  if (!ok) return null;
  await query(`UPDATE admin_users SET last_login_at = now() WHERE id = $1`, [rows[0].id]);
  return rows[0];
}

export async function changePassword(userId, current, next) {
  validatePassword(next);
  const { query } = await getDb();
  const { rows } = await query(`SELECT * FROM admin_users WHERE id = $1 AND active`, [userId]);
  if (!rows.length) throw new HttpError(401, "signed_out", "Please sign in again.");
  if (!(await checkPassword(current, rows[0].password_hash))) throw bad("wrong_password", "Your current password isn't right.", { field: "current" });
  if (current === next) throw bad("same_password", "Choose a password you haven't used here.", { field: "password" });
  const { rows: upd } = await query(`UPDATE admin_users SET password_hash = $2, must_change_password = false, session_version = session_version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [userId, await hashPassword(next)]);
  return upd[0];
}

export async function createUser({ email, name, role, password = null }) {
  const e = str(email, 254).toLowerCase();
  if (!isEmail(e)) throw bad("invalid_user", "Enter a valid email address.", { field: "email" });
  const n = str(name, 80);
  if (!n) throw bad("invalid_user", "Enter a name.", { field: "name" });
  if (!["owner", "staff"].includes(role)) throw bad("invalid_user", "Choose a role.", { field: "role" });
  const temp = password || generatePassword();
  if (password) validatePassword(password);
  const { query } = await getDb();
  try {
    const { rows } = await query(`INSERT INTO admin_users (email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [e, n, role, await hashPassword(temp), !password]);
    return { user: publicUser(rows[0]), temporaryPassword: password ? null : temp };
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "user_exists", "There's already a login with that email.");
    throw err;
  }
}

export async function listUsers() {
  const { query } = await getDb();
  const { rows } = await query(`SELECT id, email, name, role, active, must_change_password, last_login_at, created_at FROM admin_users ORDER BY created_at`);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function resetUserPassword(id) {
  const temp = generatePassword();
  const { query } = await getDb();
  const r = await query(`UPDATE admin_users SET password_hash = $2, must_change_password = true, session_version = session_version + 1, updated_at = now() WHERE id = $1 RETURNING id`, [id, await hashPassword(temp)]);
  if (!r.rowCount) throw new HttpError(404, "not_found", "That login doesn't exist.");
  return temp;
}

export async function setUserActive(id, active, actingUserId) {
  if (Number(id) === Number(actingUserId) && !active) throw bad("cannot_remove_self", "You can't switch off your own login.");
  const { query } = await getDb();
  if (!active) {
    const { rows } = await query(`SELECT role FROM admin_users WHERE id = $1`, [id]);
    if (rows[0]?.role === "owner") {
      const { rows: owners } = await query(`SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active`);
      if (owners[0].n <= 1) throw bad("last_owner", "Keep at least one active owner login.");
    }
  }
  const r = await query(`UPDATE admin_users SET active = $2, session_version = session_version + 1, updated_at = now() WHERE id = $1 RETURNING id`, [id, active]);
  if (!r.rowCount) throw new HttpError(404, "not_found", "That login doesn't exist.");
}

export async function countUsers() {
  const { query } = await getDb();
  const { rows } = await query(`SELECT count(*)::int AS n FROM admin_users`);
  return rows[0].n;
}

export function setupTokenMatches(token) {
  const expected = env("ADMIN_SETUP_TOKEN");
  return expected.length >= 16 && typeof token === "string" && safeEq(token, expected);
}
