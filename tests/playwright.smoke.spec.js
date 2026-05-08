import { test, expect } from "@playwright/test";

// Smoke test for the Supabase Auth login flow.
//
// Prereqs:
//   * Supabase project with supabase/schema.sql applied.
//   * Prototype users seeded:  npm run seed (uses scripts/seed-prototype.mjs).
//   * config.local.js pointing at the Supabase URL + publishable/anon key.
//   * Static site served at http://localhost:8011/.
//   * Seed credentials: U-001 / Proto-Pass!1 (pre-claimed, no forced change).

test("pass-ID login signs in, persists across reload, and logs out", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("http://localhost:8011/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#login-title")).toHaveText("Pass ID authentication");
  await expect(page.locator("#login-submit")).toHaveText("Log in");
  await expect(page.locator("#logout")).toBeHidden();
  await expect(page.locator("#settings-toggle")).toBeHidden();

  // Wrong password → generic failure.
  await page.fill("#pass-id", "U-001");
  await page.fill("#password", "Wrong-Pass!1");
  await page.click("#login-submit");
  await expect(page.locator("#login-status")).toContainText("incorrect");

  // Correct password → logged in.
  await page.fill("#password", "Proto-Pass!1");
  await page.click("#login-submit");
  await expect(page.locator("#attendance-login-status")).toContainText("U-001", { timeout: 5000 });
  await expect(page.locator("#logout")).toBeVisible();
  await expect(page.locator("#settings-toggle")).toBeVisible();

  // Persistence across reload (Supabase Auth refresh in localStorage).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#attendance-login-status")).toContainText("U-001", { timeout: 5000 });

  // Logout clears the session.
  await page.click("#logout");
  await expect(page.locator("#attendance-login-status")).toHaveText("Not logged in", { timeout: 5000 });
  await expect(page.locator("#logout")).toBeHidden();
  await expect(page.locator("#settings-toggle")).toBeHidden();

  expect(errors).toEqual([]);
});

test("settings dialog opens with dark mode toggle and change-password button", async ({ page }) => {
  await page.goto("http://localhost:8011/", { waitUntil: "domcontentloaded" });
  await page.fill("#pass-id", "U-001");
  await page.fill("#password", "Proto-Pass!1");
  await page.click("#login-submit");
  await expect(page.locator("#settings-toggle")).toBeVisible({ timeout: 5000 });

  await page.click("#settings-toggle");
  await expect(page.locator("#dark-mode-toggle")).toBeVisible();
  await expect(page.locator("#settings-change-password")).toBeVisible();
  await expect(page.locator("#notifications-list")).toBeVisible();
});
