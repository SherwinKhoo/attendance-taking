import { existsSync, readFileSync, writeFileSync } from "node:fs";

const raw = existsSync(".env")
  ? readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  : [];

const entries = Object.fromEntries(
  raw
    .filter((line) => line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  entries.SUPABASE_URL ||
  entries.VITE_SUPABASE_URL ||
  raw.find((line) => /^https:\/\/.+\.supabase\.co$/.test(line));
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  entries.SUPABASE_ANON_KEY ||
  entries.SUPABASE_PUBLISHABLE_KEY ||
  entries.VITE_SUPABASE_ANON_KEY ||
  entries.VITE_SUPABASE_PUBLISHABLE_KEY ||
  raw.find((line) => /^sb_(anon|publishable)_/.test(line));

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Expected .env to contain a Supabase URL and publishable/anon key.");
}

const config = `window.ATTENDANCE_CONFIG = ${JSON.stringify(
  {
    supabaseUrl,
    supabaseAnonKey,
  },
  null,
  2
)};\n`;

writeFileSync("config.local.js", config, { mode: 0o600 });
console.log("Wrote config.local.js with Supabase URL and publishable key.");
