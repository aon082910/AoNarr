import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ApiKeyGate from "./ApiKeyGate.js";
import { getSessionToken, setSessionToken } from "../api/client.js";
import { mockApi } from "../test/mockApi.js";

const signedIn = {
  "/api/auth/me": { isAdmin: true },
  "/api/media-analysis/progress": { running: false, done: 0, failed: 0, total: 0 },
};

describe("ApiKeyGate", () => {
  it("shows the admin sign-in form when an instance is already set up", async () => {
    mockApi({ "/api/auth/setup-status": { needsSetup: false } });
    render(<ApiKeyGate>app</ApiKeyGate>);

    expect(await screen.findByText("Sign in with your admin account.")).toBeInTheDocument();
    expect(screen.queryByText("app")).not.toBeInTheDocument();
  });

  it("walks a fresh instance through creating the admin account", async () => {
    const fetchMock = mockApi({
      "/api/auth/setup-status": { needsSetup: true },
      "/api/auth/setup": { token: "new-session" },
      ...signedIn,
    });
    const user = userEvent.setup();
    render(<ApiKeyGate>app shell</ApiKeyGate>);

    await user.type(await screen.findByLabelText("Username"), "joseph");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(await screen.findByText("app shell")).toBeInTheDocument();
    expect(getSessionToken()).toBe("new-session");
    const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/auth/setup");
    expect(JSON.parse(setupCall![1]!.body as string)).toEqual({ username: "joseph", password: "correct-horse" });
  });

  it("rejects mismatched setup passwords without calling the server", async () => {
    const fetchMock = mockApi({ "/api/auth/setup-status": { needsSetup: true } });
    const user = userEvent.setup();
    render(<ApiKeyGate>app</ApiKeyGate>);

    await user.type(await screen.findByLabelText("Username"), "joseph");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.type(screen.getByLabelText("Confirm password"), "battery-staple");
    await user.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(screen.getByText("Passwords don't match")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/auth/setup")).toBe(false);
  });

  it("keeps the form and shows the server's message on a wrong password", async () => {
    mockApi({
      "/api/auth/setup-status": { needsSetup: false },
      "/api/auth/login": () => new Response(JSON.stringify({ error: "Invalid username or password" }), { status: 401 }),
    });
    const user = userEvent.setup();
    render(<ApiKeyGate>app</ApiKeyGate>);

    await user.type(await screen.findByLabelText("Username"), "joseph");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("joseph");
  });

  it("asks for a TOTP code when the account has two-factor enabled", async () => {
    mockApi({
      "/api/auth/setup-status": { needsSetup: false },
      "/api/auth/login": { totpRequired: true, pendingToken: "pending" },
      "/api/auth/login/totp": { token: "totp-session" },
      ...signedIn,
    });
    const user = userEvent.setup();
    render(<ApiKeyGate>app shell</ApiKeyGate>);

    await user.type(await screen.findByLabelText("Username"), "joseph");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("app shell")).toBeInTheDocument();
    expect(getSessionToken()).toBe("totp-session");
  });

  it("skips the gate entirely when a session is already stored", async () => {
    setSessionToken("existing");
    mockApi(signedIn);
    render(<ApiKeyGate>app shell</ApiKeyGate>);

    expect(await screen.findByText("app shell")).toBeInTheDocument();
  });
});
