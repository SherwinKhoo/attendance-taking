import { test, expect } from "@playwright/test";

// Smoke test for the Supabase Auth login flow.
//
// Prereqs:
//   * Supabase project with supabase/schema.sql applied.
//   * Prototype users seeded:  npm run seed (uses scripts/seed-prototype.mjs).
//   * config.local.js pointing at the Supabase URL + publishable/anon key.
//   * Static site served at http://localhost:8011/.
//   * Seed credentials: U-001 / Proto-Pass!1 (pre-claimed, no forced change).

test("login dialog blocks until valid credentials, persists across reload, and logs out from settings", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("http://localhost:8011/", { waitUntil: "domcontentloaded" });

  // Login dialog opens automatically when no session exists; settings icon hidden.
  const loginDialog = page.locator("#login-dialog");
  await expect(loginDialog).toBeVisible();
  await expect(page.locator("#settings-toggle")).toBeHidden();
  await expect(page.locator("#login-campus")).toHaveJSProperty("tagName", "INPUT");

  // Wrong password → dialog stays.
  await page.fill("#login-campus", "PROTO");
  await page.fill("#pass-id", "U-001");
  await page.fill("#password", "Wrong-Pass!1");
  await page.click("#password-visibility-toggle");
  await expect(page.locator("#password")).toHaveJSProperty("type", "text");
  await page.click("#login-submit");
  await expect(loginDialog).toBeVisible();
  await expect(page.locator("#login-status")).toContainText("incorrect");

  // Correct password → dialog closes, app appears, settings icon shows.
  await page.fill("#password", "Proto-Pass!1");
  await page.click("#login-submit");
  await expect(loginDialog).toBeHidden({ timeout: 5000 });
  await expect(page.locator("#attendance-login-status")).toContainText("U-001");
  await expect(page.locator("#settings-toggle")).toBeVisible();

  // Persistence across reload (Supabase Auth refresh in localStorage).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#attendance-login-status")).toContainText("U-001", { timeout: 5000 });
  await expect(loginDialog).toBeHidden();

  // Logout from settings menu.
  await page.click("#settings-toggle");
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#settings-logout")).toBeVisible();
  await page.click("#settings-logout");

  // Settings dialog closes; login dialog reopens.
  await expect(page.locator("#settings-dialog")).toBeHidden({ timeout: 5000 });
  await expect(loginDialog).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#settings-toggle")).toBeHidden();
  await expect(page.locator("#login-campus")).toHaveValue("");
  await expect(page.locator("#pass-id")).toHaveValue("");
  await expect(page.locator("#password")).toHaveValue("");
  await expect(page.locator("#password")).toHaveJSProperty("type", "password");
  await expect(page.locator("#password-visibility-toggle")).toHaveText("Show");
  await expect(page.locator("#password-visibility-toggle")).toHaveAttribute("aria-pressed", "false");

  expect(errors).toEqual([]);
});

test("settings dialog opens with dark-mode switch, change-password, log-out, and notifications inbox", async ({ page }) => {
  await page.goto("http://localhost:8011/", { waitUntil: "domcontentloaded" });
  await page.fill("#login-campus", "PROTO");
  await page.fill("#pass-id", "U-001");
  await page.fill("#password", "Proto-Pass!1");
  await page.click("#login-submit");
  await expect(page.locator("#settings-toggle")).toBeVisible({ timeout: 5000 });

  await page.click("#settings-toggle");
  await expect(page.locator("#dark-mode-toggle")).toBeAttached();
  await expect(page.locator("#settings-change-password")).toBeVisible();
  await expect(page.locator("#settings-logout")).toBeVisible();
  await expect(page.locator("#notifications-list")).toBeVisible();

  await page.click("#settings-change-password");
  await expect(page.locator("#password-dialog")).toBeVisible();
  await page.fill("#password-old", "Proto-Pass!1");
  await page.fill("#password-new", "Proto-Pass!2");
  await page.fill("#password-confirm", "Proto-Pass!2");
  await page.click("#password-old-toggle");
  await page.click("#password-new-toggle");
  await page.click("#password-confirm-toggle");
  await expect(page.locator("#password-old")).toHaveJSProperty("type", "text");
  await page.click("#password-cancel");
  await expect(page.locator("#password-dialog")).toBeHidden();

  await page.click("#settings-toggle");
  await page.click("#settings-change-password");
  await expect(page.locator("#password-dialog")).toBeVisible();
  await expect(page.locator("#password-old")).toHaveValue("");
  await expect(page.locator("#password-new")).toHaveValue("");
  await expect(page.locator("#password-confirm")).toHaveValue("");
  await expect(page.locator("#password-old")).toHaveJSProperty("type", "password");
  await expect(page.locator("#password-new")).toHaveJSProperty("type", "password");
  await expect(page.locator("#password-confirm")).toHaveJSProperty("type", "password");
  await expect(page.locator("#password-old-toggle")).toHaveText("Show");
  await expect(page.locator("#password-new-toggle")).toHaveText("Show");
  await expect(page.locator("#password-confirm-toggle")).toHaveText("Show");
  await expect(page.locator("#password-old-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#password-new-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#password-confirm-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("session card hides for the user role", async ({ page }) => {
  await page.goto("http://localhost:8011/", { waitUntil: "domcontentloaded" });
  await page.fill("#login-campus", "PROTO");
  await page.fill("#pass-id", "U-001");
  await page.fill("#password", "Proto-Pass!1");
  await page.click("#login-submit");
  await expect(page.locator("#attendance-login-status")).toContainText("U-001", { timeout: 5000 });

  // Generate-Session card should be hidden for role 'user'.
  await expect(page.locator("#session-zone")).toBeHidden();
});
