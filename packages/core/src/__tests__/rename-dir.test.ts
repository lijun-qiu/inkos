import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameMock = vi.fn();
const cpMock = vi.fn();
const rmMock = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => renameMock(...args),
    cp: (...args: Parameters<typeof actual.cp>) => cpMock(...args),
    rm: (...args: Parameters<typeof actual.rm>) => rmMock(...args),
  };
});

describe("renameDirectoryReliable", () => {
  const roots: string[] = [];
  let actual: typeof import("node:fs/promises");
  let renameDirectoryReliable: typeof import("../utils/rename-dir.js").renameDirectoryReliable;

  beforeEach(async () => {
    vi.resetModules();
    actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    renameMock.mockReset();
    cpMock.mockReset();
    rmMock.mockReset();
    renameMock.mockImplementation(actual.rename);
    cpMock.mockImplementation(actual.cp);
    rmMock.mockImplementation(actual.rm);
    ({ renameDirectoryReliable } = await import("../utils/rename-dir.js"));
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await actual.mkdtemp(join(tmpdir(), "inkos-rename-dir-"));
    roots.push(root);
    return root;
  }

  it("renames a directory on the first attempt", async () => {
    const root = await tempRoot();
    const from = join(root, "staging");
    const to = join(root, "final");
    await actual.mkdir(from, { recursive: true });
    await actual.writeFile(join(from, "book.json"), "{\"ok\":true}\n", "utf-8");

    await renameDirectoryReliable(from, to);

    await expect(actual.readFile(join(to, "book.json"), "utf-8")).resolves.toContain("\"ok\":true");
    await expect(actual.stat(from)).rejects.toThrow();
    expect(cpMock).not.toHaveBeenCalled();
  });

  it("retries EPERM then succeeds", async () => {
    const root = await tempRoot();
    const from = join(root, "staging");
    const to = join(root, "final");
    await actual.mkdir(from, { recursive: true });
    await actual.writeFile(join(from, "a.txt"), "hello\n", "utf-8");

    renameMock
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
      .mockImplementationOnce(actual.rename);

    await renameDirectoryReliable(from, to, { retries: 3 });

    expect(renameMock).toHaveBeenCalledTimes(2);
    await expect(actual.readFile(join(to, "a.txt"), "utf-8")).resolves.toBe("hello\n");
    expect(cpMock).not.toHaveBeenCalled();
  });

  it("falls back to copy+rm when rename stays locked", async () => {
    const root = await tempRoot();
    const from = join(root, "staging");
    const to = join(root, "final");
    await actual.mkdir(from, { recursive: true });
    await actual.writeFile(join(from, "a.txt"), "payload\n", "utf-8");

    renameMock.mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));

    await renameDirectoryReliable(from, to, { retries: 2 });

    expect(cpMock).toHaveBeenCalled();
    await expect(actual.readFile(join(to, "a.txt"), "utf-8")).resolves.toBe("payload\n");
    await expect(actual.stat(from)).rejects.toThrow();
  });
});
