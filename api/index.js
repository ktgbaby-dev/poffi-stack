// Vercel entry point: every /api/* and /media/* request is rewritten here (see vercel.json).
import { handle } from "../lib/router.js";

export const GET = (request) => handle(request);
export const POST = (request) => handle(request);
export const PUT = (request) => handle(request);
export const DELETE = (request) => handle(request);
export const HEAD = (request) => handle(request);
