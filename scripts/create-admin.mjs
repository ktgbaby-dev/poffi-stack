// Creates a dashboard login.
//   DATABASE_URL=postgres://... node scripts/create-admin.mjs --email owner@example.com --name "Owner Name" [--role owner|staff]
// Prints a one-time temporary password; the person must choose their own at first sign-in.
import { createUser } from "../lib/auth.js";
import { closeDb } from "../lib/db.js";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); args[k] = v ?? process.argv[++i]; }
}
if (!args.email || !args.name) {
  console.error('Usage: node scripts/create-admin.mjs --email you@example.com --name "Your Name" [--role owner|staff]');
  process.exit(1);
}
try {
  const { user, temporaryPassword } = await createUser({ email: args.email, name: args.name, role: args.role || "owner" });
  console.log(`Created ${user.role} login for ${user.email}.`);
  console.log(`Temporary password (shown once): ${temporaryPassword}`);
  console.log("Sign in at /admin and choose a new password.");
} catch (err) {
  console.error(`Could not create the login: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
