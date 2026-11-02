import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

// One browser and a source-only fixture: no application server, DB, build or production TLS.
test(
  "compact admin console fits populated panels and preserves authentication and certificate safety",
  { timeout: 180_000 },
  async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "atlas-admin-ui-"));
    const server = await createServer({
      configFile: false,
      publicDir: false,
      appType: "custom",
      cacheDir,
      optimizeDeps: {
        noDiscovery: true,
        entries: [],
        include: [
          "react",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "lucide-react",
        ],
      },
      server: {
        port: 0,
        host: "127.0.0.1",
        watch: null,
        hmr: false,
        preTransformRequests: false,
      },
      plugins: [
        {
          name: "admin-fixture",
          resolveId(id) {
            if (id === "/admin-fixture-mount.js")
              return "\0admin-fixture-mount";
          },
          load(id) {
            if (id === "\0admin-fixture-mount")
              return `import '/src/styles/app.css'; import React from 'react'; import {createRoot} from 'react-dom/client'; import {AdminPage, AdminTools} from '/src/pages/Admin.tsx'; createRoot(document.getElementById('root')).render(React.createElement(location.search.includes('legacy') ? AdminTools : AdminPage));`;
          },
          configureServer(s) {
            s.middlewares.use("/admin-fixture", (_req, res) => {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<!doctype html><html data-theme="light"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin UI fixture</title><div id="root"></div><script type="module" src="/admin-fixture-mount.js"></script></html>',
              );
            });
          },
        },
      ],
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const user = {
        id: "admin-fixture",
        username: "fixture-admin",
        nickname: "管理员",
        role: "admin",
        disabled: false,
        email: null,
        emailVerified: false,
      };
      const now = Date.now();
      const certificate = {
        subject: "CN=atlas.example",
        issuer: "Fixture CA",
        domain: "atlas.example",
        validFrom: now - 86400000,
        validTo: now + 864000000,
        fingerprint256: Array(32).fill("AA").join(":"),
        daysRemaining: 10,
        serialNumber: "01",
      };
      const calls: {
        path: string;
        method: string;
        body: Record<string, unknown> | null;
      }[] = [];
      const storedMailSecret = "stored-mail-secret";
      let mailConfigured = true;
      let mailStatus = {
        configured: true,
        host: "smtp.mail.test",
        port: 465,
        security: "tls",
        user: "mailer@example.test",
        from: "mailer@example.test",
        fromName: "邮件服务",
        secretConfigured: true,
      };
      let role = "user",
        overviewUnavailable = false,
        reauthFails = false,
        stageFails = false,
        signedOut = false,
        sessionUnavailable = false;
      await page.route("**/api/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const body = request.postDataJSON() as Record<string, unknown> | null;
        calls.push({
          path: url.pathname + url.search,
          method: request.method(),
          body,
        });
        const reply = (json: unknown, status = 200) =>
          route.fulfill({ status, json });
        if (url.pathname === "/api/auth/session")
          return sessionUnavailable ? reply({error:'会话服务暂不可用'},503) : reply({
            user: signedOut ? null : { ...user, role },
            csrfToken: "fixture-csrf",
            enabled: true,
            emailEnabled: false,
          });
        if (url.pathname === "/api/auth/reauth")
          return reply(
            reauthFails ? { error: "密码验证失败" } : { ok: true },
            reauthFails ? 403 : 200,
          );
        if (url.pathname === "/api/auth/password") {
          signedOut = true;
          return reply({ ok: true });
        }
        if (url.pathname === "/api/auth/logout") {
          signedOut = true;
          return reply({ ok: true });
        }
        if (url.pathname === "/api/admin/overview")
          return overviewUnavailable
            ? reply({ error: "unavailable" }, 503)
            : reply({
                project: { uptimeSeconds: 3661, startedAt: now - 3661000 },
                host: {
                  uptimeSeconds: 90000,
                  load: [0.2, 0.3, 0.1],
                  cpus: 2,
                  memory: { total: 8e9, free: 3e9, used: 5e9 },
                  disk: { total: 1e11, free: 6e10, used: 4e10 },
                },
                checks: [{ name: "数据库", status: "ok", detail: "读取成功" }],
              });
        if (url.pathname === "/api/admin/services")
          return reply({ error: "Service collection is forbidden" }, 503);
        if (url.pathname === "/api/admin/online")
          return reply({
            users: [
              {
                id: "u1",
                username: "alice",
                nickname: "阿梨",
                kind: "account",
                role: "user",
                sessionCount: 2,
                loggedInAt: now,
                lastActivityAt: now,
                idleExpiresAt: now + 7200000,
                active: true,
              },
              {
                id: "g1",
                username: "游客_TESTNAME",
                nickname: null,
                kind: "guest",
                role: null,
                sessionCount: 1,
                loggedInAt: now,
                lastActivityAt: now - 600000,
                idleExpiresAt: now + 14400000,
                active: false,
              },
              ...Array.from({ length: 121 }, (_, i) => ({
                id: `online-${i}`,
                username: `online-${i}`,
                nickname: "长昵称".repeat(12),
                kind: "account",
                role: "user",
                sessionCount: 1,
                loggedInAt: now,
                lastActivityAt: now,
                idleExpiresAt: now + 7200000,
                active: true,
              })),
            ],
            sampledAt: now,
            activeWindowSeconds: 300,
          });
        if (url.pathname === "/api/admin/logins")
          return reply({
            events: Array.from(
              { length: Number(url.searchParams.get("limit") || 50) },
              (_, i) => ({
                id: `login-${url.searchParams.get("page") || "1"}-${i}`,
                username:
                  url.searchParams.get("page") === "2"
                    ? `bob-${i}`
                    : `alice-${i}`,
                method: "password",
                result: "success",
                createdAt: now,
              }),
            ),
            page: Number(url.searchParams.get("page") || 1),
            pages: Math.ceil(100 / Number(url.searchParams.get("limit") || 50)),
            total: 100,
          });
        if (url.pathname === "/api/admin/users")
          return reply({
            users: [
              user,
              ...Array.from({ length: 120 }, (_, i) => ({
                ...user,
                id: `account-${i}`,
                username: `account-${i}`,
                role: "user",
                nickname: "昵称".repeat(12),
                email: `user-${i}@example.test`,
                emailVerified: true,
              })),
            ],
          });
        if (url.pathname === "/api/admin/mail" && request.method() === "GET")
          return reply(
            mailConfigured
              ? { ...mailStatus, password: storedMailSecret }
              : { configured: false, secretConfigured: false },
          );
        if (url.pathname === "/api/admin/mail" && request.method() === "POST") {
          const candidate = body || {};
          mailConfigured = true;
          mailStatus = {
            configured: true,
            host: String(candidate.host || ""),
            port: Number(candidate.port || 0),
            security: String(candidate.security || ""),
            user: String(candidate.user || ""),
            from: String(candidate.from || ""),
            fromName: String(candidate.fromName || ""),
            secretConfigured: true,
          };
          return reply(mailStatus);
        }
        if (
          url.pathname === "/api/admin/mail/test" &&
          request.method() === "POST"
        )
          return reply({
            ok: true,
            elapsedMs: 37,
            tlsProtocol: "TLSv1.3",
          });
        if (/^\/api\/admin\/users\/[^/]+\/reset$/.test(url.pathname))
          return reply({
            token: "fixture-reset-only",
            expiresAt: now + 900000,
          });
        if (url.pathname === "/api/admin/audit")
          return reply({
            audit: [
              {
                id: 1,
                actorId: user.id,
                targetId: user.id,
                action: "password",
                before: null,
                after: { changed: true },
                createdAt: now,
              },
              ...Array.from({ length: 199 }, (_, i) => ({
                id: i + 2,
                actorId: user.id,
                targetId: `account-${i}`,
                action: `fixture-audit-${i}`,
                before: { disabled: false },
                after: { disabled: true, detail: "fixture".repeat(30) },
                createdAt: now,
              })),
            ],
          });
        if (url.pathname === "/api/admin/certificate")
          return reply({
            mode: "automatic",
            current: certificate,
            previous: certificate,
          });
        if (url.pathname === "/api/admin/certificate/stage")
          return stageFails
            ? reply({ error: "invalid certificate" }, 400)
            : reply({
                stageId: "a".repeat(32),
                certificate,
                expiresAt: now + 900000,
              });
        if (
          /^\/api\/admin\/certificate\/(apply|rollback|automatic)$/.test(
            url.pathname,
          )
        )
          return reply({ ok: true, certificate });
        return reply({ error: "Unexpected fixture request" }, 404);
      });
      const visit = () =>
        page.goto(`${server.resolvedUrls!.local[0]}admin-fixture`);
      await visit();
      await page
        .getByText("请先登录管理员账号。管理权限由服务器验证。", {
          exact: true,
        })
        .waitFor()
        .catch(async (error) => {
          throw new Error(
            `${error.message}\nFixture errors: ${JSON.stringify(errors)}\n${await page.locator("body").innerText()}`,
          );
        });
      assert.equal(
        calls.filter((c) => c.path.startsWith("/api/admin/")).length,
        0,
        "non-admin must not read operational APIs",
      );
      role = "admin";
      await visit();
      const nav = page.getByRole("navigation", { name: "管理控制台导航" });
      await assert.doesNotReject(
        () => nav.waitFor(),
        "admin should receive the integrated console, not only legacy account tools",
      );
      await page.getByText("读取成功", { exact: true }).waitFor();
      sessionUnavailable = true;
      await page.evaluate(async()=>{const m=await import('/src/account/state.tsx' as string);await m.refreshAccount();});
      await page.getByRole('button',{name:'重新验证会话',exact:true}).waitFor();
      assert.equal(await page.locator('a[href="#/me"]').count(),0);
      sessionUnavailable = false;
      await page.getByRole('button',{name:'重新验证会话',exact:true}).click();
      await nav.waitFor();
      const select = async (name: string) => {
        const toggle = page.getByRole("button", {
          name: "展开管理导航",
          exact: true,
        });
        if (await toggle.isVisible()) await toggle.click();
        await nav.getByRole("button", { name, exact: true }).click();
      };
      assert.equal(
        await nav
          .getByRole("button", { name: "服务状态", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.locator('.admin-console a[href="#/me"]').count(),
        0,
      );

      await select("邮件服务");
      const mailPanel = page.locator(".admin-mail-panel");
      const mailStatusCard = mailPanel.locator(".admin-mail-status");
      const mailConfigCard = mailPanel.locator(".admin-mail-config");
      await page
        .getByRole("heading", { name: "当前 SMTP 服务", exact: true })
        .waitFor();
      assert.equal(
        await nav
          .getByRole("button", { name: "邮件服务", exact: true })
          .count(),
        1,
      );
      await page.getByText("smtp.mail.test:465", { exact: true }).waitFor();
      await page.getByText("邮件服务", { exact: true }).last().waitFor();
      assert.equal(
        (await page.getByText("mailer@example.test", { exact: true }).count()) >
          0,
        true,
      );
      assert.equal(
        (await page.locator("body").innerText()).includes(storedMailSecret),
        false,
        "stored authorization code must never appear in the page",
      );
      for (const label of [
        "SMTP 主机",
        "端口",
        "加密方式",
        "用户名",
        "SMTP 授权码",
        "发件地址",
        "发件人名称",
        "管理员密码",
      ])
        assert.equal(
          await page.getByLabel(label, { exact: true }).count(),
          1,
          `mail form must expose ${label}`,
        );
      assert.equal(
        await page.getByLabel("SMTP 授权码", { exact: true }).inputValue(),
        "",
        "stored authorization code is write-only",
      );
      assert.equal(
        await mailPanel.locator("p").count(),
        0,
        "mail panel must not render paragraph-level instructional copy",
      );
      const mailStatusHeight = (await mailStatusCard.boundingBox())!.height;
      const mailConfigHeight = (await mailConfigCard.boundingBox())!.height;

      await page
        .getByLabel("SMTP 主机", { exact: true })
        .fill("smtp.test.test");
      await page.getByLabel("端口", { exact: true }).fill("587");
      await page
        .getByLabel("加密方式", { exact: true })
        .selectOption("starttls");
      await page.getByLabel("用户名", { exact: true }).fill("tester");
      await page
        .getByLabel("SMTP 授权码", { exact: true })
        .fill("candidate-auth-code");
      await page
        .getByLabel("发件地址", { exact: true })
        .fill("tester@example.test");
      await page.getByLabel("发件人名称", { exact: true }).fill("Tester");
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("FixtureOnly!2");
      await page.getByRole("button", { name: "测试连接", exact: true }).click();
      await page.getByText("连接成功", { exact: false }).waitFor();
      const mailTestIndex = calls
        .map(
          (call) =>
            call.path === "/api/admin/mail/test" && call.method === "POST",
        )
        .lastIndexOf(true);
      assert.equal(calls[mailTestIndex - 1].path, "/api/auth/reauth");
      assert.deepEqual(calls[mailTestIndex].body, {
        host: "smtp.test.test",
        port: 587,
        security: "starttls",
        user: "tester",
        password: "candidate-auth-code",
        from: "tester@example.test",
        fromName: "Tester",
      });
      assert.equal(
        await page.getByLabel("SMTP 授权码", { exact: true }).inputValue(),
        "",
        "authorization code must clear after test",
      );
      assert.ok(
        Math.abs(
          (await mailConfigCard.boundingBox())!.height - mailConfigHeight,
        ) < 1,
        "configuration card height must stay stable after status feedback",
      );

      await page
        .getByLabel("SMTP 主机", { exact: true })
        .fill("smtp.saved.test");
      await page.getByLabel("发件人名称", { exact: true }).fill("Saved Sender");
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("FixtureOnly!2");
      assert.equal(
        await page.getByLabel("SMTP 授权码", { exact: true }).inputValue(),
        "",
      );
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await page.getByText("smtp.saved.test:587", { exact: true }).waitFor();
      const mailSaveIndex = calls
        .map(
          (call) => call.path === "/api/admin/mail" && call.method === "POST",
        )
        .lastIndexOf(true);
      assert.equal(calls[mailSaveIndex - 1].path, "/api/auth/reauth");
      assert.deepEqual(calls[mailSaveIndex].body, {
        host: "smtp.saved.test",
        port: 587,
        security: "starttls",
        user: "tester",
        password: "",
        from: "tester@example.test",
        fromName: "Saved Sender",
      });
      assert.ok(
        calls
          .slice(mailSaveIndex + 1)
          .some(
            (call) => call.path === "/api/admin/mail" && call.method === "GET",
          ),
        "save must reload sanitized provider status",
      );

      mailConfigured = false;
      await page
        .getByRole("button", { name: "刷新当前面板", exact: true })
        .click();
      await page.getByText("未配置", { exact: true }).waitFor();
      assert.ok(
        Math.abs(
          (await mailStatusCard.boundingBox())!.height - mailStatusHeight,
        ) < 1,
        "status card height must stay stable when provider status changes",
      );
      for (const [label, value] of [
        ["SMTP 主机", "new.smtp.test"],
        ["端口", "465"],
        ["用户名", "first-user"],
        ["发件地址", "first@example.test"],
        ["发件人名称", "First User"],
        ["管理员密码", "FixtureOnly!2"],
      ] as const)
        await page.getByLabel(label, { exact: true }).fill(value);
      await page.getByLabel("加密方式", { exact: true }).selectOption("tls");
      const saveCount = calls.filter(
        (call) => call.path === "/api/admin/mail" && call.method === "POST",
      ).length;
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "授权码" }).waitFor();
      assert.equal(
        calls.filter(
          (call) => call.path === "/api/admin/mail" && call.method === "POST",
        ).length,
        saveCount,
        "first-time blank authorization code must not call the save API",
      );
      assert.ok(
        Math.abs(
          (await mailConfigCard.boundingBox())!.height - mailConfigHeight,
        ) < 1,
        "configuration card height must stay stable after validation feedback",
      );
      mailConfigured = true;
      await page
        .getByRole("button", { name: "刷新当前面板", exact: true })
        .click();
      await page.getByText("已配置", { exact: true }).waitFor();

      const sizes = [
        [1366, 768],
        [1280, 640],
        [1440, 900],
        [768, 900],
        [390, 844],
        [375, 667],
        [320, 568],
        [844, 390],
      ] as const;
      const fit = async (label: string) => {
        // Wait for resize-driven pagination, then inspect real layout, not source/CSS strings.
        await page.evaluate(
          () =>
            new Promise<void>((r) =>
              requestAnimationFrame(() => requestAnimationFrame(() => r())),
            ),
        );
        const metrics = await page.evaluate(() => ({
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
          viewportHeight: innerHeight,
          viewportWidth: innerWidth,
          panelScroll: [
            ...document.querySelectorAll<HTMLElement>(
              ".admin-panel-stack, .admin-table-scroll",
            ),
          ]
            .filter(
              (e) =>
                e.getClientRects().length &&
                e.scrollHeight > e.clientHeight + 1,
            )
            .map((e) => ({
              className: e.className,
              height: e.clientHeight,
              content: e.scrollHeight,
            })),
          clipped: [
            ...document.querySelectorAll<HTMLElement>(
              ".admin-panel-stack, .admin-card",
            ),
          ]
            .filter(
              (e) =>
                e.getClientRects().length &&
                e.scrollHeight > e.clientHeight + 1 &&
                getComputedStyle(e).overflowY === "hidden",
            )
            .map((e) => e.className),
          smallInputs: [
            ...document.querySelectorAll<HTMLElement>(
              ".admin-console input, .admin-console textarea, .admin-console select",
            ),
          ].filter(
            (e) =>
              e.getClientRects().length &&
              parseFloat(getComputedStyle(e).fontSize) < 16,
          ).length,
        }));
        assert.ok(
          metrics.height <= metrics.viewportHeight + 1,
          `${label}: document height ${JSON.stringify(metrics)}`,
        );
        assert.ok(
          metrics.width <= metrics.viewportWidth,
          `${label}: document width ${JSON.stringify(metrics)}`,
        );
        assert.deepEqual(
          metrics.clipped,
          [],
          `${label}: controls must not be clipped`,
        );
        if (metrics.viewportWidth >= 1280 && metrics.viewportHeight >= 640)
          assert.deepEqual(
            metrics.panelScroll,
            [],
            `${label}: desktop must fit without vertical panel scrolling`,
          );
        if (metrics.viewportWidth <= 760 || metrics.viewportHeight <= 440)
          assert.equal(metrics.smallInputs, 0, `${label}: mobile input zoom`);
        const controls = page.locator(
          ".admin-content button:visible, .admin-content input:visible, .admin-content textarea:visible, .admin-content summary:visible",
        );
        for (const control of await controls.all()) {
          await control.scrollIntoViewIfNeeded().catch((e) => {
            throw new Error(`${label}: ${e.message}`);
          });
          const box = await control.boundingBox();
          assert.ok(
            box &&
              box.y >= -1 &&
              box.y + box.height <= metrics.viewportHeight + 1 &&
              box.x >= -1 &&
              box.x + box.width <= metrics.viewportWidth + 1,
            `${label}: unreachable control ${(await control.getAttribute("aria-label")) || (await control.textContent())}`,
          );
        }
        assert.equal(
          await page.evaluate(() => scrollY),
          0,
          `${label}: reaching controls must not scroll the document`,
        );
      };
      const counts: Record<string, Record<string, number>> = {};
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        for (const panel of [
          "运行概览",
          "在线用户",
          "登录历史",
          "账号管理",
          "SSL 证书",
          "邮件服务",
          "安全与审计",
        ]) {
          await select(panel);
          await page.waitForFunction(
            () =>
              !document.querySelector('.admin-empty[role="status"]') &&
              !document.querySelector('[aria-busy="true"]'),
          );
          await fit(`${width}x${height} ${panel}`);
          if (panel === "安全与审计") {
            await page
              .getByRole("button", { name: "安全审计", exact: true })
              .click();
            await fit(`${width}x${height} audit`);
          }
          if (panel === "SSL 证书") {
            await page
              .getByRole("button", { name: "上一版本", exact: true })
              .click();
            await fit(`${width}x${height} previous certificate`);
            await page
              .getByRole("button", { name: "导入并验证", exact: true })
              .click();
            await fit(`${width}x${height} certificate import`);
          }
          if (panel === "邮件服务") {
            assert.equal(
              await page.locator(".admin-mail-panel p").count(),
              0,
              "mail panel must not render instructional paragraphs",
            );
            assert.equal(
              await page.evaluate(() => {
                const panel =
                  document.querySelector<HTMLElement>(".admin-mail-panel");
                return panel ? panel.scrollWidth > panel.clientWidth + 1 : true;
              }),
              false,
              `${width}x${height}: mail panel must not overflow horizontally`,
            );
          }
          if (
            ["在线用户", "登录历史", "账号管理", "安全与审计"].includes(panel)
          ) {
            (counts[`${width}x${height}`] ||= {})[panel] = await page
              .locator(".admin-table tbody tr, .account-admin-user")
              .count();
            const next = page.getByRole("button", {
              name: "下一页",
              exact: true,
            });
            assert.equal(
              await next.isDisabled(),
              false,
              `${panel}: large datasets must be paginated`,
            );
            const before = await page
              .locator(".admin-table tbody, .account-admin-grid")
              .innerText();
            await next.click();
            await page.waitForFunction(
              before => !document.querySelector('[aria-busy="true"]') &&
                (document.querySelector<HTMLElement>('.admin-table tbody, .account-admin-grid')?.innerText ?? before) !== before,
              before,
            );
            assert.notEqual(
              await page
                .locator(".admin-table tbody, .account-admin-grid")
                .innerText(),
              before,
              `${panel}: next page must expose more records`,
            );
            await fit(`${width}x${height} ${panel} next`);
          }
        }
      }
      for (const panel of ["在线用户", "登录历史", "账号管理", "安全与审计"])
        assert.ok(
          counts["1440x900"][panel] > counts["320x568"][panel],
          `${panel}: pagination must respond to available height`,
        );
      await page.setViewportSize({ width: 1366, height: 768 });
      // The last records must be reachable through pages, not merely absent from the DOM.
      for (const [panel, last] of [
        ["在线用户", "online-120"],
        ["账号管理", "account-119"],
        ["安全与审计", "fixture-audit-198"],
      ]) {
        await select(panel);
        if (panel === "安全与审计")
          await page
            .getByRole("button", { name: "安全审计", exact: true })
            .click();
        const next = page.getByRole("button", { name: "下一页", exact: true });
        await next.waitFor();
        for (let i = 0; i < 200 && !(await next.isDisabled()); i++)
          await next.click();
        await page.getByText(last, { exact: panel !== "账号管理" }).waitFor();
        await fit(`${panel} last page`);
      }
      await select("账号管理");
      await page
        .getByRole("button", { name: "禁用账号", exact: true })
        .first()
        .click();
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await fit(`${width}x${height} account confirmation`);
      }
      await page.getByRole("button", { name: "取消操作", exact: true }).click();
      assert.equal(
        calls.some((c) => /\/users\/[^/]+\/status$/.test(c.path)),
        false,
        "cancelling must never change account status",
      );
      await page
        .getByRole("button", { name: "生成重置凭据", exact: true })
        .first()
        .click();
      await page
        .getByLabel("管理员密码", { exact: true })
        .fill("FixtureOnly!2");
      await page
        .getByRole("button", { name: "重新验证并执行", exact: true })
        .click();
      await page.getByLabel("一次性凭据", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("一次性凭据", { exact: true }).inputValue(),
        "fixture-reset-only",
      );
      const resetIndex = calls.findIndex((c) =>
        /\/users\/[^/]+\/reset$/.test(c.path),
      );
      assert.equal(calls[resetIndex - 1].path, "/api/auth/reauth");
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await fit(`${width}x${height} one-time account credential`);
      }
      await page.getByRole("button", { name: "隐藏凭据", exact: true }).click();
      assert.equal(
        await page.getByLabel("一次性凭据", { exact: true }).count(),
        0,
      );
      await page.setViewportSize({ width: 1366, height: 768 });
      await select("运行概览");
      overviewUnavailable = true;
      await page.getByRole("button", { name: "刷新当前面板" }).click();
      await page.getByRole("alert").filter({ hasText: "暂不可用" }).waitFor();
      assert.equal(
        await page.getByText("读取成功", { exact: true }).count(),
        0,
        "failed refresh cannot retain a false healthy snapshot",
      );
      overviewUnavailable = false;
      await select("在线用户");
      await page.getByText("alice", { exact: true }).waitFor();
      await page.getByText("阿梨", { exact: true }).waitFor();
      await page
        .getByText("游客_TESTNAME", { exact: true })
        .waitFor({ timeout: 1500 });
      await select("登录历史");
      await page.getByLabel("搜索登录用户名").fill("alice & test");
      await page.getByRole("button", { name: "搜索历史", exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-busy="true"]'),
      );
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await page.getByText("bob-0", { exact: true }).waitFor();
      assert.ok(
        calls.some((c) =>
          c.path.startsWith(
            "/api/admin/logins?q=alice%20%26%20test&page=2&limit=",
          ),
        ),
      );
      await select("账号管理");
      await page
        .getByRole("button", { name: "生成重置凭据", exact: true })
        .first()
        .waitFor();
      await select("SSL 证书");
      await page.getByText("atlas.example", { exact: true }).first().waitFor();
      await page
        .getByRole("button", { name: "导入并验证", exact: true })
        .click();
      const certInput = page.getByLabel("证书链文件（fullchain PEM）"),
        keyInput = page.getByLabel("私钥文件（PEM）");
      await certInput.setInputFiles({
        name: "too-large.pem",
        mimeType: "text/plain",
        buffer: Buffer.alloc(1024 * 1024),
      });
      await page
        .getByRole("alert")
        .filter({ hasText: /大小|超过/ })
        .waitFor();
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await fit(`${width}x${height} certificate error`);
      }
      assert.equal(calls.filter((c) => c.path.endsWith("/stage")).length, 0);
      const certificatePem =
        "-----BEGIN CERTIFICATE-----\nfixture-chain\n-----END CERTIFICATE-----";
      const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----";
      const chooseFiles = async () => {
        await certInput.setInputFiles({
          name: "fullchain.pem",
          mimeType: "text/plain",
          buffer: Buffer.from(certificatePem),
        });
        await keyInput.setInputFiles({
          name: "key.pem",
          mimeType: "text/plain",
          buffer: Buffer.from(privateKeyPem),
        });
        await page.getByLabel("暂存验证密码").fill("FixtureOnly!2");
      };
      await chooseFiles();
      stageFails = true;
      await page
        .getByRole("button", { name: "验证并暂存", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "确认应用证书", exact: true })
          .count(),
        0,
        "invalid stage cannot be applied",
      );
      stageFails = false;
      await page.getByLabel("暂存验证密码").fill("FixtureOnly!2");
      await page
        .getByRole("button", { name: "验证并暂存", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "待确认的证书", exact: true })
        .waitFor();
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await fit(`${width}x${height} staged certificate`);
      }
      await page.setViewportSize({ width: 1366, height: 768 });
      assert.equal(await certInput.inputValue(), "");
      assert.equal(await keyInput.inputValue(), "");
      assert.equal(
        await page
          .locator('button[type="submit"]')
          .filter({ hasText: "验证并暂存" })
          .isDisabled(),
        true,
        "staging clears the component PEM state as well as native inputs",
      );
      const stageIndex = calls
        .map((c) => c.path)
        .lastIndexOf("/api/admin/certificate/stage");
      assert.equal(calls[stageIndex - 1].path, "/api/auth/reauth");
      assert.deepEqual(calls[stageIndex].body, {
        certificatePem,
        privateKeyPem,
      });
      assert.equal(
        calls.some((c) => c.path.endsWith("/apply")),
        false,
        "staging never applies implicitly",
      );
      assert.equal(
        await page.evaluate(
          (key) =>
            Object.values(localStorage).some((v) => String(v).includes(key)),
          privateKeyPem,
        ),
        false,
      );
      await page.getByLabel("证书操作验证密码").fill("FixtureOnly!2");
      await page.getByLabel("我已核对证书域名、有效期与指纹").check();
      await page
        .getByRole("button", { name: "确认应用证书", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "证书操作已完成" })
        .waitFor();
      assert.deepEqual(calls.find((c) => c.path.endsWith("/apply"))?.body, {
        stageId: "a".repeat(32),
      });
      for (const [button, action] of [
        ["回滚到上一版本", "rollback"],
        ["恢复自动续期", "automatic"],
      ] as const) {
        await page
          .getByRole("button", { name: "当前证书", exact: true })
          .click();
        await page.getByRole("button", { name: button, exact: true }).click();
        await page.getByLabel("证书操作验证密码").fill("FixtureOnly!2");
        await page
          .getByRole("button", { name: "确认执行", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "证书操作已完成" })
          .waitFor();
        const index = calls
          .map((c) => c.path)
          .lastIndexOf("/api/admin/certificate/" + action);
        assert.equal(calls[index - 1].path, "/api/auth/reauth");
        assert.deepEqual(calls[index].body, {});
      }
      reauthFails = true;
      await page
        .getByRole("button", { name: "导入并验证", exact: true })
        .click();
      await chooseFiles();
      const stageCount = calls.filter((c) => c.path.endsWith("/stage")).length;
      await page
        .getByRole("button", { name: "验证并暂存", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      assert.equal(
        calls.filter((c) => c.path.endsWith("/stage")).length,
        stageCount,
        "failed reauth cannot upload PEM",
      );
      reauthFails = false;
      await select("安全与审计");
      await page
        .getByRole("heading", { name: "修改管理员密码", exact: true })
        .waitFor();
      await page.getByLabel("当前密码", { exact: true }).fill("FixtureOnly!2");
      await page.getByLabel("新密码", { exact: true }).fill("weakpass");
      await page.getByLabel("确认新密码", { exact: true }).fill("weakpass");
      await page.getByRole("button", { name: "修改密码", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "密码需" }).waitFor();
      assert.equal(
        calls.some((c) => c.path === "/api/auth/password"),
        false,
      );
      await page.getByLabel("新密码", { exact: true }).fill("NewFixtureOnly!3");
      await page
        .getByLabel("确认新密码", { exact: true })
        .fill("NewFixtureOnly!4");
      await page.getByRole("button", { name: "修改密码", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "不一致" }).waitFor();
      await page
        .getByLabel("确认新密码", { exact: true })
        .fill("NewFixtureOnly!3");
      await page.getByRole("button", { name: "修改密码", exact: true }).click();
      await page
        .getByText("请先登录管理员账号。管理权限由服务器验证。", {
          exact: true,
        })
        .waitFor();
      assert.deepEqual(
        calls.find((c) => c.path === "/api/auth/password")?.body,
        { currentPassword: "FixtureOnly!2", password: "NewFixtureOnly!3" },
      );
      signedOut = false;
      await visit();
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page
        .getByText("请先登录管理员账号。管理权限由服务器验证。", {
          exact: true,
        })
        .waitFor();
      assert.ok(
        calls.some((c) => c.path === "/api/auth/logout" && c.method === "POST"),
      );
      assert.equal(
        calls.some((c) => c.path.startsWith("/api/admin/services")),
        false,
        "no service collection requests in any panel",
      );
      await page.goto(`${server.resolvedUrls!.local[0]}admin-fixture?legacy`);
      await page
        .getByRole("heading", { name: "账号管理", exact: true })
        .waitFor();
      await page.getByText("fixture-audit-198", { exact: true }).waitFor();
      assert.equal(
        await page.locator(".account-admin-user").count(),
        121,
        "nonembedded AdminTools retains the full legacy account list",
      );
      assert.equal(
        await page.locator(".account-audit tbody tr").count(),
        200,
        "legacy audit remains included by default",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
