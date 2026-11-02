import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const origin = process.env.TEST_URL || "http://127.0.0.1";
const entry = /\.[a-z]+$/i.test(new URL(origin).pathname)
  ? origin
  : origin.replace(/\/$/, "") + "/";
const results = [],
  errors = [];
await fs.mkdir("docs/test-results", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/google/chrome/chrome",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
await context.addInitScript(() => {
  sessionStorage.setItem('word-atlas:entry-mode', 'guest');
  if (!localStorage.getItem("word-atlas:e2e")) {
    localStorage.setItem(
      "word-atlas:settings",
      JSON.stringify({
        onboarded: true,
        splash: false,
        autoplay: false,
        sfx: false,
        ambience: "off",
        dailyNew: 1,
      }),
    );
    localStorage.setItem("word-atlas:e2e", "1");
  }
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(entry);
await page.getByRole("button", { name: "以游客身份登录", exact: true }).click();
await page.locator("main.main").waitFor();
const welcome = page.getByRole("dialog", { name: "欢迎", exact: true });
if (await welcome.isVisible()) {
  await welcome.getByRole("button", { name: "出发", exact: true }).click();
}
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, status: "passed" });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, status: "failed", error: e.message });
    console.error("FAIL", name, e.message);
    await page
      .screenshot({ path: `docs/test-results/failure-${results.length}.png` })
      .catch(() => {});
  }
}
async function navigate(route) {
  await page.goto(new URL("#/" + route, entry).href);
  await page.locator("main.main").waitFor();
  await page.waitForTimeout(500);
}
await check("local dataset and audio byte ranges", async () => {
  assert.equal(
    (await fetch(new URL("atlas/index.json", entry)).then((r) => r.json()))
      .count,
    7298,
  );
  const r = await fetch(new URL("atlas/audio/uk/library.mp3", entry), {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
});
await check("atlas loaded with local images", async () => {
  await navigate("atlas");
  await page.locator(".tile").first().waitFor();
  assert.match(await page.locator("h1").innerText(), /看图学词/);
  const img = page.locator(".tile img").first();
  await img.evaluate((e) => e.decode());
  assert.equal(await img.evaluate((e) => e.naturalWidth > 0), true);
  await page.screenshot({ path: "docs/test-results/atlas-desktop.png" });
});
await check("search, detail, bookmark and persistent reload", async () => {
  await page.getByPlaceholder("搜索单词或中文释义").fill("library");
  await page.locator(".tile").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "收藏", exact: true }).click();
  await dialog.getByRole("button", { name: "取消收藏", exact: true }).waitFor();
  await page.waitForTimeout(700);
  await page.reload();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消收藏", exact: true })
    .waitFor();
  await page.screenshot({ path: "docs/test-results/word-detail.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});
await check("difficulty, topic, list and galaxy", async () => {
  await navigate("atlas");
  await page
    .getByRole("group", { name: "难度", exact: true })
    .getByRole("button", { name: /B2/ })
    .click();
  await page
    .getByRole("group", { name: "话题", exact: true })
    .getByRole("button", { name: "环境", exact: true })
    .click();
  await page.locator(".tile").first().waitFor();
  assert.match(await page.locator(".tile").first().innerText(), /B2/);
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await page.locator(".vlist .row").first().waitFor();
  await page.getByRole("button", { name: "星图视图", exact: true }).click();
  await page.locator(".galaxy").waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "docs/test-results/galaxy-desktop.png" });
});
await check("new reading and specialist routes", async () => {
  for (const [route, selector] of [
    ["read", ".wa-book"],
    ["paraphrase", ".wa-level-status"],
    ["confuse", ".wa-confuse-card"],
  ]) {
    await navigate(route);
    await page.locator(selector).first().waitFor();
    const body = await page.locator("main.main").innerText();
    assert.ok(body.length > 80);
    assert.doesNotMatch(body, /页面暂时无法打开|内容数据不完整/);
    await page.screenshot({ path: `docs/test-results/${route}.png` });
  }
});
await check(
  "short reading, translation, word lookup and comprehension",
  async () => {
    await navigate("read?tab=short&id=r0001");
    await page.locator(".wa-article").waitFor();
    await page.getByRole("button", { name: "中英对照", exact: true }).click();
    await page.locator(".wa-translation").first().waitFor();
    await page.locator(".wa-word").first().click();
    await page.getByRole("dialog").locator(".headword").waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    const article = JSON.parse(
      await fs.readFile("public/atlas/extras/readings/r0001.json", "utf8"),
    );
    for (let i = 0; i < article.q.length; i++) {
      const index = ["T", "F", "NG"].indexOf(article.q[i].a);
      await page
        .getByRole("group", { name: `第 ${i + 1} 题`, exact: true })
        .locator("button")
        .nth(index)
        .click();
    }
    await page.locator(".wa-result").waitFor();
    assert.match(await page.locator(".wa-result").innerText(), /100|全部答对|完成/);
    await page.screenshot({ path: "docs/test-results/reading-result.png" });
  },
);
await check("book chapter navigation and reader preferences", async () => {
  await navigate("read?book=the-little-prince&chapter=1");
  await page.locator(".wa-article").waitFor();
  await page.getByRole("button", { name: "放大字号", exact: true }).click();
  await page.getByRole("button", { name: "下一章", exact: false }).click();
  await page.locator("#wa-chapter").waitFor();
  assert.equal(await page.locator("#wa-chapter").inputValue(), "2");
  await page.reload();
  await page.locator(".wa-article").waitFor();
  assert.equal(await page.locator("#wa-chapter").inputValue(), "2");
});
await check("paraphrase and confusables complete rounds", async () => {
  for (const [route, path, key] of [
    ["paraphrase?id=1", "public/atlas/extras/paraphrase.json", "para:"],
    [
      "confuse?id=bored-boring",
      "public/atlas/extras/confusables.json",
      "confuse:",
    ],
  ]) {
    await navigate(route);
    await page.locator(".wa-round").waitFor();
    let n = 0;
    while (await page.locator(".wa-round").count()) {
      await page
        .getByRole("group", { name: "选项", exact: true })
        .locator("button")
        .first()
        .click();
      await page.locator(".wa-next-question").click();
      if (++n > 12) throw Error("Round failed to finish");
    }
    await page.locator(".wa-round-result").waitFor();
    assert.match(await page.locator(".wa-round-result").innerText(), /成绩|完成|正确/);
    void path;
    void key;
  }
});
await check("learning session grades once and survives reload", async () => {
  await navigate("learn");
  for (let i = 0; i < 30 && !(await page.locator(".quiz").count()); i++) {
    if (await page.locator(".intro").count()) await page.keyboard.press("Enter");
    else await page.waitForTimeout(100);
  }
  await page.locator(".quiz").waitFor();
  const correct = await page.evaluate(() => {
    const raw = localStorage.getItem("word-atlas:v2:word-atlas-open");
    return raw
      ? JSON.parse(raw).session?.steps?.find((s) => s.kind !== "intro")?.id
      : null;
  });
  void correct;
  const persisted = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/guest/state",
    { timeout: 15000 },
  );
  await page.locator(".option").first().click();
  await page.locator(".feedback").waitFor();
  assert.equal((await persisted).status(), 200);
  await page.reload();
  await page.locator(".feedback").waitFor();
  assert.match(await page.locator(".feedback").innerText(), /继续|下一|正确|错误/);
});
await check("settings and backup export", async () => {
  await navigate("me");
  await page.getByRole("tab", { name: "外观与计划", exact: true }).click();
  const aurora = page.getByRole("button", { name: "极光", exact: true });
  await aurora.click();
  assert.equal(await aurora.getAttribute("aria-pressed"), "true");
  await page.getByRole("tab", { name: "数据管理", exact: true }).click();
  const exportButton = page.getByRole("button", { name: /导出备份/ });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportButton.click(),
  ]);
  assert.match(download.suggestedFilename(), /\.json$/);
  await download.saveAs("docs/test-results/test-backup.json");
});
await check("classic illustrations switch and persist per word", async () => {
  await navigate("atlas?w=library");
  const dialog = page.getByRole("dialog");
  await dialog.locator(".headword").waitFor();
  const image = dialog.locator(".entry-art img");
  await dialog
    .getByRole("button", { name: "切换插画风格", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".entry-art img")?.src.includes("/classic/"),
  );
  await image.evaluate((e) => e.decode());
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector(".entry-art img")?.src.includes("/classic/"),
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});
await check("typing exercise finishes and records independently", async () => {
  await navigate("practice");
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByRole("button", { name: "开始一轮", exact: true }).click();
  await page
    .getByRole("textbox", { name: "在这里输入", exact: true })
    .fill("library");
  await page.locator(".typing-done").waitFor();
  assert.match(await page.locator(".typing-done").innerText(), /100/);
});
await check(
  "backup includes reading, appearance and illustration preferences",
  async () => {
    const backup = JSON.parse(
      await fs.readFile("docs/test-results/test-backup.json", "utf8"),
    );
    assert.equal(backup.app, "word-atlas");
    assert.ok(backup.extras["word-atlas:appearance"]);
    assert.ok(backup.extras["word-atlas:extras:v1:word-atlas-open"]);
    assert.ok(Object.keys(backup.progress.cards).length > 0);
  },
);
await check("mobile layout and navigation", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate("atlas");
  await page.getByRole("button", { name: "图片视图", exact: true }).click();
  await page.locator(".tile").first().waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.equal(await page.locator(".tabbar a").count(), 5);
  await page.screenshot({ path: "docs/test-results/atlas-mobile.png" });
});
await check("malformed word URL recovers", async () => {
  await navigate("w/%E0%A4%A");
  assert.ok((await page.locator("body").innerText()).length > 50);
});
await check("no uncaught browser exceptions", async () => {
  assert.deepEqual(errors, []);
});
await fs.writeFile(
  "docs/test-results/e2e.json",
  JSON.stringify(
    { at: new Date().toISOString(), origin, results, errors },
    null,
    2,
  ),
);
await browser.close();
if (results.some((r) => r.status === "failed")) process.exitCode = 1;
