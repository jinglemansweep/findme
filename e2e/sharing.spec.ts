import { expect, test, type APIRequestContext } from "@playwright/test";

const LABEL = "E2E test pin";

interface SeededPin {
  slug: string;
  secret: string;
  publicUrl: string;
  privateUrl: string;
  expiresAt: number;
}

/**
 * Create a pin over the API (with a per-test client IP so the suite never
 * exhausts the shared browser-IP creation budget) for tests that exercise a
 * flow rather than the create form itself.
 */
async function seedPin(
  request: APIRequestContext,
  ip: string,
  body: Record<string, unknown> = {},
): Promise<SeededPin> {
  const res = await request.post("/api/pins", {
    headers: { "CF-Connecting-IP": ip },
    data: { ttl: 900, ...body },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as SeededPin;
}

/**
 * Full lifecycle against the real Worker (local wrangler dev): create a share
 * with a granted fake geolocation fix, read it as a fresh visitor, then stop
 * it and watch the visitor's page turn ended. Asserts on app state, never on
 * basemap tiles (the CI config serves no PMTiles archive).
 */
test("create, view, then stop a share", async ({ browser }) => {
  const creator = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 51.5007, longitude: -0.1246, accuracy: 25 },
  });
  const creatorPage = await creator.newPage();

  await creatorPage.goto("/");
  await creatorPage.getByLabel("Message (optional)").fill(LABEL);
  // The page also offers the fix automatically once permission is granted;
  // pressing the button is the deterministic path.
  await creatorPage.getByRole("button", { name: "Use my location" }).click();
  const share = creatorPage.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeEnabled({ timeout: 15_000 });
  await share.click();

  // The control page boots from /u/:slug#s_…, then strips the fragment.
  await creatorPage.waitForURL(/\/u\/[0-9A-HJKMNP-TV-Z]{12}$/);
  await expect(creatorPage.getByText("Share Control")).toBeVisible();

  const publicUrl = await creatorPage.getByLabel("Your share link").inputValue();
  expect(publicUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/[0-9A-HJKMNP-TV-Z]{12}$/);

  // A fresh visitor — separate storage, no secret — sees the live position.
  const viewer = await browser.newContext();
  const viewerPage = await viewer.newPage();
  await viewerPage.goto(publicUrl);
  await expect(viewerPage.locator(".pin-label")).toHaveText(LABEL);
  await expect(viewerPage.locator(".freshness")).toContainText("Updated", { timeout: 15_000 });

  // Stopping deletes the position; the visitor's next poll (≤5s) shows ended.
  await creatorPage.getByRole("button", { name: "Stop sharing" }).click();
  await creatorPage.getByRole("button", { name: "Yes, stop sharing" }).click();
  await creatorPage.waitForURL((url) => url.pathname === "/");
  await expect(viewerPage.getByRole("heading", { name: "This share has ended" })).toBeVisible({
    timeout: 15_000,
  });

  await creator.close();
  await viewer.close();
});

test("an unknown slug reads as not found", async ({ page }) => {
  await page.goto("/0123456789AB");
  await expect(page.getByRole("heading", { name: "This link doesn't match a share" })).toBeVisible();
});

test("the control page survives a reload and the create page funnels back", async ({ browser }) => {
  const creator = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 51.5007, longitude: -0.1246, accuracy: 25 },
  });
  const page = await creator.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: "Use my location" }).click();
  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeEnabled({ timeout: 15_000 });
  await share.click();
  await page.waitForURL(/\/u\/[0-9A-HJKMNP-TV-Z]{12}$/);
  await expect(page.getByText("Share Control")).toBeVisible();

  // A reload loses the URL fragment — the secret is recovered from this
  // device's storage instead of dead-ending the owner.
  await page.reload();
  await expect(page.getByText("Share Control")).toBeVisible({ timeout: 10_000 });

  // With a live session stored, the create page redirects straight back.
  await page.goto("/");
  await page.waitForURL(/\/u\/[0-9A-HJKMNP-TV-Z]{12}$/);
  await creator.close();
});

test("replacing the control link invalidates the old one", async ({ request, browser }) => {
  const pin = await seedPin(request, "198.51.100.21");
  const page = await (await browser.newContext()).newPage();
  await page.goto(pin.privateUrl);
  await expect(page.getByText("Share Control")).toBeVisible();

  // Two-tap confirm: the armed state flips the button's accessible name.
  await page.getByRole("button", { name: "Replace control link" }).click();
  const armed = page.getByRole("button", { name: "Tap again to replace the control link" });
  await expect(armed).toBeVisible();
  await page.waitForTimeout(400); // past the double-tap guard
  await armed.click();

  const newLink = page.getByLabel("Your control link");
  await expect(newLink).toBeVisible();
  const newUrl = await newLink.inputValue();
  expect(newUrl).toMatch(/#s_/);
  expect(newUrl).not.toBe(pin.privateUrl);

  // The old link is dead…
  const stale = await (await browser.newContext()).newPage();
  await stale.goto(pin.privateUrl);
  await expect(stale.getByRole("heading", { name: "This control link isn't valid" })).toBeVisible();
  // …and the new one works.
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(newUrl);
  await expect(fresh.getByText("Share Control")).toBeVisible();
});

test("extending the share is visible to the owner and to an open viewer", async ({ request, browser }) => {
  const pin = await seedPin(request, "198.51.100.22", { lat: 51.5007, lng: -0.1246, accuracy: 20 });

  const owner = await (await browser.newContext()).newPage();
  await owner.goto(pin.privateUrl);
  await expect(owner.getByText("Share Control")).toBeVisible();
  await expect(owner.locator(".expiry-note")).toContainText("14m", { timeout: 10_000 });

  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(pin.publicUrl);
  await expect(viewer.locator(".expiry")).toContainText("14m", { timeout: 10_000 });

  await owner.getByRole("button", { name: "+1 hour" }).click();
  await expect(owner.locator(".expiry-note")).toContainText("1h", { timeout: 5_000 });
  // The viewer's countdown follows on its next poll — no reload needed.
  await expect(viewer.locator(".expiry")).toContainText("1h", { timeout: 15_000 });
});

test("a viewer survives losing the connection and resumes when it returns", async ({ request, browser }) => {
  const pin = await seedPin(request, "198.51.100.23", { lat: 51.5007, lng: -0.1246, accuracy: 20 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(pin.publicUrl);
  await expect(page.locator(".freshness")).toContainText("Updated", { timeout: 15_000 });

  // Offline: after two failed polls the banner says what happened and the
  // last known position stays on screen.
  await ctx.setOffline(true);
  await expect(page.getByRole("alert")).toContainText("Can't reach the server", { timeout: 30_000 });

  // Back online: the next poll clears the banner without a reload.
  await ctx.setOffline(false);
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".freshness")).toContainText("Updated");
});
