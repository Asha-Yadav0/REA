import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const protocolsOf = (source: string) =>
  analyzeJavaScriptStaticSource(source).electron.protocols;

const literal = (value: string) => ({
  status: "literal",
  value,
  expression: null,
});

describe("Electron custom protocol registrations", () => {
  it("records OS registration, privileged schemes, handlers and interceptors", () => {
    const protocols = protocolsOf(`
      const { app, protocol, session } = require("electron");
      app.setAsDefaultProtocolClient("myapp");
      protocol.registerSchemesAsPrivileged([
        { scheme: "app", privileges: { standard: true, secure: true, bypassCSP: false } },
        { scheme: "media", privileges: { stream: true } },
      ]);
      protocol.handle("app", (request) => fetch(request.url));
      session.defaultSession.protocol.registerFileProtocol("media", serve);
      protocol.interceptHttpProtocol("https", rewrite);
    `);
    expect(protocols).toMatchObject([
      {
        api: "setAsDefaultProtocolClient",
        role: "os-default-client",
        scheme: literal("myapp"),
        session: "default-protocol",
        enabled_privileges: null,
      },
      {
        api: "registerSchemesAsPrivileged",
        role: "privileged-scheme",
        scheme: literal("app"),
        enabled_privileges: ["secure", "standard"],
      },
      {
        api: "registerSchemesAsPrivileged",
        role: "privileged-scheme",
        scheme: literal("media"),
        enabled_privileges: ["stream"],
      },
      { api: "handle", role: "handler", scheme: literal("app") },
      {
        api: "registerFileProtocol",
        role: "handler",
        scheme: literal("media"),
        session: "default-session",
      },
      {
        api: "interceptHttpProtocol",
        role: "interceptor",
        scheme: literal("https"),
      },
    ]);
  });

  it("follows Electron identity through namespace and alias forms", () => {
    expect(
      protocolsOf(`
        const electron = require("electron");
        const desktop = electron.app;
        desktop.setAsDefaultProtocolClient("notes");
      `),
    ).toMatchObject([{ scheme: literal("notes") }]);
  });

  it("keeps non-literal schemes and privileges as unknown values", () => {
    const protocols = protocolsOf(`
      const { app, protocol } = require("electron");
      app.setAsDefaultProtocolClient(config.scheme);
      protocol.registerSchemesAsPrivileged([{ scheme: name, privileges: options }]);
      protocol.registerSchemesAsPrivileged(schemes);
    `);
    expect(protocols).toMatchObject([
      {
        role: "os-default-client",
        scheme: { status: "dynamic", expression: "config.scheme" },
      },
      {
        role: "privileged-scheme",
        scheme: { status: "dynamic", expression: "name" },
        enabled_privileges: null,
      },
      {
        role: "privileged-scheme",
        scheme: { status: "dynamic", expression: "schemes" },
        enabled_privileges: null,
      },
    ]);
  });

  it("keeps one finding per entry when entries are not object literals", () => {
    expect(
      protocolsOf(`
        const { protocol } = require("electron");
        protocol.registerSchemesAsPrivileged([firstScheme, secondScheme]);
      `),
    ).toMatchObject([
      { scheme: { status: "dynamic", expression: "firstScheme" } },
      { scheme: { status: "dynamic", expression: "secondScheme" } },
    ]);
  });

  it("uses the last value of a repeated privilege key", () => {
    expect(
      protocolsOf(`
        const { protocol } = require("electron");
        protocol.registerSchemesAsPrivileged([{
          scheme: "app",
          privileges: { secure: true, standard: true, secure: false, standard: true },
        }]);
      `),
    ).toMatchObject([{ enabled_privileges: ["standard"] }]);
  });

  it.each([
    [
      "a local object named protocol",
      'const protocol = { handle() {} }; protocol.handle("app", h);',
    ],
    [
      "a query rather than a registration",
      'const { protocol } = require("electron"); protocol.isProtocolHandled("app");',
    ],
    [
      "a removal",
      'const { app } = require("electron"); app.removeAsDefaultProtocolClient("app");',
    ],
    [
      "a non-default session",
      'const { session } = require("electron"); session.fromPartition("p").protocol.handle("app", h);',
    ],
  ])("ignores %s", (_name, source) => {
    expect(protocolsOf(source)).toEqual([]);
  });
});

describe("Electron protocol registrations in TypeScript sources", () => {
  it("reads TypeScript-asserted lists, entries and privileges", () => {
    expect(
      protocolsOf(`
        const { protocol } = require("electron");
        protocol.registerSchemesAsPrivileged([
          { scheme: "a", privileges: { secure: true } as const },
          { scheme: "b" } satisfies Entry,
        ] as const);
      `),
    ).toMatchObject([
      { scheme: literal("a"), enabled_privileges: ["secure"] },
      { scheme: literal("b"), enabled_privileges: [] },
    ]);
  });

  it("reads TypeScript-asserted schemes and privilege values", () => {
    expect(
      protocolsOf(`
        const { app, protocol } = require("electron");
        app.setAsDefaultProtocolClient("notes" as const);
        protocol.registerSchemesAsPrivileged([
          {
            scheme: "app" as const,
            privileges: { secure: true as const, standard: true satisfies boolean, stream: false as const },
          },
        ]);
      `),
    ).toMatchObject([
      { role: "os-default-client", scheme: literal("notes") },
      { scheme: literal("app"), enabled_privileges: ["secure", "standard"] },
    ]);
  });
});
